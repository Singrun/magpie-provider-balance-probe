/**
 * Magpie 提供商余额配置核心模块
 * 负责扫描 providers.json，使用排他文件锁、按 Provider 合并式冲突处理、原子替换与 0600 权限安全修补 Magpie 原生余额参数
 */

import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"
import { probe, extractBaseURL, readLimitedText, createRequestSignal } from "./detector.js"

// Magpie 官方已内置专用探测逻辑的知名供应商 (官方硬编码支持，无需修补 BalanceURL)
const BUILTIN_KNOWN_HOSTS = new Set([
  "api.deepseek.com",
  "api.moonshot.cn",
  "api.moonshot.ai",
  "openrouter.ai",
  "api.siliconflow.cn",
  "api.siliconflow.com",
  "api.stepfun.com",
  "api.stepfun.ai",
  "api.commandcode.ai",
  "ollama.com",
  "aihubmix.com",
])

function isThirdPartyProvider(provider) {
  if (!provider || typeof provider.key !== "string") return false
  const key = provider.key.trim()
  if (!key || key.startsWith("YOUR_") || key === "sk-...") return false
  const base = extractBaseURL(provider)
  if (!base) return false
  try {
    return !BUILTIN_KNOWN_HOSTS.has(new URL(base.origin).hostname.toLowerCase())
  } catch {
    return false
  }
}

export function getMagpieProvidersPath(customDir) {
  if (customDir) {
    return path.join(customDir, "providers.json")
  }
  const xdg = process.env.XDG_CONFIG_HOME
  if (xdg) {
    return path.join(xdg, "magpie", "providers.json")
  }
  return path.join(os.homedir(), ".config", "magpie", "providers.json")
}

async function unlinkLockIfUnchanged(lockPath, observedStat) {
  const currentStat = await fs.stat(lockPath).catch(() => null)
  if (!currentStat || currentStat.dev !== observedStat.dev || currentStat.ino !== observedStat.ino) {
    return false
  }
  await fs.unlink(lockPath).catch(() => {})
  return true
}

/**
 * 获取跨进程独占文件锁 (防止多个工具进程并发读写冲突)
 * 仅当锁足够旧且其记录的进程已退出时回收，避免误删慢速运行中的锁。
 */
export async function acquireFileLock(filePath, timeoutMs = 8000) {
  const lockPath = `${filePath}.lock`
  const start = Date.now()
  const pid = process.pid

  while (Date.now() - start < timeoutMs) {
    try {
      const handle = await fs.open(lockPath, "wx")
      await handle.writeFile(JSON.stringify({ pid, time: Date.now() }), "utf-8")
      await handle.close()
      return async () => {
        try { await fs.unlink(lockPath) } catch (_) {}
      }
    } catch (err) {
      if (err.code === "EEXIST") {
        // 只回收足够老且持有进程已退出的锁；不按固定租期抢占有效锁。
        try {
          const [content, stat] = await Promise.all([
            fs.readFile(lockPath, "utf-8"),
            fs.stat(lockPath),
          ])
          const info = JSON.parse(content)
          const oldEnough = Date.now() - Math.max(Number(info.time) || 0, stat.mtimeMs) > 60000
          let ownerExited = false
          if (Number.isInteger(info.pid) && info.pid > 0 && oldEnough) {
            try {
              process.kill(info.pid, 0)
            } catch (processError) {
              ownerExited = processError.code === "ESRCH"
            }
          }
          if (oldEnough && ownerExited) {
            if (await unlinkLockIfUnchanged(lockPath, stat)) continue
          }
        } catch {
          // A newly created lock may briefly be empty while its owner writes metadata.
          const stat = await fs.stat(lockPath).catch(() => null)
          if (stat && Date.now() - stat.mtimeMs > 5 * 60 * 1000) {
            if (await unlinkLockIfUnchanged(lockPath, stat)) continue
          }
        }
        await new Promise(r => setTimeout(r, 100))
      } else {
        throw err
      }
    }
  }
  throw new Error(`无法获取 providers.json 文件锁，等待已超时 ${timeoutMs}ms`)
}

const MAGPIE_BALANCE_PLACEHOLDER =
  /\$?\{\{?\s*(?:key|api[_-]?key|token)\s*\}?\}/gi

function replaceBalancePlaceholder(value, replacement) {
  return value.replace(MAGPIE_BALANCE_PLACEHOLDER, () => replacement)
}

function queryEscape(value) {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, "+")
}

function balanceAuthorization(token) {
  if (token.includes(" ")) return token
  if (token.startsWith("eyJ") && token.split(".").length === 3) {
    return `Bearer ${token}`
  }
  return token
}

/**
 * 完整复现 Magpie 的余额请求构造语义 (对齐 Magpie withBalanceKey 与 BalanceToken/Headers 规范)
 */
export function buildBalanceRequest(provider) {
  if (!provider || !provider.balanceURL || typeof provider.balanceURL !== "string" || !provider.balanceURL.trim()) {
    return null
  }

  const key = (provider.key || "").trim()
  const token = (provider.balanceToken || "").trim()
  let url = provider.balanceURL.trim()
  // Magpie uses the provider key for every balance URL placeholder.
  url = replaceBalancePlaceholder(url, queryEscape(key))

  const headers = {
    Accept: "application/json",
  }

  // 处理自定义请求头及其中的模板占位符
  if (provider.headers && typeof provider.headers === "object") {
    for (const [hk, hv] of Object.entries(provider.headers)) {
      if (typeof hv === "string") {
        headers[hk] = replaceBalancePlaceholder(hv, key)
      } else if (hv != null) {
        headers[hk] = String(hv)
      }
    }
  }

  if (token) {
    // Magpie's explicit BalanceToken takes precedence over custom Authorization.
    headers.Authorization = balanceAuthorization(token)
  } else if (key) {
    const hasAuthHeader = Object.keys(headers).some(k => k.toLowerCase() === "authorization")
    if (!hasAuthHeader) {
      headers.Authorization = `Bearer ${key}`
    }
  }

  return {
    url,
    method: (provider.balanceMethod || "GET").toUpperCase(),
    headers,
  }
}

function resolveBalanceExpression(data, expression) {
  const readPath = rawPath => {
    const segments = rawPath.trim().replace(/^\$\.?/, "").split(".").filter(Boolean)
    let value = data
    for (const segment of segments) {
      if (value == null || typeof value !== "object" || !(segment in value)) return undefined
      value = value[segment]
    }
    return value
  }
  const match = expression.match(/^\s*(\$?[A-Za-z0-9_$.]+)\s*(?:([/+*-])\s*([0-9]+(?:\.[0-9]+)?|\$?[A-Za-z0-9_$.]+))?\s*$/)
  if (!match) return undefined
  const left = readPath(match[1])
  if (!match[2]) return left
  const rightToken = match[3]
  const right = /^[0-9]/.test(rightToken) ? Number(rightToken) : readPath(rightToken)
  if (typeof left !== "number" || typeof right !== "number") return undefined
  switch (match[2]) {
    case "/": return right === 0 ? undefined : left / right
    case "*": return left * right
    case "+": return left + right
    case "-": return left - right
    default: return undefined
  }
}

function numericBalance(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value)
  }
  return undefined
}

/**
 * 校验供应商现有 BalanceURL 的健康状态
 */
export async function checkBalanceHealth(provider, fetchFn = fetch, signal) {
  const req = buildBalanceRequest(provider)
  if (!req) {
    return { healthy: false, reason: "未配置有效 Balance URL" }
  }

  const request = createRequestSignal(signal, 3500)
  try {
    const res = await fetchFn(req.url, {
      method: req.method,
      headers: req.headers,
      signal: request.signal,
      redirect: "error",
    })

    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      return { healthy: false, reason: `端点响应异常 HTTP ${res.status}` }
    }

    const text = await readLimitedText(res)
    if (!text || !text.trim().startsWith("{")) {
      return { healthy: false, reason: "返回非 JSON 响应" }
    }

    const data = JSON.parse(text)
    const path = String(provider.balancePath || "").trim()
    if (!path) {
      return { healthy: false, reason: "未配置有效 BalancePath" }
    }
    const value = resolveBalanceExpression(data, path)
    const validNumericValue = numericBalance(value) !== undefined
    if (!validNumericValue) {
      return { healthy: false, reason: "BalancePath 未解析为数值或字符串" }
    }

    return { healthy: true, balance: numericBalance(value) }
  } catch (err) {
    return { healthy: false, reason: `连接失败: ${err?.message || err}` }
  } finally {
    request.cleanup()
  }
}

/**
 * 判断某个已添加的提供商是否需要配置或修复余额端点
 * 严格收敛判断范围：仅在无 BalanceURL、显式 force、或现有端点失效时触发
 * 自定义 Token/Header 的认证语义无法由通用探针可靠复现，因此始终跳过自动探测。
 */
export async function shouldConfigureProvider(
  p,
  force = false,
  fetchFn = fetch,
  signal,
  existingHealth,
) {
  if (!isThirdPartyProvider(p)) return false

  // 探针只支持 Magpie 默认 API Key 鉴权；自定义认证交由用户手工配置。
  const hasCustomAuth = Boolean(p.balanceToken || (p.headers && Object.keys(p.headers).length > 0))
  if (hasCustomAuth) return false

  // 没有配置 BalanceURL
  if (!p.balanceURL || typeof p.balanceURL !== "string" || !p.balanceURL.trim()) {
    return true
  }

  if (force) return true

  const health = existingHealth || await checkBalanceHealth(p, fetchFn, signal)
  return !health.healthy
}

/**
 * 扫描并修复所有第三方中转供应商的 Magpie 原生余额配置
 * 采用排他文件锁、按 Provider 合并式冲突检测、原子替换与 0600 安全权限
 */
export async function autoConfigureProviders(options = {}) {
  const {
    customDir,
    force = false,
    dryRun = false,
    fetchFn = fetch,
    signal,
  } = options
  const filePath = getMagpieProvidersPath(customDir)

  let content
  try {
    content = await fs.readFile(filePath, "utf-8")
  } catch (err) {
    return {
      success: false,
      error: `无法读取 Magpie 配置文件: ${filePath} (${err.message})`,
      results: [],
    }
  }

  let data
  try {
    data = JSON.parse(content)
  } catch (err) {
    return {
      success: false,
      error: `Magpie 配置文件 JSON 格式错误: ${err.message}`,
      results: [],
    }
  }

  if (!Array.isArray(data.providers)) {
    return {
      success: false,
      error: "配置文件中未找到有效的 providers 数组",
      results: [],
    }
  }

  // 探测前记录所有 Provider 的原始快照摘要，用于后续合并式冲突检测
  const baselineSnapshots = new Map(
    data.providers
      .filter(p => p && typeof p.id === "string" && p.id)
      .map(p => [p.id, JSON.stringify(p)])
  )
  const duplicateIds = new Set()
  const seenIds = new Set()
  for (const provider of data.providers) {
    if (typeof provider?.id !== "string" || !provider.id) continue
    if (seenIds.has(provider.id)) duplicateIds.add(provider.id)
    seenIds.add(provider.id)
  }
  const plannedUpdates = new Map()
  const results = []

  // 并发池探测，限制并发数为 6
  const queue = [...data.providers]
  const CONCURRENCY = 6

  const worker = async () => {
    while (queue.length > 0) {
      const provider = queue.shift()
      if (!provider || typeof provider !== "object" || Array.isArray(provider)) continue
      if (typeof provider.id !== "string" || !provider.id) continue
      if (!isThirdPartyProvider(provider)) continue
      if (duplicateIds.has(provider.id)) {
        results.push({
          id: provider.id,
          name: provider.name || provider.id,
          status: "conflicted",
          reason: "providers.json 中 Provider ID 重复，无法安全确定写回目标",
        })
        continue
      }
      if (signal?.aborted) break

      const needsConfig = await shouldConfigureProvider(
        provider,
        force,
        fetchFn,
        signal,
      )
      const providerName = provider.name || provider.id

      if (!needsConfig) {
        continue
      }

      const probeRes = await probe(provider, fetchFn, signal)

      if (probeRes.detected) {
        const oldConfig = {
          balanceURL: provider.balanceURL || null,
          balancePath: provider.balancePath || null,
          balanceMethod: provider.balanceMethod || null,
        }

        plannedUpdates.set(provider.id, {
          name: providerName,
          balanceURL: probeRes.balanceURL,
          balancePath: probeRes.balancePath,
          balanceMethod: probeRes.balanceMethod || "GET",
          platform: probeRes.platform,
          oldConfig,
          changed:
            (provider.balanceURL || null) !== probeRes.balanceURL ||
            (provider.balancePath || null) !== probeRes.balancePath ||
            (provider.balanceMethod || "GET") !== (probeRes.balanceMethod || "GET"),
        })
      } else {
        results.push({
          id: provider.id,
          name: providerName,
          status: "unsupported",
          reason: probeRes.reason,
        })
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, data.providers.length) }, () => worker())
  )

  if (signal?.aborted) {
    return {
      success: false,
      cancelled: true,
      error: "余额配置任务已取消，未写入 providers.json",
      filePath,
      results,
    }
  }

  // 如果是在预检模式 (dryRun)
  if (dryRun) {
    for (const [id, update] of plannedUpdates) {
      results.push({
        id,
        name: update.name,
        status: update.changed
          ? (update.oldConfig.balanceURL ? "repaired" : "configured")
          : "unchanged",
        platform: update.platform,
        balanceURL: update.balanceURL,
        balancePath: update.balancePath,
        oldConfig: update.oldConfig,
      })
    }
    return {
      success: true,
      filePath,
      hasChanges: [...plannedUpdates.values()].some(update => update.changed),
      dryRun: true,
      results,
    }
  }

  // 准备写回：若没有探测出任何有效更新，直接返回
  if (plannedUpdates.size === 0) {
    return {
      success: true,
      filePath,
      hasChanges: false,
      dryRun: false,
      results,
    }
  }

  // 获得独占文件锁，执行合并式冲突检测与原子写入
  let releaseLock = null
  let tmpPath = null
  let hasActualChanges = false

  try {
    releaseLock = await acquireFileLock(filePath)

    // 重新读取磁盘上最新的 providers.json
    const latestRaw = await fs.readFile(filePath, "utf-8")
    const latestData = JSON.parse(latestRaw)

    if (!Array.isArray(latestData.providers)) {
      throw new Error("最新配置文件中 providers 数组失效")
    }

    for (const provider of latestData.providers) {
      if (!plannedUpdates.has(provider.id)) continue

      const update = plannedUpdates.get(provider.id)
      const originalSnapshot = baselineSnapshots.get(provider.id)
      const currentSnapshot = JSON.stringify(provider)

      // 合并式冲突检测：如果该 Provider 在探测期间被外部修改，跳过自动改写
      if (originalSnapshot !== currentSnapshot) {
        results.push({
          id: provider.id,
          name: provider.name || provider.id,
          status: "conflicted",
          reason: "探测期间该 Provider 被外部并发修改，为防数据丢失已跳过自动改写",
        })
        continue
      }

      // 仅在新配置确实不同于现有配置时应用改写
      const isDifferent =
        provider.balanceURL !== update.balanceURL ||
        provider.balancePath !== update.balancePath ||
        (provider.balanceMethod || "GET") !== update.balanceMethod

      if (isDifferent) {
        provider.balanceURL = update.balanceURL
        provider.balancePath = update.balancePath
        provider.balanceMethod = update.balanceMethod
        hasActualChanges = true

        results.push({
          id: provider.id,
          name: provider.name || provider.id,
          status: update.oldConfig.balanceURL ? "repaired" : "configured",
          platform: update.platform,
          balanceURL: update.balanceURL,
          balancePath: update.balancePath,
          oldConfig: update.oldConfig,
        })
      } else {
        results.push({
          id: provider.id,
          name: provider.name || provider.id,
          status: "unchanged",
          reason: "现有配置已是最优状态，无需重复写入",
          balanceURL: update.balanceURL,
        })
      }
    }

    // 只有在真正发生有意义改动时才写回文件
    if (hasActualChanges) {
      // 1. 创建 0600 安全权限备份
      await fs.writeFile(`${filePath}.bak`, latestRaw, { mode: 0o600 })
      await fs.chmod(`${filePath}.bak`, 0o600).catch(() => {})

      // 2. 写入临时文件、fsync 刷盘与原子重命名替换
      tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`
      const fileHandle = await fs.open(tmpPath, "w", 0o600)
      await fileHandle.writeFile(JSON.stringify(latestData, null, 2), "utf-8")
      await fileHandle.sync()
      await fileHandle.close()

      await fs.chmod(tmpPath, 0o600).catch(() => {})
      await fs.rename(tmpPath, filePath)
      tmpPath = null // 重命名成功后置空
    }
  } catch (err) {
    if (tmpPath) {
      await fs.unlink(tmpPath).catch(() => {})
    }
    return {
      success: false,
      error: `原子更新 providers.json 失败: ${err.message}`,
      results,
    }
  } finally {
    if (releaseLock) await releaseLock()
  }

  return {
    success: true,
    filePath,
    hasChanges: hasActualChanges,
    dryRun: false,
    results,
  }
}

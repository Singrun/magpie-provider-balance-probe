/**
 * 第三方中转平台余额探针
 * 仅识别 Sub2API、New-API / One-API 与 LiteLLM 的专用配额接口。
 * 并生成 Magpie 原生支持的 BalanceURL / BalancePath / BalanceMethod 配置
 */

import { getCachedProbe, setCachedProbe, fingerprint } from "./cache.js"

const PROBE_TIMEOUT_MS = 3500
const MAX_RESPONSE_BYTES = 64 * 1024

export function createRequestSignal(parentSignal, timeoutMs) {
  const controller = new AbortController()
  const abortFromParent = () => controller.abort(parentSignal?.reason)
  if (parentSignal?.aborted) {
    abortFromParent()
  } else {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true })
  }
  const timer = setTimeout(() => controller.abort(new Error("request_timeout")), timeoutMs)
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer)
      parentSignal?.removeEventListener("abort", abortFromParent)
    },
  }
}

export async function readLimitedText(response) {
  const declaredLength = Number(response.headers?.get?.("content-length"))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error("response_too_large")
  }
  if (!response.body?.getReader) {
    const text = await response.text()
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
      throw new Error("response_too_large")
    }
    return text
  }

  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new Error("response_too_large")
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

/**
 * 发起带超时保护的 GET 探测请求并解析 JSON
 */
async function probeGet(url, headers = {}, fetchFn = fetch, parentSignal) {
  const request = createRequestSignal(parentSignal, PROBE_TIMEOUT_MS)
  try {
    const res = await fetchFn(url, {
      method: "GET",
      redirect: "error",
      headers: {
        Accept: "application/json",
        ...headers,
      },
      signal: request.signal,
    })

    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      return { ok: false, status: res.status }
    }
    const text = await readLimitedText(res)
    if (!text || !text.trim().startsWith("{")) {
      return { ok: false, status: res.status, error: "not_json" }
    }
    return { ok: true, status: res.status, data: JSON.parse(text) }
  } catch (err) {
    return { ok: false, error: err?.message || String(err) }
  } finally {
    request.cleanup()
  }
}

/**
 * 提取提供商的 BaseURL，完整保留自定义前缀（如 /custom/v1）
 */
export function extractBaseURL(provider) {
  if (!provider || typeof provider !== "object") return null
  const urlStr = provider.baseURL || provider.chat || provider.anthropic || provider.responses || provider.gemini || provider.api
  if (!urlStr || typeof urlStr !== "string") return null
  try {
    const u = new URL(urlStr.trim())
    let clean = `${u.origin}${u.pathname}`.replace(/\/+$/, "")
    // 移除末尾的具体聊天/模型端点后缀，保留前置自定义路由
    clean = clean.replace(/\/(chat\/completions|messages|responses|completions)$/, "")
    return {
      raw: urlStr.trim(),
      origin: u.origin,
      cleanBase: clean,
      pathname: u.pathname.replace(/\/+$/, ""),
    }
  } catch {
    return null
  }
}

/**
 * 核心探针方法：对单个 Provider 执行平台指纹探测
 * 返回 Magpie 原生字段配置：{ detected, platform, balanceURL, balancePath, balanceMethod, sampleBalance }
 */
export async function probe(provider, fetchFn = fetch, signal) {
  if (!provider || typeof provider !== "object") {
    return { detected: false, reason: "Provider 配置无效" }
  }
  const key = provider.key
  if (!key) {
    return { detected: false, reason: "没有配置 API Key" }
  }

  const base = extractBaseURL(provider)
  if (!base) {
    return { detected: false, reason: "没有有效的 Base URL" }
  }

  // 1. 检查 TTL 缓存，使用 SHA-256 指纹避免跨账号碰撞与重复请求
  const cacheKey = `probe:${base.cleanBase}:${fingerprint(key)}`
  const cached = getCachedProbe(cacheKey)
  if (cached) return cached

  const { origin, cleanBase } = base
  const authHeader = { Authorization: `Bearer ${key.trim()}` }
  let sawUnsupportedUnlimited = false

  // --------------------------------------------------------------------------
  // 探针 1：Sub2API (Wei-Shaw/sub2api)
  // 必须优先使用 cleanBase（保持自定义路径），其次回退至 origin
  // --------------------------------------------------------------------------
  const sub2apiUrls = []
  sub2apiUrls.push(`${cleanBase}/usage`)
  if (!cleanBase.endsWith("/v1")) {
    sub2apiUrls.push(`${cleanBase}/v1/usage`)
  }
  if (!sub2apiUrls.includes(`${origin}/v1/usage`)) {
    sub2apiUrls.push(`${origin}/v1/usage`)
  }

  for (const url of sub2apiUrls) {
    if (signal?.aborted) return { detected: false, reason: "探测已取消" }
    const res = await probeGet(url, authHeader, fetchFn, signal)
    if (res.ok && res.data) {
      const d = res.data
      const isSub2API =
        d.mode === "quota_limited" ||
        d.mode === "unrestricted" ||
        Array.isArray(d.rate_limits)

      if (isSub2API) {
        const remaining = typeof d.remaining === "number"
          ? d.remaining
          : typeof d.remaining === "string" && d.remaining.trim()
            ? Number(d.remaining)
            : Number.NaN
        if (!Number.isFinite(remaining)) continue
        let sampleBalance = ""
        sampleBalance = `$${remaining.toFixed(2)}`

        const out = {
          detected: true,
          platform: "Sub2API",
          balanceURL: url, // 严格保留命中的实际 URL (含自定义前缀)
          balancePath: "$remaining",
          balanceMethod: "GET",
          sampleBalance,
        }
        setCachedProbe(cacheKey, out)
        return out
      }
    }
  }

  // --------------------------------------------------------------------------
  // 探针 2：New-API / One-API (Calcium-Ion/new-api, songquanpeng/one-api)
  // 换算：500,000 quota = 1 USD
  // --------------------------------------------------------------------------
  const baseWithoutV1 = cleanBase.endsWith("/v1") ? cleanBase.slice(0, -3) : cleanBase
  const newapiUrls = []
  newapiUrls.push(`${baseWithoutV1}/api/usage/token`)
  if (!newapiUrls.includes(`${origin}/api/usage/token`)) {
    newapiUrls.push(`${origin}/api/usage/token`)
  }

  for (const url of newapiUrls) {
    if (signal?.aborted) return { detected: false, reason: "探测已取消" }
    const newapiRes = await probeGet(url, authHeader, fetchFn, signal)
    if (newapiRes.ok && newapiRes.data) {
      const wrappedData = newapiRes.data.data && typeof newapiRes.data.data === "object"
      const d = wrappedData ? newapiRes.data.data : newapiRes.data
      const balancePath = wrappedData
        ? "$data.total_available / 500000"
        : "$total_available / 500000"
      const isNewAPI =
        typeof d.total_available !== "undefined" ||
        d.object === "token_usage" ||
        typeof d.unlimited_quota === "boolean"

      if (isNewAPI) {
        const isUnlimited = Boolean(d.unlimited_quota)
        const rawQuota = d.total_available
        const numericQuota =
          typeof rawQuota === "number"
            ? rawQuota
            : typeof rawQuota === "string" && rawQuota.trim()
              ? Number(rawQuota)
              : Number.NaN
        const hasNumericQuota = Number.isFinite(numericQuota)

        if (isUnlimited && hasNumericQuota) {
          const sampleBalance = `$${(numericQuota / 500000).toFixed(2)}`
          const out = {
            detected: true,
            platform: "New-API / One-API",
            balanceURL: url,
            balancePath,
            balanceMethod: "GET",
            sampleBalance,
            unlimited: true,
          }
          setCachedProbe(cacheKey, out)
          return out
        }

        if (isUnlimited && !hasNumericQuota) {
          // This URL is recognizable but cannot feed Magpie's numeric path.
          // Continue probing in case another candidate exposes usable quota data.
          sawUnsupportedUnlimited = true
          continue
        }

        if (hasNumericQuota) {
          const sampleBalance = `$${(numericQuota / 500000).toFixed(2)}`
          const out = {
            detected: true,
            platform: "New-API / One-API",
            balanceURL: url,
            balancePath,
            balanceMethod: "GET",
            sampleBalance,
          }
          setCachedProbe(cacheKey, out)
          return out
        }
      }
    }
  }

  // --------------------------------------------------------------------------
  // 探针 4：LiteLLM Proxy (BerriAI/litellm)
  // 保存为 ?key={key}，Magpie 原生以 withBalanceKey 动态替换
  // --------------------------------------------------------------------------
  const litellmBases = []
  litellmBases.push(`${baseWithoutV1}/key/info`)
  if (!litellmBases.includes(`${origin}/key/info`)) {
    litellmBases.push(`${origin}/key/info`)
  }

  for (const infoBase of litellmBases) {
    if (signal?.aborted) return { detected: false, reason: "探测已取消" }
    const queryUrl = `${infoBase}?key=${encodeURIComponent(key.trim())}`
    const litellmRes = await probeGet(queryUrl, authHeader, fetchFn, signal)
    if (litellmRes.ok && litellmRes.data) {
      const info = litellmRes.data.info || litellmRes.data
      if (typeof info.max_budget === "number" && Number.isFinite(info.max_budget) &&
          typeof info.spend === "number" && Number.isFinite(info.spend)) {
        const remaining = Math.max(0, info.max_budget - info.spend)

        const out = {
          detected: true,
          platform: "LiteLLM Proxy",
          balanceURL: `${infoBase}?key={key}`,
          balancePath: "info.max_budget - info.spend",
          balanceMethod: "GET",
          sampleBalance: `$${remaining.toFixed(2)}`,
        }
        setCachedProbe(cacheKey, out)
        return out
      }
    }
  }

  const failResult = {
    detected: false,
    reason: sawUnsupportedUnlimited
      ? "已发现无限额度标记，但没有可供 Magpie 原生余额解析的数值字段；同时未命中其他可用配额接口"
      : "未能命中已知的专用配额接口 (已探测 Sub2API、New-API / One-API、LiteLLM)",
  }
  setCachedProbe(cacheKey, failResult, 60 * 1000)
  return failResult
}

// 兼容别名
export const detectProviderBalanceConfig = probe

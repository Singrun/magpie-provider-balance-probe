import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { fingerprint, setCachedProbe, getCachedProbe, clearCachedProbe, getCacheSize } from "../src/cache.js"
import { probe } from "../src/detector.js"
import {
  acquireFileLock,
  buildBalanceRequest,
  checkBalanceHealth,
  shouldConfigureProvider,
  autoConfigureProviders,
} from "../src/configurator.js"

describe("缓存安全性与防碰撞测试", () => {
  beforeEach(() => {
    clearCachedProbe()
  })

  test("相同后缀但不同 API Key 必须生成不同指纹，不共享缓存", async () => {
    const key1 = "sk-company-dev-12345678"
    const key2 = "sk-personal-pro-12345678" // 后缀 8 位完全相同

    expect(fingerprint(key1)).not.toBe(fingerprint(key2))

    const mockFetch = async (url, options) => {
      const auth = options.headers?.Authorization || ""
      if (auth.includes(key1)) {
        return new Response(JSON.stringify({ mode: "quota_limited", remaining: 1.0 }), { status: 200 })
      }
      if (auth.includes(key2)) {
        return new Response(JSON.stringify({ mode: "quota_limited", remaining: 2.0 }), { status: 200 })
      }
      return new Response("Unauthorized", { status: 401 })
    }

    const p1 = { id: "p1", chat: "https://api.relay.com/v1", key: key1 }
    const p2 = { id: "p2", chat: "https://api.relay.com/v1", key: key2 }

    const res1 = await probe(p1, mockFetch)
    expect(res1.detected).toBe(true)
    expect(res1.detected).toBe(true)

    const res2 = await probe(p2, mockFetch)
    expect(res2.detected).toBe(true)
    expect(res2.detected).toBe(true) // 绝不命中 key1 的缓存！
    expect(res1.balanceURL).toBe(res2.balanceURL)
  })

  test("缓存容量上限控制 (最大 256 条并按 FIFO 淘汰)", () => {
    clearCachedProbe()

    // 填充 256 个条目
    for (let i = 0; i < 256; i++) {
      setCachedProbe(`key-${i}`, { index: i })
    }
    expect(getCacheSize()).toBe(256)
    expect(getCachedProbe("key-0")).not.toBeNull()

    // 写入第 257 个条目，最早的 key-0 应被淘汰
    setCachedProbe("key-256", { index: 256 })
    expect(getCacheSize()).toBe(256)
    expect(getCachedProbe("key-0")).toBeNull()
    expect(getCachedProbe("key-256")).not.toBeNull()
  })
})

describe("无限额度原生余额路径容错测试", () => {
  beforeEach(() => {
    clearCachedProbe()
  })

  test("New-API 无限额度且有数值 quota 时，生成有效数字计算路径并标记 unlimited", async () => {
    const p = { id: "newapi-1", chat: "https://newapi.test/v1", key: "sk-test" }
    const mockFetch = async () =>
      new Response(
        JSON.stringify({
          data: {
            unlimited_quota: true,
            total_available: 5000000, // 5M quota = $10.00
          },
        }),
        { status: 200 }
      )

    const res = await probe(p, mockFetch)
    expect(res.detected).toBe(true)
    expect(res.balancePath).toBe("$data.total_available / 500000")
    expect(res.unlimited).toBe(true)
  })

  test("New-API 仅有布尔值 unlimited_quota 没有数值字段时，不写入非法路径", async () => {
    const p = { id: "newapi-2", chat: "https://newapi.test/v1", key: "sk-test" }
    const mockFetch = async () =>
      new Response(
        JSON.stringify({
          data: {
            unlimited_quota: true,
            // 没有任何 total_available 数值字段
          },
        }),
        { status: 200 }
      )

    const res = await probe(p, mockFetch)
    expect(res.detected).toBe(false)
    expect(res.reason).toContain("没有可供 Magpie 原生余额解析的数值字段")
  })
})

describe("Magpie 余额请求语义复现与自定义认证保护", () => {
  test("完整支持 balanceToken、自定义 Headers 以及 URL 与 Header 占位符替换", () => {
    const provider = {
      key: "sk-main-key",
      balanceToken: "custom-token-999",
      balanceURL: "https://api.service.com/v1/balance?token={token}&key={key}",
      balanceMethod: "POST",
      headers: {
        "X-Custom-Key": "{key}",
        "X-Token": "Bearer {token}",
      },
    }

    const req = buildBalanceRequest(provider)
    expect(req).not.toBeNull()
    expect(req.url).toBe("https://api.service.com/v1/balance?token=sk-main-key&key=sk-main-key")
    expect(req.method).toBe("POST")
    expect(req.headers["X-Custom-Key"]).toBe("sk-main-key")
    expect(req.headers["X-Token"]).toBe("Bearer sk-main-key")
    expect(req.headers["Authorization"]).toBe("custom-token-999")
  })

  test("占位符集合与 Magpie 原生实现一致，且 BalanceToken 覆盖自定义 Authorization", () => {
    const provider = {
      key: "key with/slash",
      balanceToken: "Basic abc123",
      balanceURL: "https://api.service.com/balance?key={api_key}&a={{key}}&b=${API_KEY}&c={token}",
      headers: {
        "X-Key": "{api-key}",
        Authorization: "Bearer should-be-replaced",
      },
    }

    const req = buildBalanceRequest(provider)
    expect(req.url).toBe(
      "https://api.service.com/balance?key=key+with%2Fslash&a=key+with%2Fslash&b=key+with%2Fslash&c=key+with%2Fslash"
    )
    expect(req.headers["X-Key"]).toBe("key with/slash")
    expect(req.headers.Authorization).toBe("Basic abc123")
  })

  test("JWT BalanceToken 按 Magpie 规则补 Bearer，普通 token 保持原样", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.payload.signature"
    expect(buildBalanceRequest({
      key: "sk-key",
      balanceToken: jwt,
      balanceURL: "https://api.service.com/balance",
    }).headers.Authorization).toBe(`Bearer ${jwt}`)

    expect(buildBalanceRequest({
      key: "sk-key",
      balanceToken: "access-token",
      balanceURL: "https://api.service.com/balance",
    }).headers.Authorization).toBe("access-token")
  })

  test("对使用自定义认证的 Provider，即使 force 也跳过通用探针", async () => {
    const p = {
      id: "custom-auth-provider",
      chat: "https://custom.com/v1",
      key: "sk-xxx",
      balanceURL: "https://custom.com/v1/usage",
      balanceToken: "special-token",
    }

    const mockFetch = async () => {
      throw new Error("自定义认证 Provider 不应触发通用探针")
    }
    const should = await shouldConfigureProvider(p, false, mockFetch)
    expect(should).toBe(false)
    const shouldForce = await shouldConfigureProvider(p, true, mockFetch)
    expect(shouldForce).toBe(false)

    const missingBalanceConfig = { ...p, id: "custom-auth-without-balance-url" }
    delete missingBalanceConfig.balanceURL
    expect(await shouldConfigureProvider(missingBalanceConfig, false, mockFetch)).toBe(false)
    expect(await shouldConfigureProvider(missingBalanceConfig, true, mockFetch)).toBe(false)
  })

  test("已有 BalanceURL 但缺少 BalancePath 时继续修复原生余额配置", async () => {
    const provider = {
      id: "missing-path",
      chat: "https://relay.test/v1",
      key: "sk-test",
      balanceURL: "https://relay.test/v1/usage",
    }
    const mockFetch = async () =>
      new Response(JSON.stringify({ remaining: 8 }), { status: 200 })

    const health = await checkBalanceHealth(provider, mockFetch)
    expect(health.healthy).toBe(false)
    expect(health.reason).toContain("BalancePath")
    expect(await shouldConfigureProvider(provider, false, mockFetch)).toBe(true)
  })
})

describe("文件排他锁与陈旧锁清理测试", () => {
  const tmpDir = path.join(os.tmpdir(), `magpie-test-lock-${Date.now()}`)

  beforeEach(async () => {
    await fs.mkdir(tmpDir, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  test("锁竞争：已有锁被持有时，并发获取锁应超时失败", async () => {
    const targetFile = path.join(tmpDir, "providers.json")
    await fs.writeFile(targetFile, JSON.stringify({ providers: [] }))

    const release1 = await acquireFileLock(targetFile, 1000)

    // 第二个尝试获取锁，设置短超时 200ms
    let failed = false
    try {
      await acquireFileLock(targetFile, 200)
    } catch (err) {
      failed = true
      expect(err.message).toContain("等待已超时")
    }
    expect(failed).toBe(true)

    await release1()

    // 释放后应能成功获取
    const release2 = await acquireFileLock(targetFile, 500)
    expect(typeof release2).toBe("function")
    await release2()
  })

  test("仅回收超过一分钟且进程已退出的陈旧锁", async () => {
    const targetFile = path.join(tmpDir, "providers.json")
    const lockFile = `${targetFile}.lock`

    // 创建两分钟前且持有进程不存在的陈旧锁
    const staleInfo = { pid: 99999999, time: Date.now() - 120000 }
    await fs.writeFile(lockFile, JSON.stringify(staleInfo))
    await fs.utimes(lockFile, new Date(Date.now() - 120000), new Date(Date.now() - 120000))

    const release = await acquireFileLock(targetFile, 1000)
    expect(typeof release).toBe("function")

    // 验证旧锁已被更新为当前进程
    const lockContent = JSON.parse(await fs.readFile(lockFile, "utf-8"))
    expect(lockContent.pid).toBe(process.pid)

    await release()
    await expect(fs.access(lockFile)).rejects.toThrow()
  })
})

describe("合并式冲突处理与 0600 安全写回真实文件系统测试", () => {
  const tmpDir = path.join(os.tmpdir(), `magpie-test-safety-${Date.now()}`)

  beforeEach(async () => {
    await fs.mkdir(tmpDir, { recursive: true })
    clearCachedProbe()
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  test("合并式冲突处理：探测期间 Provider A 被外部修改，Provider A 跳过，Provider B 正常写入", async () => {
    const targetFile = path.join(tmpDir, "providers.json")

    const initialData = {
      providers: [
        {
          id: "provider-a",
          name: "供应商 A",
          chat: "https://provider-a.test/v1",
          key: "sk-key-a",
        },
        {
          id: "provider-b",
          name: "供应商 B",
          chat: "https://provider-b.test/v1",
          key: "sk-key-b",
        },
      ],
    }

    await fs.writeFile(targetFile, JSON.stringify(initialData, null, 2), { mode: 0o600 })

    let probeStarted = false
    const mockFetch = async (url) => {
      if (!probeStarted) {
        probeStarted = true
        // 模拟在探测期间，Magpie GUI 外部修改了 provider-a (比如修改了模型名称)
        const externalModified = JSON.parse(await fs.readFile(targetFile, "utf-8"))
        externalModified.providers[0].name = "供应商 A (GUI 已改名)"
        externalModified.providers[0].customNote = "外部重要备注"
        await fs.writeFile(targetFile, JSON.stringify(externalModified, null, 2))
      }

      if (url.includes("provider-a.test/v1/usage")) {
        return new Response(JSON.stringify({ mode: "quota_limited", remaining: 10.0 }), { status: 200 })
      }
      if (url.includes("provider-b.test/v1/usage")) {
        return new Response(JSON.stringify({ mode: "quota_limited", remaining: 20.0 }), { status: 200 })
      }
      return new Response("Not Found", { status: 404 })
    }

    const res = await autoConfigureProviders({
      customDir: tmpDir,
      force: false,
      fetchFn: mockFetch,
    })

    expect(res.success).toBe(true)

    // 检查结果状态
    const statusA = res.results.find((r) => r.id === "provider-a")
    const statusB = res.results.find((r) => r.id === "provider-b")

    expect(statusA.status).toBe("conflicted")
    expect(statusB.status).toBe("configured")

    // 读取最终文件，验证外部修改未丢失
    const finalContent = JSON.parse(await fs.readFile(targetFile, "utf-8"))
    const finalA = finalContent.providers.find((p) => p.id === "provider-a")
    const finalB = finalContent.providers.find((p) => p.id === "provider-b")

    // Provider A 保持外部修改的名称与备注，且没有被强行覆盖 balanceURL
    expect(finalA.name).toBe("供应商 A (GUI 已改名)")
    expect(finalA.customNote).toBe("外部重要备注")
    expect(finalA.balanceURL).toBeUndefined()

    // Provider B 成功写入新配置
    expect(finalB.balanceURL).toBe("https://provider-b.test/v1/usage")
    expect(finalB.balancePath).toBe("$remaining")
  })

  test("0o600 安全文件权限：目标文件与 .bak 备份文件的 mode 必须为 0600", async () => {
    const targetFile = path.join(tmpDir, "providers.json")
    const initialData = {
      providers: [
        {
          id: "p-perm",
          chat: "https://perm.test/v1",
          key: "sk-secret-key-12345",
        },
      ],
    }
    await fs.writeFile(targetFile, JSON.stringify(initialData, null, 2))

    const mockFetch = async () => new Response(JSON.stringify({ mode: "quota_limited", remaining: 5.0 }), { status: 200 })

    const res = await autoConfigureProviders({
      customDir: tmpDir,
      fetchFn: mockFetch,
    })
    expect(res.success).toBe(true)

    const targetStat = await fs.stat(targetFile)
    const bakStat = await fs.stat(`${targetFile}.bak`)

    expect(targetStat.mode & 0o777).toBe(0o600)
    expect(bakStat.mode & 0o777).toBe(0o600)
  })

  test("幂等性：当配置已是最优状态时，不重复执行文件写入", async () => {
    const targetFile = path.join(tmpDir, "providers.json")
    const initialData = {
      providers: [
        {
          id: "p-idempotent",
          chat: "https://idem.test/v1",
          key: "sk-idem",
          balanceURL: "https://idem.test/v1/usage",
          balancePath: "$remaining",
          balanceMethod: "GET",
        },
      ],
    }
    await fs.writeFile(targetFile, JSON.stringify(initialData, null, 2))

    const mockFetch = async () => new Response(JSON.stringify({ mode: "quota_limited", remaining: 50.0 }), { status: 200 })

    const dryRun = await autoConfigureProviders({
      customDir: tmpDir,
      force: true,
      dryRun: true,
      fetchFn: mockFetch,
    })
    expect(dryRun.hasChanges).toBe(false)
    expect(dryRun.results[0].status).toBe("unchanged")

    // 第一次扫描：已配置且健康，直接返回无需改动
    const res1 = await autoConfigureProviders({ customDir: tmpDir, force: false, fetchFn: mockFetch })
    expect(res1.hasChanges).toBe(false)

    // 第二次扫描带 --force：重新探测命中相同配置，检测到无差异，hasChanges 依然为 false
    const res2 = await autoConfigureProviders({ customDir: tmpDir, force: true, fetchFn: mockFetch })
    expect(res2.hasChanges).toBe(false)
    expect(res2.results[0].status).toBe("unchanged")
  })
})

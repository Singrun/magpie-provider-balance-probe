import { test, expect, describe } from "bun:test"
import { probe, extractBaseURL, readLimitedText } from "../src/detector.js"
import { checkBalanceHealth, shouldConfigureProvider } from "../src/configurator.js"
import { getCachedProbe, setCachedProbe, clearCachedProbe } from "../src/cache.js"

describe("智能探测与原生 Balance 配置推导测试 (Mock 网络)", () => {
  test("探针拒绝跨重定向转发 API Key，并限制响应体大小", async () => {
    clearCachedProbe()
    let capturedOptions
    const provider = { id: "redirect", chat: "https://redirect.example/v1", key: "sk-sensitive" }
    const redirectFetch = async (_url, options) => {
      capturedOptions = options
      return new Response("", { status: 302, headers: { location: "https://attacker.example/" } })
    }
    await probe(provider, redirectFetch)
    expect(capturedOptions.redirect).toBe("error")

    const oversized = new Response("x".repeat(70 * 1024), { status: 200 })
    await expect(readLimitedText(oversized)).rejects.toThrow("response_too_large")
  })

  test("普通余额字段和 OpenAI 通用账单端点不构成平台指纹", async () => {
    clearCachedProbe()
    const requested = []
    const provider = {
      id: "generic-openai-compatible",
      chat: "https://generic-relay.example/v1",
      key: "sk-generic",
    }
    const mockFetch = async url => {
      requested.push(url)
      if (url.endsWith("/usage") || url.endsWith("/v1/usage")) {
        return new Response(JSON.stringify({ remaining: 10 }), { status: 200 })
      }
      if (url.includes("/credit_grants")) {
        return new Response(JSON.stringify({ total_available: 10 }), { status: 200 })
      }
      return new Response("Not found", { status: 404 })
    }

    const result = await probe(provider, mockFetch)
    expect(result.detected).toBe(false)
    expect(requested.some(url => url.includes("/credit_grants"))).toBe(false)
  })

  test("探测命中 Sub2API 平台并生成原生 Balance 配置", async () => {
    clearCachedProbe()
    const provider = {
      id: "my-relay",
      name: "我的中转",
      chat: "https://my-sub2api.example.com/v1",
      key: "sk-test123",
    }

    const mockFetch = async (url) => {
      if (url.includes("/v1/usage")) {
        return new Response(JSON.stringify({
          mode: "quota_limited",
          remaining: 100.5,
          rate_limits: [{ window: "5h", limit: 200, used: 99.5 }],
        }), { status: 200 })
      }
      return new Response("Not found", { status: 404 })
    }

    const res = await probe(provider, mockFetch)
    expect(res.detected).toBe(true)
    expect(res.platform).toBe("Sub2API")
    expect(res.balanceURL).toBe("https://my-sub2api.example.com/v1/usage")
    expect(res.balancePath).toBe("$remaining")
    expect(res.balanceMethod).toBe("GET")
    expect(res.sampleBalance).toBe("$100.50")
  })

  test("严格保留自定义前缀路径，不盲目截断为 origin", async () => {
    clearCachedProbe()
    const provider = {
      id: "custom-prefix-relay",
      name: "带自定义前缀的中转",
      chat: "https://relay.custom.io/my-prefix/v1/chat/completions",
      key: "sk-prefix123",
    }

    const mockFetch = async (url) => {
      if (url === "https://relay.custom.io/my-prefix/v1/usage") {
        return new Response(JSON.stringify({
          mode: "quota_limited",
          remaining: 45.6,
        }), { status: 200 })
      }
      return new Response("Not found", { status: 404 })
    }

    const res = await probe(provider, mockFetch)
    expect(res.detected).toBe(true)
    expect(res.balanceURL).toBe("https://relay.custom.io/my-prefix/v1/usage")
  })

  test("探测命中 New-API 平台并生成原生 Balance 配置", async () => {
    clearCachedProbe()
    const provider = {
      id: "my-newapi",
      name: "新API中转",
      chat: "https://my-newapi.example.com/v1",
      key: "sk-test456",
    }

    const mockFetch = async (url) => {
      if (url.includes("/api/usage/token")) {
        return new Response(JSON.stringify({
          code: true,
          data: {
            object: "token_usage",
            total_available: 1500000,
          },
        }), { status: 200 })
      }
      return new Response("Not found", { status: 404 })
    }

    const res = await probe(provider, mockFetch)
    expect(res.detected).toBe(true)
    expect(res.platform).toBe("New-API / One-API")
    expect(res.balanceURL).toBe("https://my-newapi.example.com/api/usage/token")
    expect(res.balancePath).toBe("$data.total_available / 500000")
    expect(res.sampleBalance).toBe("$3.00")
  })

  test("New-API 直接返回结构使用根级 BalancePath", async () => {
    clearCachedProbe()
    const provider = {
      id: "newapi-root",
      chat: "https://newapi-root.example/v1",
      key: "sk-root",
    }
    const mockFetch = async url => {
      if (url.includes("/api/usage/token")) {
        return new Response(JSON.stringify({
          object: "token_usage",
          total_available: 1000000,
        }), { status: 200 })
      }
      return new Response("Not found", { status: 404 })
    }

    const result = await probe(provider, mockFetch)
    expect(result.detected).toBe(true)
    expect(result.balancePath).toBe("$total_available / 500000")
  })

  test("New-API 自定义前缀首个端点只有无限标记时，继续回退到根路径探测", async () => {
    clearCachedProbe()
    const provider = {
      id: "newapi-fallback",
      chat: "https://relay.example.com/gateway/v1",
      key: "sk-fallback",
    }

    const mockFetch = async (url) => {
      if (url === "https://relay.example.com/gateway/api/usage/token") {
        return new Response(JSON.stringify({
          data: { unlimited_quota: true },
        }), { status: 200 })
      }
      if (url === "https://relay.example.com/api/usage/token") {
        return new Response(JSON.stringify({
          data: { total_available: "1000000" },
        }), { status: 200 })
      }
      return new Response("Not found", { status: 404 })
    }

    const res = await probe(provider, mockFetch)
    expect(res.detected).toBe(true)
    expect(res.balanceURL).toBe("https://relay.example.com/api/usage/token")
    expect(res.sampleBalance).toBe("$2.00")
  })

  test("探测命中 LiteLLM Proxy 平台并生成原生带有 {key} 的 BalanceURL", async () => {
    clearCachedProbe()
    const provider = {
      id: "my-litellm",
      name: "LiteLLM代理",
      chat: "https://litellm.example.com/v1",
      key: "sk-litellm-secret",
    }

    const mockFetch = async (url) => {
      if (url.includes("/key/info")) {
        return new Response(JSON.stringify({
          info: {
            spend: 5.5,
            max_budget: 20.0,
          },
        }), { status: 200 })
      }
      return new Response("Not found", { status: 404 })
    }

    const res = await probe(provider, mockFetch)
    expect(res.detected).toBe(true)
    expect(res.platform).toBe("LiteLLM Proxy")
    expect(res.balanceURL).toBe("https://litellm.example.com/key/info?key={key}")
    expect(res.balancePath).toBe("info.max_budget - info.spend")
    expect(res.sampleBalance).toBe("$14.50")
  })

  test("通用探针不把 Sub2API 非余额结构或 LiteLLM 单独 spend 字段误配成余额", async () => {
    clearCachedProbe()
    const provider = { id: "partial", chat: "https://partial.example/v1", key: "sk-partial" }
    const mockFetch = async url => {
      if (url.includes("/usage")) {
        return new Response(JSON.stringify({ mode: "quota_limited", balance: 42 }), { status: 200 })
      }
      if (url.includes("/key/info")) {
        return new Response(JSON.stringify({ info: { spend: 2.5 } }), { status: 200 })
      }
      return new Response("Not found", { status: 404 })
    }
    const result = await probe(provider, mockFetch)
    expect(result.detected).toBe(false)
  })
})

describe("已添加供应商状态判定与健康检查", () => {
  test("已添加但未配置 BalanceURL 的供应商应被纳入修补范围", async () => {
    const p = {
      id: "test-relay",
      chat: "https://test-relay.com/v1",
      key: "sk-xxx",
      balanceURL: null,
    }
    const should = await shouldConfigureProvider(p, false)
    expect(should).toBe(true)
  })

  test("已配置且正常工作的供应商无需重新配置 (force=false, 无多余请求)", async () => {
    const p = {
      id: "good-relay",
      chat: "https://good-relay.com/v1",
      key: "sk-xxx",
      balanceURL: "https://good-relay.com/v1/usage",
      balancePath: "$remaining",
    }
    const mockGoodFetch = async () => new Response(JSON.stringify({ remaining: 50.0 }), { status: 200 })
    const should = await shouldConfigureProvider(p, false, mockGoodFetch)
    expect(should).toBe(false)
  })

  test("force 直接执行平台探针，不先重复请求现有余额 URL", async () => {
    let requests = 0
    const p = {
      id: "force-efficient",
      chat: "https://force-efficient.example/v1",
      key: "sk-force",
      balanceURL: "https://force-efficient.example/v1/usage",
      balancePath: "$remaining",
    }
    const should = await shouldConfigureProvider(p, true, async () => {
      requests++
      return new Response(JSON.stringify({ mode: "quota_limited", remaining: 3 }), { status: 200 })
    })
    expect(should).toBe(true)
    expect(requests).toBe(0)
  })

  test("已配置但现有 BalanceURL 404 或失效的供应商应自动触发修复", async () => {
    const p = {
      id: "broken-relay",
      chat: "https://broken-relay.com/v1",
      key: "sk-xxx",
      balanceURL: "https://broken-relay.com/wrong/path",
    }
    const mockBadFetch = async () => new Response("Not Found", { status: 404 })
    const should = await shouldConfigureProvider(p, false, mockBadFetch)
    expect(should).toBe(true)
  })

  test("LiteLLM 健康检查应自动替换 ?key={key} 占位符", async () => {
    let capturedUrl = ""
    const mockLiteLLMFetch = async (url) => {
      capturedUrl = url
      return new Response(JSON.stringify({ info: { spend: 10.0, max_budget: 50.0 } }), { status: 200 })
    }

    const p = {
      id: "my-litellm",
      chat: "https://litellm.example.com/v1",
      key: "sk-secret-123456",
      balanceURL: "https://litellm.example.com/key/info?key={key}",
      balancePath: "info.max_budget - info.spend",
    }

    const res = await checkBalanceHealth(p, mockLiteLLMFetch)
    expect(res.healthy).toBe(true)
    expect(capturedUrl).toContain("key=sk-secret-123456")
    expect(capturedUrl).not.toContain("{key}")
  })
})

describe("探针 TTL 缓存与避免重复探测测试", () => {
  test("TTL 缓存命中应立即返回，不发起重复请求", async () => {
    clearCachedProbe()
    let requestCount = 0
    const mockFetch = async () => {
      requestCount++
      return new Response(JSON.stringify({ mode: "quota_limited", remaining: 10.0 }), { status: 200 })
    }

    const p = { id: "p1", chat: "https://p1.com/v1", key: "sk-p1-key" }
    const res1 = await probe(p, mockFetch)
    expect(res1.detected).toBe(true)
    expect(requestCount).toBe(1)

    // 第二次探测相同 provider 命中缓存
    const res2 = await probe(p, mockFetch)
    expect(res2.detected).toBe(true)
    expect(requestCount).toBe(1) // 请求计数未增加！
  })
})

import { test, expect, describe } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")

describe("Magpie 页面挂载契约", () => {
  test("package.json 声明独立页面、最小读取权限和默认开关", async () => {
    const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"))

    expect(pkg.name).toBe("magpie-provider-balance-probe")
    expect(pkg.keywords).toContain("magpie-plugin")
    expect(pkg.keywords).toContain("opencode")
    expect(pkg.keywords).toContain("opencode-plugin")
    expect(pkg.bin).toBeUndefined()
    expect(pkg.files).toContain("page")
    expect(pkg.files).toContain("LICENSE")
    expect(pkg.magpie.page).toEqual({
      title: "Provider balances",
      file: "page/index.html",
      icon: "page/icon.svg",
      titles: { zh: "Provider 余额" },
    })
    expect(pkg.magpie.permissions).toBeUndefined()
    expect(pkg.magpie.options).toEqual({ display: true })
  })

  test("页面使用官方 bridge，不直接访问网络或读取凭据", async () => {
    const html = await fs.readFile(path.join(root, "page/index.html"), "utf8")
    const app = await fs.readFile(path.join(root, "page/app.js"), "utf8")

    expect(html).toContain('src="_magpie/bridge.js"')
    expect(app).toContain("await magpie.ready")
    expect(app).toContain("magpie.options.get()")
    expect(app).toContain("magpie.options.set({ display })")
    expect(app).not.toContain("fetch(")
    expect(app).not.toContain("balanceURL")
    expect(app).not.toContain("provider.key")
    expect(app).not.toContain("deduplicate")
    expect(app).not.toContain("providers:list")
    expect(app).not.toContain("usage")
    expect(app).not.toContain("magpie.read(")
  })
})

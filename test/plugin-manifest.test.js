import { test, expect, describe } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")

describe("Magpie 插件清单契约", () => {
  test("插件只注册探测工具，不声明余额页面、显示选项或汇总能力", async () => {
    const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"))
    const entry = await fs.readFile(path.join(root, "index.js"), "utf8")
    const sourceFiles = await Promise.all([
      "src/detector.js",
      "src/configurator.js",
      "cli.js",
    ].map(file => fs.readFile(path.join(root, file), "utf8")))
    const source = [...sourceFiles, entry].join("\n")

    expect(pkg.name).toBe("magpie-provider-balance-probe")
    expect(pkg.version).toBe("0.0.1")
    expect(pkg.keywords).toContain("magpie-plugin")
    expect(pkg.magpie.page).toBeUndefined()
    expect(pkg.magpie.options).toBeUndefined()
    expect(pkg.files).not.toContain("page")
    expect(pkg.files).toContain("LICENSE")
    expect(pkg.files).toContain("CHANGELOG.md")
    expect(pkg.files).toContain("SECURITY.md")
    expect(entry).not.toContain("display")
    expect(source).not.toContain("balanceSummary")
    expect(source).not.toContain("sampleBalance")
    await expect(fs.access(path.join(root, "page"))).rejects.toThrow()
  })
})

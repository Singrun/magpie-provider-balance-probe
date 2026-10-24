#!/usr/bin/env node
/**
 * CLI 命令行工具：一键扫描并配置/修复当前所有第三方供应商的余额获取端点
 */

import { autoConfigureProviders, getMagpieProvidersPath } from "./src/configurator.js"

async function main() {
  const args = process.argv.slice(2)
  const force = args.includes("--force") || args.includes("-f")
  const dryRun = args.includes("--dry-run") || args.includes("-d")

  console.log("==================================================")
  console.log("  Magpie 第三方供应商余额自动配置与健康修复工具  ")
  console.log("==================================================")
  console.log(`配置文件路径: ${getMagpieProvidersPath()}`)
  console.log(`模式: ${dryRun ? "仅预检 (Dry Run)" : "自动更新 (Auto Apply)"} ${force ? "[强制重新探测默认认证供应商]" : ""}`)
  console.log("正在检查未配置或余额接口失效的第三方供应商；自定义认证供应商会跳过自动探测...")
  const res = await autoConfigureProviders({ force, dryRun })

  if (!res.success) {
    console.error(`❌ 执行失败: ${res.error}`)
    process.exit(1)
  }

  if (res.results.length === 0) {
    console.log("✨ 检查完毕：当前已添加的所有第三方供应商均已正常配置且余额接口健康。")
    console.log("提示：可使用 --force 参数强制重新扫描所有供应商。\n")
    return
  }

  if (res.results.length > 0) {
    console.log("\n📊 探测与配置结果汇总：")
    console.log("--------------------------------------------------------------------------------------------------------")
    console.log(
      "名称/ID".padEnd(20) +
      "识别平台".padEnd(22) +
      "处理状态".padEnd(14) +
      "Balance URL"
    )
    console.log("--------------------------------------------------------------------------------------------------------")

    for (const r of res.results) {
      const name = (r.name || r.id).slice(0, 18).padEnd(20)
      const platform = (r.platform || "未知").slice(0, 20).padEnd(22)
      let status = "⚠️ 未识别"
      if (r.status === "configured") status = "✅ 新增配置"
      if (r.status === "repaired") status = "🔧 自动修复"
      if (r.status === "conflicted") status = "⚡ 并发冲突"
      if (r.status === "unchanged") status = "✨ 已是最优"
      status = status.padEnd(14)

      const url = r.balanceURL || r.reason || ""

      console.log(`${name}${platform}${status}${url}`)
    }
    console.log("--------------------------------------------------------------------------------------------------------\n")

    const actionCount = res.results.filter(r => r.status === "configured" || r.status === "repaired").length
    const conflictCount = res.results.filter(r => r.status === "conflicted").length

    if (conflictCount > 0) {
      console.log(`⚠️ 提示: 检测到 ${conflictCount} 个供应商在探测期间被外部修改，已安全跳过更新以保护数据。`)
    }
    if (actionCount > 0) {
      if (dryRun) {
        console.log(`💡 预检完成：共发现 ${actionCount} 个供应商可自动完成/修复余额配置。`)
        console.log(`去掉 --dry-run 参数运行即可立即应用并保存至 providers.json。`)
      } else {
        console.log(`🎉 已自动配置/修复 ${actionCount} 个第三方供应商的原生余额参数。`)
        console.log("可运行 magpie quota 检查 Magpie 是否能读取余额。")
      }
    } else {
      console.log("⚠️ 本次扫描未识别出可配置的第三方供应商。")
    }
  }
}

main().catch(err => {
  console.error("执行异常:", err)
  process.exit(1)
})

# Magpie Provider Balance Probe

**修复第三方 API 中转站在 Magpie 中无法正确读取余额的问题。** 插件按需探测已支持平台的余额接口，并将识别到的端点写入 Magpie 原生 Provider 余额配置。

[![Magpie plugin](https://img.shields.io/badge/Magpie-plugin-5267df)](https://usemagpie.ai/docs/zh/plugins)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

## 功能

- 为可识别的第三方 Provider 补全或修复 Magpie 原生 `BalanceURL`、`BalancePath` 和 `BalanceMethod`。
- 通过插件工具按需运行；提供独立页面管理余额结果显示选项。
- 可选择返回已有余额明细和直接合计，不做 URL 去重，也不显示用量。
- 未识别的平台或响应结构不会被当作余额接口写入配置。

## 安装

在 Magpie 的 **Plugins → Discover → Unofficial, on GitHub** 中查找 **Magpie Provider Balance Probe**，或直接添加 GitHub 仓库：

```bash
magpie plugin add github:Singrun/magpie-provider-balance-probe
magpie plugin on github:Singrun/magpie-provider-balance-probe
```

也可以按 npm 包名安装：

```bash
magpie plugin add magpie-provider-balance-probe
```

GitHub 发现列表由 Magpie 定期刷新，添加 topic 后可能需要几分钟才会出现。npm 安装仅在该版本发布到 npm registry 后可用。

## 使用

启用后，插件注册 `auto_configure_provider_balances` 工具。默认调用会检查尚未配置或当前余额接口不健康的受支持 Provider，并修复识别到的余额配置。工具可接收以下可选参数：

| 参数 | 默认值 | 作用 |
| --- | --- | --- |
| `force` | `false` | 重新探测默认 API Key 鉴权的 Provider。带自定义 `BalanceToken` 或请求头的 Provider 不会自动探测。 |
| `display` | 插件选项中的设置，默认为 `true` | 返回余额明细与合计。设为 `false` 时不生成余额汇总。 |

余额数据在工具返回值的 `balanceSummary` 中：`balances` 列出每个有效 Provider，`total` 是明细的直接合计。使用相同中转站的多个 Key 会分别列出并分别计入合计。

插件页面可调整 `display` 开关。受 Magpie 页面权限限制，该页面只管理选项，不读取 Provider 配置或工具执行结果；余额数据由工具返回。

## 支持范围

目前探测以下平台的已知余额接口：

| 平台 | 余额接口特征 |
| --- | --- |
| Sub2API | `/usage`，读取数值型 `remaining` |
| New-API / One-API | `/api/usage/token`，将数值型 `total_available` 按平台额度单位换算 |
| LiteLLM Proxy | `/key/info`，以 `max_budget - spend` 计算剩余额度 |

接口路径会结合 Provider 的基础 URL 探测，并保留自定义 URL 前缀。其他平台、改造过的接口或不同响应格式可能无法识别；未命中时不会写入推测配置。

## 安全与数据处理

- 探针只在用户调用工具或 CLI 时运行；不启动后台监听、定时任务或服务。
- 网络请求使用 Provider API Key，限制超时和响应体大小，并拒绝自动跟随重定向。
- 带自定义余额 Token 或请求头的 Provider 跳过自动探测，避免以错误认证覆盖用户配置。
- 配置写入前创建备份，并采用锁、冲突检查和原子替换；只更新余额配置字段。
- 不注销账号、不删除 Provider、不修改 API Key。余额明细和合计不会按 Provider URL 去重。

## 独立 CLI

仓库也提供用于本机诊断和维护的 CLI。开发仓库中可运行：

```bash
bun cli.js --dry-run  # 预检，不写入配置
bun cli.js            # 应用识别到的余额配置
bun cli.js --force    # 重新探测默认认证的 Provider
bun cli.js --display  # 同时读取并输出余额明细与合计
```

CLI 直接读取当前 Magpie 配置目录中的 `providers.json`。运行前请先用 `--dry-run` 检查拟议变更。

## 开发与验证

需要安装 [Bun](https://bun.sh/)：

```bash
bun install
bun test
node --check index.js
node --check cli.js
```

单元测试使用模拟响应验证解析、配置和文件安全行为；它们不能替代真实中转站账户上的端到端验证。

## 问题反馈

报告问题时请附上 Magpie 版本、Provider 平台类型、脱敏后的余额接口响应结构及工具返回的错误信息。请勿提交 API Key、Token 或包含凭据的配置文件。

- [报告问题](https://github.com/Singrun/magpie-provider-balance-probe/issues)
- [Magpie 插件文档](https://usemagpie.ai/docs/zh/plugins)

## License

[MIT](LICENSE)

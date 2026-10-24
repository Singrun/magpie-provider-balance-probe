# Magpie Provider 余额探针

包名：`magpie-provider-balance-probe`

这是一个按需运行的 Magpie 插件工具，用于识别部分第三方 API 中转平台的专用余额接口，并补全 Magpie 原生 `BalanceURL`、`BalancePath` 与 `BalanceMethod`。探针范围限定为 Sub2API、New-API / One-API 和 LiteLLM，不把普通 OpenAI 兼容接口或无法确认结构的响应当作余额接口。

插件只在用户调用维护工具时运行，不启动后台监听、定时任务或本地服务。探测请求会携带已配置的 API Key；带有自定义 `BalanceToken` 或请求头的 Provider 会跳过通用自动探测，避免使用错误的认证方式修改现有配置。

## 使用

```bash
# 只探测并显示拟议变更
bun cli.js --dry-run

# 应用可识别的余额配置
bun cli.js

# 重新探测默认 API Key 鉴权的 Provider
bun cli.js --force

# 返回真实 Provider 余额明细与直接合计
bun cli.js --display
```

Magpie 插件入口注册 `auto_configure_provider_balances` 工具。工具提供两个可选布尔参数：

- `force`：重新探测默认 API Key 鉴权的 Provider；不会探测自定义认证 Provider。
- `display`：返回已经读取到的真实 Provider 余额明细与合计。

`balanceSummary.balances` 保留每一条有效 Provider 余额，`total` 是这些余额的直接合计。插件不按 Provider URL 合并，也不修改 Magpie 官方用量页面。

## 页面挂载

插件声明一个独立页面，名称为“Provider 余额”：

```bash
magpie plugin add /Users/singrun/DEV/G
magpie plugin on /Users/singrun/DEV/G
magpie plugin
```

确认列表中出现：

```text
tools  G_auto_configure_provider_balances
page   Provider balances
```

页面只提供 `display` 选项。由于 Magpie 官方页面桥接不能调用插件工具，也不能读取 `providers.json`、API Key 或第三方余额响应，页面不会伪造实时数据或自行发起探测。真实余额以 `auto_configure_provider_balances({ display: true })` 的工具返回值为准。

## 安全与行为

- 仅探测 Sub2API、New-API / One-API 与 LiteLLM 的特征接口；未知结构不写配置。
- 请求超时 3.5 秒、响应体上限 64 KiB、禁止自动跟随重定向，避免把凭据转发到另一主机。
- 探测结果按 API Key 指纹缓存，成功 TTL 5 分钟、失败 TTL 1 分钟，最多 256 项。
- 写入前创建备份，使用临时文件和原子替换；写入期间由锁协调本工具进程，并按 Provider 检测探测期间已观察到的修改。
- 锁陈旧回收要求锁超过一分钟且记录的进程已退出；无效锁仅在五分钟后回收。
- 自动写入仅更改余额配置字段；配置已相同则不写文件。
- `display` 只读取已配置或本次探测到的余额，返回 Provider 明细、余额来源和所有有效余额的直接合计。
- 探针不会注销账号、删除 Provider 或改变 API Key。

文件锁不被 Magpie GUI 使用，因此无法提供 GUI 与本工具之间的严格原子 compare-and-swap。提交时若能观察到 Provider 已变化会跳过该条；外部程序若恰在最后一次读取后并发写入，仍存在极短竞态窗口。

## 验证

```bash
bun test
node --check index.js
node --check cli.js
node --check src/detector.js
node --check src/configurator.js
node --check src/cache.js
node --check page/app.js
```

测试覆盖三种平台的指纹探测、余额配置健康检查、缓存、超时与响应限制、文件锁、冲突跳过、安全写回和余额直接合计。Mock 测试只能证明本插件对已知响应结构的处理，不能替代实际中转站账户与 Magpie 界面的端到端验证。

## 项目结构

```text
index.js             Magpie 插件入口
cli.js               独立诊断与修复命令
src/detector.js      平台指纹探针
src/configurator.js  Provider 检查与安全配置写回
src/cache.js         有界 TTL 缓存
page/                单一 Provider 余额页面
test/                自动化测试
```

## License

MIT

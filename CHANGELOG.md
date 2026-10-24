# Changelog

## 0.0.1 - 2026-10-24

首个公开预发布版本。

- 支持探测 Sub2API、New-API / One-API 和 LiteLLM 的已知余额接口。
- 自动补全或修复 Magpie 原生 `BalanceURL`、`BalancePath` 和 `BalanceMethod`。
- 使用按需工具调用，不运行后台监听、定时任务或本地服务。
- 写入配置前执行备份、文件锁、并发冲突检查和原子替换。

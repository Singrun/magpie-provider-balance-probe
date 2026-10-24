/**
 * magpie-provider-balance-probe: Magpie 第三方 Provider 余额探针工具插件
 * 严格遵循 Magpie 插件规范，仅暴露显式可调用的维护工具，不在宿主中产生未授权后台副作用
 */

import { autoConfigureProviders } from "./src/configurator.js"

const ProviderBalanceProbePlugin = async (_input, pluginOptions) => {
  const defaults = {
    display: pluginOptions?.display === undefined ? true : Boolean(pluginOptions.display),
  }

  return {
    tool: {
      auto_configure_provider_balances: {
        description: "按需探测 Sub2API、New-API / One-API、LiteLLM 专用配额接口，修复 Magpie 原生余额配置，并可显示第三方余额汇总",
        args: {
          type: "object",
          properties: {
            force: {
              type: "boolean",
              description: "是否重新探测默认 API Key 鉴权的供应商（可选；不会探测自定义认证供应商）",
            },
            display: {
              type: "boolean",
              description: "是否返回真实 Provider 的余额明细与合计",
            },
          },
        },
        async execute(args, ctx) {
          const display = args?.display === undefined ? defaults.display : Boolean(args.display)
          const res = await autoConfigureProviders({
            force: Boolean(args?.force),
            signal: ctx?.abort,
            display,
          })
          return JSON.stringify(res, null, 2)
        },
      },
    },
  }
}

export default ProviderBalanceProbePlugin

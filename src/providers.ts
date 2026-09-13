// src/providers.ts
// Provider 预设表 —— 每家一个定义：baseUrl + 默认 model + 协议。
// provider id 是唯一选择器：选中后，未显式指定的 model/baseUrl 落到预设值（参考 pi 的 providers/*.ts 定义模式）。

export type ProviderPreset = {
  baseUrl: string
  model: string
  protocol: 'openai' | 'anthropic'
}

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  openai:     { baseUrl: 'https://api.openai.com/v1',          model: 'gpt-5',           protocol: 'openai' },
  anthropic:  { baseUrl: 'https://api.anthropic.com/v1',       model: 'claude-sonnet-5', protocol: 'anthropic' },
  zhipu:      { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3-flash', protocol: 'openai' },
  zai:        { baseUrl: 'https://api.z.ai/api/paas/v4',       model: 'glm-5.3-flash',   protocol: 'openai' },
  deepseek:   { baseUrl: 'https://api.deepseek.com/v1',        model: 'deepseek-chat',   protocol: 'openai' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1',       model: 'openrouter/auto', protocol: 'openai' },
}

/** 未指定 provider 时的缺省（与项目默认模型 glm-5.3-flash 自洽） */
export const DEFAULT_PROVIDER = 'zhipu'

/** 按 id 查预设，未知 provider 返回 undefined（调用方决定报错还是回退） */
export function getPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS[id]
}

/** 预设目录文本，供报错/帮助信息列出可选 provider */
export function presetCatalog(): string {
  return Object.entries(PROVIDER_PRESETS)
    .map(([id, p]) => `  ${id.padEnd(12)} ${p.baseUrl}（默认 ${p.model}）`)
    .join('\n')
}

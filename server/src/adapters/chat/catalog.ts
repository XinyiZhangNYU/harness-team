import type { ChatApiFormat, ChatModelFields, ChatPreset } from '../../../../shared/protocol.ts';

/**
 * Presets and the known-model table of chat members (docs/MODEL_PROVIDERS_PRESETS.md, checked 2026-11-10). A preset is
 * only a filled-in template: nothing here is vendor code. Recommended model values are looked up by model id, Base URL
 * and format, and follow this table when it changes; fields the user set by hand do not (see providers.ts).
 */

export const CHAT_PRESETS: ChatPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    format: 'openai_responses',
    baseUrl: 'https://api.openai.com/v1',
    vertex: false,
    models: ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna'],
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    format: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    vertex: false,
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2', 'claude-fable-5-1'],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    format: 'anthropic',
    baseUrl: 'https://api.deepseek.com/anthropic',
    vertex: false,
    models: ['deepseek-flash', 'deepseek-v4-pro'],
  },
  {
    id: 'glm',
    label: 'GLM',
    format: 'openai_chat',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    vertex: false,
    models: ['glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx', 'glm-5.2'],
  },
  {
    id: 'gemini',
    label: 'Gemini (AI Studio)',
    format: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    vertex: false,
    models: ['gemini-4-argon', 'gemini-3.8-flash'],
  },
  {
    id: 'vertex',
    label: 'Vertex AI',
    format: 'gemini',
    baseUrl: 'https://aiplatform.googleapis.com/v1',
    vertex: true,
    // gemini-4-argon is served only in the global location, which needs a project ID (checked 2026-11-10).
    models: ['gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemini-3.1-flash-lite'],
  },
];

/** What a model id not in the table gets: 32K context, text only, no reasoning control. */
export const CONSERVATIVE_MODEL: Omit<ChatModelFields, 'displayName'> = {
  enabled: true,
  contextTokens: 32_000,
  maxOutputTokens: 16_384,
  image: false,
  pdf: false,
  tools: true,
  webSearch: false,
  reasoningLevels: [],
  reasoningMapping: '',
  extraBody: '',
  extraHeaders: '',
  explicitCache: false,
  replayReasoning: true,
  compactAt: 0.75,
  price: null,
};

type Known = {
  ids: string[];
  formats: ChatApiFormat[];
  /** Base URL must contain one of these (lowercase); absent = any. */
  hosts?: string[];
  fields: Partial<Omit<ChatModelFields, 'displayName' | 'enabled'>>;
};

const json = (v: unknown) => JSON.stringify(v);
const UP_TO_MAX = ['low', 'medium', 'high', 'xhigh', 'max'];
const ANTHROPIC_MAPPING = json({ thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: '{level}' } });
const DEEPSEEK_ANTHROPIC_MAPPING = json({
  disabled: { thinking: { type: 'disabled' } },
  low: { thinking: { type: 'enabled' }, output_config: { effort: 'low' } },
  high: { thinking: { type: 'enabled' }, output_config: { effort: 'high' } },
  max: { thinking: { type: 'enabled' }, output_config: { effort: 'max' } },
});
const GEMINI_MAPPING = json({ generationConfig: { thinkingConfig: { thinkingLevel: '{level}', includeThoughts: true } } });
const OFF_ON_THINKING = json({ off: { thinking: { type: 'disabled' } }, on: { thinking: { type: 'enabled' } } });

const KNOWN: Known[] = [
  // OpenAI: 1.05M context, but above 272K input is billed at double rate (user, 2026-11-10), so 272K is recommended.
  {
    ids: ['gpt-6-astra', 'gpt-6.1-sol'],
    formats: ['openai_responses'],
    fields: { contextTokens: 272_000, maxOutputTokens: 128_000, image: true, pdf: true, webSearch: true, reasoningLevels: UP_TO_MAX, reasoningMapping: json({ reasoning: { effort: '{level}', summary: 'auto' } }), extraBody: json({ prompt_cache_key: '{session}' }) },
  },
  {
    ids: ['gpt-6.1-terra', 'gpt-6-luna'],
    formats: ['openai_responses'],
    fields: { contextTokens: 272_000, maxOutputTokens: 128_000, image: true, pdf: true, webSearch: true, reasoningLevels: ['none', ...UP_TO_MAX], reasoningMapping: json({ reasoning: { effort: '{level}', summary: 'auto' } }), extraBody: json({ prompt_cache_key: '{session}' }) },
  },
  // In Chat Completions these models cannot call tools (only through Responses).
  {
    ids: ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra'],
    formats: ['openai_chat'],
    hosts: ['api.openai.com'],
    fields: { contextTokens: 272_000, maxOutputTokens: 128_000, image: true, tools: false, reasoningLevels: UP_TO_MAX, reasoningMapping: json({ reasoning_effort: '{level}' }), extraBody: json({ prompt_cache_key: '{session}' }) },
  },
  {
    ids: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2', 'claude-fable-5-1'],
    formats: ['anthropic'],
    hosts: ['api.anthropic.com'],
    fields: { contextTokens: 1_000_000, maxOutputTokens: 128_000, image: true, pdf: true, reasoningLevels: UP_TO_MAX, reasoningMapping: ANTHROPIC_MAPPING, explicitCache: true },
  },
  {
    ids: ['deepseek-flash'],
    formats: ['anthropic'],
    hosts: ['deepseek.com'],
    fields: { contextTokens: 1_000_000, maxOutputTokens: 384_000, image: true, reasoningLevels: ['disabled', 'low', 'high', 'max'], reasoningMapping: DEEPSEEK_ANTHROPIC_MAPPING },
  },
  {
    ids: ['deepseek-v4-pro'],
    formats: ['anthropic'],
    hosts: ['deepseek.com'],
    fields: { contextTokens: 1_000_000, maxOutputTokens: 384_000, reasoningLevels: ['disabled', 'low', 'high', 'max'], reasoningMapping: DEEPSEEK_ANTHROPIC_MAPPING },
  },
  {
    ids: ['deepseek-flash', 'deepseek-v4-pro'],
    formats: ['openai_chat'],
    hosts: ['deepseek.com'],
    fields: { contextTokens: 1_000_000, maxOutputTokens: 384_000, reasoningLevels: ['none', 'low', 'high', 'max'], reasoningMapping: json({ reasoning_effort: '{level}' }) },
  },
  {
    ids: ['glm-5.3'],
    formats: ['openai_chat'],
    hosts: ['bigmodel.cn', 'z.ai'],
    fields: { contextTokens: 1_000_000, maxOutputTokens: 128_000, reasoningLevels: ['low', 'high', 'max'], reasoningMapping: json({ reasoning_effort: '{level}' }), extraBody: json({ tool_stream: true }) },
  },
  // Native multimodal; thinking cannot be turned off. The Flash page says its text parameters match GLM-5.3, so the
  // same reasoning_effort levels are assumed (not listed on the page itself).
  {
    ids: ['glm-5.3-flash', 'glm-5.3-flashx'],
    formats: ['openai_chat'],
    hosts: ['bigmodel.cn', 'z.ai'],
    fields: { contextTokens: 1_000_000, maxOutputTokens: 128_000, image: true, reasoningLevels: ['low', 'high', 'max'], reasoningMapping: json({ reasoning_effort: '{level}' }), extraBody: json({ tool_stream: true }) },
  },
  // Context and output of these are not published in the pages read; conservative values the user can raise.
  {
    ids: ['glm-5.2', 'glm-5.1', 'glm-5', 'glm-4.7'],
    formats: ['openai_chat'],
    hosts: ['bigmodel.cn', 'z.ai'],
    fields: { contextTokens: 128_000, maxOutputTokens: 32_768, reasoningLevels: ['off', 'on'], reasoningMapping: OFF_ON_THINKING, extraBody: json({ tool_stream: true }) },
  },
  {
    ids: ['glm-5v-turbo'],
    formats: ['openai_chat'],
    hosts: ['bigmodel.cn', 'z.ai'],
    fields: { contextTokens: 200_000, maxOutputTokens: 128_000, image: true, reasoningLevels: ['off', 'on'], reasoningMapping: OFF_ON_THINKING, extraBody: json({ tool_stream: true }) },
  },
  // Thinking levels per Google's thinking guide (aistudio.google.com/docs/thinking): only 3 Flash Preview takes
  // `minimal`. 3.1 Flash-Lite is not listed there; it keeps the levels of the other Flash models.
  {
    ids: ['gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemini-3.1-flash-lite'],
    formats: ['gemini'],
    fields: { contextTokens: 1_048_576, maxOutputTokens: 65_536, image: true, pdf: true, webSearch: true, reasoningLevels: ['low', 'medium', 'high'], reasoningMapping: GEMINI_MAPPING },
  },
  {
    ids: ['gemini-3-flash-preview'],
    formats: ['gemini'],
    fields: { contextTokens: 1_048_576, maxOutputTokens: 65_536, image: true, pdf: true, webSearch: true, reasoningLevels: ['minimal', 'low', 'medium', 'high'], reasoningMapping: GEMINI_MAPPING },
  },
];

/** The recommended values for a model id at a Base URL in a format, and whether the table knows it. */
export function recommendedModel(id: string, baseUrl: string, format: ChatApiFormat): { fields: ChatModelFields; known: boolean } {
  const host = baseUrl.toLowerCase();
  const key = id.trim().toLowerCase();
  const hit = KNOWN.find((k) => k.ids.includes(key) && k.formats.includes(format) && (!k.hosts || k.hosts.some((h) => host.includes(h))));
  return { fields: { displayName: id, ...CONSERVATIVE_MODEL, ...(hit?.fields ?? {}) }, known: !!hit };
}

export function presetById(id: string | null | undefined): ChatPreset | undefined {
  return id ? CHAT_PRESETS.find((p) => p.id === id) : undefined;
}

/** Whether a Gemini-format Base URL is Vertex AI (project / location paths) rather than the Gemini API. */
export function isVertexUrl(baseUrl: string): boolean {
  try {
    return /(^|[.-])aiplatform\.googleapis\.com$/i.test(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

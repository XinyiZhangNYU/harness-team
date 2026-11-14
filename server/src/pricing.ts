/**
 * API list prices for runtimes that report tokens but no cost (Codex, Antigravity) and for chat members whose model has
 * no price of its own. Claude Code reports its own estimate, which is used as is. Rates are USD per 1M tokens, standard
 * tier, short context, as published by the model vendors:
 *   OpenAI     https://developers.openai.com/api/docs/pricing  (checked 2026-11-07; ≤272K input tokens per request;
 *                                                              cache write = 30-minute write)
 *   Google     https://aistudio.google.com/docs/pricing        (checked 2026-11-10; paid tier, ≤200K prompts; implicit
 *                                                              caching has no write fee, so cache writes count as input;
 *                                                              storage fees are left out)
 *   Anthropic  https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-11-07; cache write = 5-minute write)
 *   DeepSeek   https://api-docs.deepseek.com/quick_start/pricing (checked 2026-11-10; half price off-peak, see
 *                                                              `deepSeekPeak`; no cache write fee)
 *   Zhipu GLM  https://docs.z.ai/guides/overview/pricing      (checked 2026-11-10; the USD list price of Z.ai, also used
 *                                                              for open.bigmodel.cn, which bills in CNY at its own rates;
 *                                                              cache storage is free for now and left out)
 * Antigravity also offers Claude models (priced at Anthropic's list price) and GPT-OSS 120B, which has no first-party
 * price and stays unpriced. Usage is summed per turn, not per request, so long-context surcharges cannot be applied: the
 * estimate is a lower bound for very long prompts.
 */

export interface TokenRate {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export interface PricedTokens {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

/**
 * `until` is the first local date (YYYY-MM-DD) the rate no longer applies; the last period has none. `offPeak` is the
 * rate outside the vendor's peak hours (DeepSeek); `rate` is then the peak rate.
 */
type Period = { until?: string; rate: TokenRate; offPeak?: TokenRate };

const r = (input: number, output: number, cacheRead: number, cacheWrite = input): TokenRate => ({ input, output, cacheRead, cacheWrite });

const OPENAI: Record<string, Period[]> = {
  'gpt-6-astra': [{ rate: r(10, 50, 1, 12.5) }],
  'gpt-6.1-sol': [{ rate: r(2, 10, 0.1, 2.5) }],
  'gpt-6.1-terra': [{ rate: r(1, 5, 0.05, 1.25) }],
  'gpt-6-luna': [{ rate: r(0.1, 0.5, 0.01, 0.125) }],
  'gpt-6-sol': [{ rate: r(2, 10, 0.2, 2.5) }],
  'gpt-5.6-sol': [{ rate: r(4, 20, 0.4, 5) }],
  'gpt-5.6-terra': [{ rate: r(2, 12, 0.2, 2.5) }],
  'gpt-5.6-luna': [{ rate: r(0.2, 1.2, 0.02, 0.25) }],
  'gpt-5.5': [{ rate: r(5, 30, 0.5) }],
  'gpt-5.4': [{ rate: r(2.5, 15, 0.25) }],
  'gpt-5.4-mini': [{ rate: r(0.75, 4.5, 0.075) }],
  'gpt-5.4-nano': [{ rate: r(0.2, 1.25, 0.02) }],
  'gpt-5.3-codex': [{ rate: r(1.75, 14, 0.175) }],
  'gpt-5.2': [{ rate: r(1.75, 14, 0.175) }],
  'gpt-5.1': [{ rate: r(1.25, 10, 0.125) }],
  'gpt-5': [{ rate: r(1.25, 10, 0.125) }],
  'gpt-5-mini': [{ rate: r(0.25, 2, 0.025) }],
  'gpt-5-nano': [{ rate: r(0.05, 0.4, 0.005) }],
};

const GEMINI: Record<string, Period[]> = {
  'gemini-4-argon': [{ until: '2026-12-01', rate: r(2, 10, 0.1) }, { rate: r(4, 20, 0.2) }],
  'gemini-4-carbon': [{ until: '2026-12-01', rate: r(2, 10, 0.1) }, { rate: r(4, 20, 0.2) }],
  'gemini-3.8-flash': [{ until: '2027-01-01', rate: r(0.75, 3.75, 0.075) }, { rate: r(1.5, 7.5, 0.15) }],
  'gemini-3.6-flash': [{ until: '2027-01-01', rate: r(0.75, 3.75, 0.075) }, { rate: r(1.5, 7.5, 0.15) }],
  'gemini-3.5-flash-lite': [{ rate: r(0.3, 2.5, 0.03) }],
  'gemini-3.1-flash-lite': [{ rate: r(0.25, 1.5, 0.025) }],
  'gemini-3.1-pro-preview': [{ rate: r(2, 12, 0.2) }],
  'gemini-3-flash-preview': [{ rate: r(0.5, 3, 0.05) }],
};

// Peak rates; off-peak is half (see deepSeekPeak). deepseek-v4-flash is the retired name, billed as deepseek-flash.
const DEEPSEEK_FLASH: Period[] = [{ rate: r(0.3, 1.2, 0.006), offPeak: r(0.15, 0.6, 0.003) }];
const DEEPSEEK: Record<string, Period[]> = {
  'deepseek-flash': DEEPSEEK_FLASH,
  'deepseek-v4-flash': DEEPSEEK_FLASH,
  'deepseek-v4-pro': [{ rate: r(1.32, 3.96, 0.044), offPeak: r(0.66, 1.98, 0.022) }],
};

const GLM: Record<string, Period[]> = {
  'glm-5.3': [{ rate: r(1.4, 4.4, 0.26) }],
  'glm-5.2': [{ rate: r(1.4, 4.4, 0.26) }],
  'glm-5.1': [{ rate: r(1.4, 4.4, 0.26) }],
  'glm-5': [{ rate: r(1, 3.2, 0.2) }],
  'glm-5.3-flash': [{ rate: r(0.15, 0.5, 0.03) }],
  'glm-5.3-flashx': [{ rate: r(0.37, 1.25, 0.075) }],
  'glm-4.7': [{ rate: r(0.6, 2.2, 0.11) }],
  'glm-4.6': [{ rate: r(0.6, 2.2, 0.11) }],
  'glm-4.6v': [{ rate: r(0.3, 0.9, 0.05) }],
  'glm-4.5': [{ rate: r(0.6, 2.2, 0.11) }],
  'glm-4.5-air': [{ rate: r(0.2, 1.1, 0.03) }],
};

/**
 * DeepSeek's peak hours: 01:00-04:00 and 06:00-10:00 UTC (09:00-12:00 and 14:00-18:00 Beijing time), Monday to Friday.
 * Chinese public holidays are off-peak but not known here, so they are priced at the peak rate (an upper bound).
 */
export function deepSeekPeak(at: Date): boolean {
  const day = at.getUTCDay();
  const h = at.getUTCHours();
  return day >= 1 && day <= 5 && ((h >= 1 && h < 4) || (h >= 6 && h < 10));
}

const ANTHROPIC: Record<string, Period[]> = {
  // Claude 5.x list prices from Anthropic's model table (cached 2026-11-03); Haiku 5.5 is the ≤100K-prompt rate, and
  // its cache-read rate (not listed) is taken at the usual 0.1× input.
  'claude-fable-5-2': [{ rate: r(8, 40, 0.2, 10) }],
  'claude-fable-5-1': [{ rate: r(10, 50, 1, 12.5) }],
  'claude-opus-5-5': [{ rate: r(4, 20, 0.2, 5) }],
  'claude-sonnet-5-5': [{ rate: r(2, 10, 0.1, 2.5) }],
  'claude-haiku-5-5': [{ rate: r(0.1, 0.5, 0.01, 0.125) }],
  'claude-opus-4-6': [{ rate: r(5, 25, 0.5, 6.25) }],
  'claude-opus-4-5': [{ rate: r(5, 25, 0.5, 6.25) }],
  'claude-sonnet-4-6': [{ rate: r(3, 15, 0.3, 3.75) }],
  'claude-sonnet-4-5': [{ rate: r(3, 15, 0.3, 3.75) }],
};

const TABLES: Record<string, Record<string, Period[]>[]> = {
  codex: [OPENAI],
  antigravity: [GEMINI, ANTHROPIC],
  // Chat members: only when the model has no price of its own set in its provider (a relay may bill differently).
  chat: [OPENAI, GEMINI, ANTHROPIC, DEEPSEEK, GLM],
};

/**
 * Price multiplier of a faster tier, by vendor (checked 2026-11-13): OpenAI fast (formerly priority) 2x and ultrafast
 * 6x of every token rate; Anthropic fast mode 2x (Opus 5.5 $8/$40, Fable 5.2 $16/$80); Gemini API priority 1.8x
 * (every listed model: e.g. Gemini 4 Argon $3.60/$18.00 against $2/$10). Tiers not listed here have no known price.
 */
const SPEED_FACTOR = new Map<Record<string, Period[]>, Record<string, number>>([
  [OPENAI, { fast: 2, priority: 2, ultrafast: 6 }],
  [ANTHROPIC, { fast: 2 }],
  [GEMINI, { priority: 1.8 }],
]);

/** Tier names the APIs answer with for the standard speed (OpenAI "default", Anthropic and Gemini "standard"). */
export const STANDARD_TIERS: ReadonlySet<string> = new Set(['default', 'standard', 'auto']);

/**
 * What a tier multiplies a model's standard rate by: 1 for the standard speed (null tier included), null when the tier
 * of this model has no known price (a provider the tables do not have, or a tier they do not list).
 */
export function speedFactor(runtimeKind: string, model: string, tier: string | null): number | null {
  if (!tier || STANDARD_TIERS.has(tier)) return 1;
  const key = priceModelKey(runtimeKind, model);
  for (const table of TABLES[runtimeKind] ?? []) {
    if (table[key]) return SPEED_FACTOR.get(table)?.[tier] ?? null;
  }
  return null;
}

/**
 * The table key for a model id as the runtime names it. Antigravity folds the Thinking level or mode into some ids
 * ("gemini-3.8-flash-high", "claude-opus-4-6-thinking"); the price does not depend on it.
 */
export function priceModelKey(runtimeKind: string, model: string): string {
  const m = model.trim().toLowerCase();
  if (runtimeKind !== 'antigravity') return m;
  return m.replace(/-(minimal|low|medium|high)$/, '').replace(/-thinking$/, '');
}

/**
 * The list rate for a model on a local date (YYYY-MM-DD), or null when the table has no price for it. With the moment
 * `at`, an off-peak rate applies outside peak hours; without it the peak rate does.
 */
export function listRate(runtimeKind: string, model: string | null, date: string, at?: Date): TokenRate | null {
  if (!model) return null;
  const key = priceModelKey(runtimeKind, model);
  for (const table of TABLES[runtimeKind] ?? []) {
    const periods = table[key];
    if (!periods) continue;
    const p = periods.find((x) => !x.until || date < x.until) ?? periods[periods.length - 1]!;
    return p.offPeak && at && !deepSeekPeak(at) ? p.offPeak : p.rate;
  }
  return null;
}

/** The local date (YYYY-MM-DD) of a moment, as the price periods count it. */
export function localDate(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** USD at list price for tokens used on `date` (at the moment `at`, when known); null when the model has no price here. */
export function estimateCostUsd(runtimeKind: string, model: string | null, date: string, t: PricedTokens, at?: Date): number | null {
  const rate = listRate(runtimeKind, model, date, at);
  if (!rate) return null;
  return (t.input * rate.input + t.cacheRead * rate.cacheRead + t.cacheWrite * rate.cacheWrite + t.output * rate.output) / 1_000_000;
}

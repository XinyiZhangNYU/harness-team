/**
 * Claude Code usage recorded before the per-process fix (migration 38). A long-lived `claude -p` process reports
 * `modelUsage` and `total_cost_usd` as totals since it started, and each of its turns was stored as if those totals
 * were the turn's own: within one process, a member's records for one model only grow. This turns such a run back
 * into what each turn added.
 *
 * It is an estimate: when a process restarted was never recorded. A record is taken as a continuation of the one
 * before it (same chat, member and model) when none of its token counts and not its cost is smaller; any smaller
 * value means a new process, and that record is kept as it is. A first turn of a new process that happens to be at
 * least as large in every count is subtracted by mistake; a turn with two queries (a background agent) was stored as
 * the sum of two totals and usually reads as a restart, so it stays high.
 */

export interface ClaudeUsageRow {
  id: number;
  room_id: string;
  agent_id: string;
  model: string | null;
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cost_usd: number | null;
}

export interface ClaudeUsageFix {
  id: number;
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cost_usd: number | null;
}

const COUNTS = ['input_tokens', 'cache_read_tokens', 'cache_write_tokens', 'output_tokens', 'reasoning_tokens'] as const;

/** The records to rewrite, given every Claude Code record with known token counts in any order. */
export function claudeUsageCorrections(rows: ClaudeUsageRow[]): ClaudeUsageFix[] {
  const groups = new Map<string, ClaudeUsageRow[]>();
  for (const r of rows) {
    const key = JSON.stringify([r.room_id, r.agent_id, r.model]);
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }
  const fixes: ClaudeUsageFix[] = [];
  for (const g of groups.values()) {
    g.sort((a, b) => a.id - b.id);
    for (let i = 1; i < g.length; i++) {
      const prev = g[i - 1]!, cur = g[i]!;
      if (COUNTS.some((k) => cur[k] < prev[k])) continue;
      if ((cur.cost_usd == null) !== (prev.cost_usd == null)) continue;
      if (cur.cost_usd != null && cur.cost_usd < prev.cost_usd!) continue;
      const cost = cur.cost_usd == null ? null : Math.max(0, Math.round((cur.cost_usd - prev.cost_usd!) * 1e9) / 1e9);
      fixes.push({
        id: cur.id,
        input_tokens: cur.input_tokens - prev.input_tokens,
        cache_read_tokens: cur.cache_read_tokens - prev.cache_read_tokens,
        cache_write_tokens: cur.cache_write_tokens - prev.cache_write_tokens,
        output_tokens: cur.output_tokens - prev.output_tokens,
        reasoning_tokens: cur.reasoning_tokens - prev.reasoning_tokens,
        cost_usd: cost,
      });
    }
  }
  return fixes.sort((a, b) => a.id - b.id);
}

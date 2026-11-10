import type { RuntimeKind, RuntimeModelOption } from '../../shared/protocol.ts';

type Version = { family: string; n: number };

/** "claude-fable-5-2", "claude-haiku-4-5-20251001", "claude-opus-5[1m]" → family and a comparable version. */
function fromId(id: string | null | undefined): Version | null {
  const m = id ? /claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(id) : null;
  return m ? { family: m[1]!.toLowerCase(), n: Number(m[2]) * 1000 + Number(m[3] ?? 0) } : null;
}

/** "Fable 5.1" → family and version (an alias whose resolved model is not reported). */
function fromName(name: string): Version | null {
  const m = /^([A-Za-z]+)\s+(\d+)(?:\.(\d+))?/.exec(name.trim());
  return m ? { family: m[1]!.toLowerCase(), n: Number(m[2]) * 1000 + Number(m[3] ?? 0) } : null;
}

const isPinned = (id: string) => id.startsWith('claude-');

/**
 * Claude Code lists aliases ("opus") first, then pinned full ids. An alias can lag behind a newer version of its own
 * family ("fable" still on Fable 5.1 when Fable 5.2 is out): that newer version is listed with the aliases, just before
 * them. Other runtimes have no pinned group.
 */
export function groupModels<T extends Pick<RuntimeModelOption, 'id' | 'displayName' | 'resolvedModel'>>(
  kind: RuntimeKind,
  models: T[],
): { main: T[]; pinned: T[] } {
  if (kind !== 'claude') return { main: models, pinned: [] };
  const aliases = models.filter((m) => !isPinned(m.id));
  const aliasVersion = new Map<string, number>();
  for (const a of aliases) {
    const v = fromId(a.resolvedModel) ?? fromName(a.displayName);
    if (v) aliasVersion.set(v.family, Math.max(aliasVersion.get(v.family) ?? 0, v.n));
  }
  // Per family, the newest pinned version that is newer than every alias of that family.
  const ahead = new Map<string, { m: T; n: number }>();
  for (const m of models.filter((x) => isPinned(x.id))) {
    const v = fromId(m.id);
    const alias = v ? aliasVersion.get(v.family) : undefined;
    if (!v || alias === undefined || v.n <= alias) continue;
    const cur = ahead.get(v.family);
    if (!cur || v.n > cur.n) ahead.set(v.family, { m, n: v.n });
  }
  const promoted = new Set([...ahead.values()].map((x) => x.m));
  const main: T[] = [];
  for (const a of aliases) {
    const v = fromId(a.resolvedModel) ?? fromName(a.displayName);
    const p = v && ahead.get(v.family);
    if (p && !main.includes(p.m)) main.push(p.m);
    main.push(a);
  }
  return { main, pinned: models.filter((m) => isPinned(m.id) && !promoted.has(m)) };
}

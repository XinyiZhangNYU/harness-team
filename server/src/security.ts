import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';

export const TOKEN_COOKIE = 'ht_token';

/** Loads the local access token from the data dir, creating it on first run. */
export function loadOrCreateToken(dataDir: string): string {
  const file = join(dataDir, 'access-token');
  if (existsSync(file)) {
    const t = readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(t)) return t;
  }
  mkdirSync(dataDir, { recursive: true });
  const token = randomBytes(32).toString('hex');
  writeFileSync(file, token + '\n', { mode: 0o600 });
  return token;
}

export function tokenEquals(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export interface AccessPolicy {
  /** Host header values we accept, e.g. "127.0.0.1:4317" and "localhost:4317" (DNS-rebinding defence). */
  allowedHosts: Set<string>;
  /** Exact origins we accept from browsers, e.g. "http://127.0.0.1:4317". */
  allowedOrigins: Set<string>;
  token: string;
}

export function policyFor(port: number, token: string): AccessPolicy {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  return {
    allowedHosts: new Set(hosts),
    allowedOrigins: new Set(hosts.map((h) => `http://${h}`)),
    token,
  };
}

export type AccessCheck = { ok: true } | { ok: false; status: number; reason: string };

export function checkHost(req: IncomingMessage, policy: AccessPolicy): AccessCheck {
  const host = (req.headers.host ?? '').toLowerCase();
  if (!policy.allowedHosts.has(host)) return { ok: false, status: 421, reason: 'host not allowed' };
  return { ok: true };
}

function presentedToken(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  return parseCookies(req.headers.cookie)[TOKEN_COOKIE];
}

/**
 * API access: allowed Host, Origin (if the client sent one) must be ours, token required,
 * and state-changing requests must be JSON (blocks cross-site simple form posts).
 */
/**
 * `binary`: the endpoint takes raw file bytes (attachment upload) and also accepts application/octet-stream. Like
 * application/json it is not a CORS-safelisted type, so a cross-site page still cannot send it without a preflight.
 */
export function checkApi(req: IncomingMessage, policy: AccessPolicy, opts: { binary?: boolean } = {}): AccessCheck {
  const host = checkHost(req, policy);
  if (!host.ok) return host;
  const origin = req.headers.origin;
  if (origin !== undefined && !policy.allowedOrigins.has(origin)) {
    return { ok: false, status: 403, reason: 'origin not allowed' };
  }
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') {
    return { ok: false, status: 403, reason: 'cross-site request blocked' };
  }
  if (!tokenEquals(presentedToken(req), policy.token)) {
    return { ok: false, status: 401, reason: 'missing or invalid access token' };
  }
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    const ct = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (ct !== 'application/json' && !(opts.binary && ct === 'application/octet-stream')) {
      return { ok: false, status: 415, reason: 'content-type must be application/json' };
    }
  }
  return { ok: true };
}

/** WebSocket upgrade: browsers always send Origin on WS handshakes, so it is mandatory here. */
export function checkWebSocket(req: IncomingMessage, policy: AccessPolicy): AccessCheck {
  const host = checkHost(req, policy);
  if (!host.ok) return host;
  const origin = req.headers.origin;
  if (!origin || !policy.allowedOrigins.has(origin)) return { ok: false, status: 403, reason: 'origin not allowed' };
  if (!tokenEquals(presentedToken(req), policy.token)) {
    return { ok: false, status: 401, reason: 'missing or invalid access token' };
  }
  return { ok: true };
}

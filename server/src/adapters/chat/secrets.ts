import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Encrypts provider keys with the operating system's key store (Electron safeStorage: DPAPI on Windows, the Keychain on
 * macOS). The Core runs in a utility process without safeStorage, so the desktop shell does the work and answers over
 * the parent port. Without the desktop shell (running from source) there is no box: only environment variables work.
 */
export interface SecretBox {
  encrypt(plain: string): Promise<Buffer>;
  decrypt(cipher: Buffer): Promise<string>;
}

type Port = { on(e: 'message', f: (ev: { data: unknown }) => void): void; postMessage(m: unknown): void };

const TIMEOUT_MS = 10_000;

/** A SecretBox served by the desktop shell over the utility process's parent port (see desktop/electron/main.cjs). */
export function parentPortSecretBox(port: Port): SecretBox {
  let next = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  port.on('message', (ev) => {
    const m = ev.data as { type?: string; id?: number; ok?: boolean; data?: string; error?: string } | null;
    if (!m || m.type !== 'secret-result' || typeof m.id !== 'number') return;
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.ok && typeof m.data === 'string') p.resolve(m.data);
    else p.reject(new Error(m.error || 'the system key store refused the request'));
  });
  const call = (op: 'encrypt' | 'decrypt', data: string) =>
    new Promise<string>((resolve, reject) => {
      const id = next++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('the desktop app did not answer the key request'));
      }, TIMEOUT_MS);
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      port.postMessage({ type: 'secret', id, op, data });
    });
  return {
    encrypt: async (plain) => Buffer.from(await call('encrypt', plain), 'base64'),
    // The plain key comes back only to be used in a request header; it is never logged or stored.
    decrypt: async (cipher) => call('decrypt', cipher.toString('base64')),
  };
}

/** Encrypted keys, one file per provider in <dataDir>/secrets (never in the database, the repository or a log). */
export class KeyFiles {
  private readonly dir: string;
  private readonly cache = new Map<string, string>();

  readonly box: SecretBox | null;

  constructor(dataDir: string, box: SecretBox | null) {
    this.box = box;
    this.dir = join(dataDir, 'secrets');
  }

  private file(providerId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(providerId)) throw new Error('invalid provider id');
    return join(this.dir, `chat-${providerId}.bin`);
  }

  async save(providerId: string, key: string): Promise<void> {
    if (!this.box) throw new Error('no key store');
    const cipher = await this.box.encrypt(key);
    mkdirSync(this.dir, { recursive: true });
    const f = this.file(providerId);
    writeFileSync(`${f}.tmp`, cipher, { mode: 0o600 });
    renameSync(`${f}.tmp`, f);
    this.cache.set(providerId, key);
  }

  async load(providerId: string): Promise<string | null> {
    const hit = this.cache.get(providerId);
    if (hit !== undefined) return hit;
    if (!this.box) return null;
    const f = this.file(providerId);
    if (!existsSync(f)) return null;
    const key = await this.box.decrypt(readFileSync(f));
    this.cache.set(providerId, key);
    return key;
  }

  remove(providerId: string): void {
    this.cache.delete(providerId);
    rmSync(this.file(providerId), { force: true });
  }
}

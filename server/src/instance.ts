import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { L, NoticeError } from '../../shared/notices.ts';
import { pathKey } from './path-key.ts';

/**
 * One Core per data directory. Two Cores on the same database would each think they own the agents' native
 * sessions and the shared-workspace locks (those locks live in process memory), so the second start is refused.
 *
 * Ownership is an operating-system file lock, not a pid file: the Core holds an open SQLite EXCLUSIVE transaction
 * on `core.lock.db` for as long as it runs (LockFileEx on Windows, fcntl on POSIX). Acquiring it is a single
 * atomic step, so two starters can never both win, and there is no "half-written lock" moment another starter
 * could misread. The operating system drops the lock when the owner process exits for any reason (clean exit,
 * crash, kill), so a lock is only ever taken over once its owner is really gone; a pid reused by an unrelated
 * process cannot block a start.
 *
 * `core.lock` next to it is informational only (owner pid and URL for the refusal message). It is written by the
 * lock holder after the lock is held, replaced atomically, and removed on release; a leftover copy from a crashed
 * Core is simply overwritten.
 */
export interface DataDirLock {
  /** The informational owner file (`core.lock`). */
  file: string;
  release(): void;
}

export class DataDirInUseError extends NoticeError {
  readonly pid: number | null;
  readonly url: string | null;
  constructor(pid: number | null, url: string | null) {
    super(
      L(
        '{who}同一数据目录只能运行一个实例；请先关闭它，或用 --data-dir 指定其他目录。',
        '{who} Only one instance can use a data folder; close the other one first, or choose another folder with --data-dir.',
        {
          who: pid
            ? L('数据目录已被另一个 Harness Team 进程使用（pid {pid}{url}）。', 'The data folder is already used by another Harness Team process (pid {pid}{url}).', {
                pid,
                url: url ? L('，{u}', ', {u}', { u: url }) : null,
              })
            : L('数据目录已被另一个 Harness Team 进程使用（它可能正在启动）。', 'The data folder is already used by another Harness Team process (it may be starting).'),
        },
      ),
    );
    this.name = 'DataDirInUseError';
    this.pid = pid;
    this.url = url;
  }
}

// Keeps the lock connections reachable for the life of the process.
const held = new Set<DatabaseSync>();

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
/** How long a start keeps retrying a lock that is busy before reporting the data directory as in use. */
const LOCK_WAIT_MS = 2000;

/**
 * Creates the data directory and, on macOS / Linux, keeps it private to this user (0700). It holds the chat history,
 * attachments and backups, whose files get the default umask (usually readable by every user). A folder that already
 * exists is narrowed only when it belongs to this user and is not the home folder. Best effort: a failure leaves the
 * folder as it was.
 */
export function ensurePrivateDataDir(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') return;
  try {
    const st = statSync(dataDir);
    if (st.mode & 0o077 && st.uid === process.getuid?.() && pathKey(dataDir) !== pathKey(homedir())) chmodSync(dataDir, 0o700);
  } catch {
    // Left as it was; the access token itself is always written 0600.
  }
}

export function acquireDataDirLock(dataDir: string, info: { url?: string | null } = {}): DataDirLock {
  ensurePrivateDataDir(dataDir);
  const file = join(dataDir, 'core.lock');
  const lockFile = join(dataDir, 'core.lock.db');
  // SQLite reaches an exclusive lock through a brief shared step, so starters that arrive at the same instant can
  // all be turned away once, with nobody holding the lock (and creating the file concurrently can fail once on
  // Windows). A failed attempt closes its connection, which drops any partial lock, then retries after a random
  // pause. Only a lock that stays held for the whole window is reported as in use. Exclusivity itself never
  // depends on this loop: the operating system lets at most one connection hold the lock.
  const deadline = Date.now() + LOCK_WAIT_MS;
  let lockDb: DatabaseSync;
  for (;;) {
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(lockFile, { timeout: 0 });
      // Nothing is ever written; an in-memory journal leaves no core.lock.db-journal behind after a hard kill.
      db.exec('PRAGMA journal_mode = MEMORY');
      db.exec('BEGIN EXCLUSIVE');
      lockDb = db;
      break;
    } catch (e) {
      try {
        db?.close();
      } catch {
        // ignore
      }
      if (Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15 + Math.floor(Math.random() * 35));
        continue;
      }
      const code = (e as { errcode?: number }).errcode;
      if (code === SQLITE_BUSY || code === SQLITE_LOCKED) {
        // Held by a live process. Its owner file may not be written yet (it is starting), or still be the one a
        // crashed Core left: then the pid is unknown, and the start is refused all the same.
        const owner = readOwner(file);
        const live = owner && pidAlive(owner.pid) ? owner : null;
        throw new DataDirInUseError(live?.pid ?? null, live?.url ?? null);
      }
      throw new NoticeError(L('无法获取数据目录锁 {file}：{error}', 'Could not lock the data folder ({file}): {error}', { file: lockFile, error: (e as Error).message }));
    }
  }
  held.add(lockDb);
  writeOwner(file, { pid: process.pid, url: info.url ?? null, startedAt: new Date().toISOString() });
  let released = false;
  return {
    file,
    release() {
      if (released) return;
      released = true;
      // Owner file first, while the lock is still held, so nobody can be writing a new one yet.
      if (readOwner(file)?.pid === process.pid) {
        try {
          unlinkSync(file);
        } catch {
          // ignore
        }
      }
      try {
        lockDb.exec('ROLLBACK');
      } catch {
        // ignore
      }
      lockDb.close();
      held.delete(lockDb);
    },
  };
}

/** Records the listening URL once it is known (shown to a second instance that is refused). */
export function updateLockUrl(lock: DataDirLock, url: string) {
  try {
    const owner = readOwner(lock.file);
    if (owner?.pid !== process.pid) return;
    writeOwner(lock.file, { ...owner, url });
  } catch {
    // informational only
  }
}

// Written to a private temp file and renamed into place, so a reader normally sees the old or the new content. Only
// the lock holder writes it. Windows refuses the rename while another starter is reading the file; then retry
// briefly and finally write in place. It never fails the start: the lock itself is already held, and a reader that
// sees a partial file just reports the owner as unknown.
function writeOwner(file: string, owner: Record<string, unknown>) {
  const text = JSON.stringify(owner);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text);
    for (let i = 0; ; i++) {
      try {
        renameSync(tmp, file);
        return;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (i >= 20 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      // ignore
    }
    try {
      writeFileSync(file, text);
    } catch {
      // informational only
    }
  }
}

// Only used to word the refusal message; ownership itself is decided by the operating-system lock.
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readOwner(file: string): { pid: number; url: string | null; startedAt?: string } | null {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    return Number.isInteger(j.pid) && j.pid > 0
      ? { pid: j.pid, url: typeof j.url === 'string' ? j.url : null, startedAt: typeof j.startedAt === 'string' ? j.startedAt : undefined }
      : null;
  } catch {
    return null;
  }
}

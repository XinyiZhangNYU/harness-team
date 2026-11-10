import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { L, type Localized, type NoticeText, zhOf } from '../../../../shared/notices.ts';
import { redactForLog } from '../../redact.ts';

/**
 * One `claude -p --input-format stream-json --output-format stream-json` process.
 *
 * stdin/stdout carry newline-delimited JSON. Besides conversation messages the CLI speaks a small control
 * protocol on the same streams (`control_request` / `control_response` / `control_cancel_request`), which is
 * what the official Agent SDK uses for `initialize`, `interrupt` and `can_use_tool` permission prompts.
 */
export interface StreamJsonHandlers {
  /** Every parsed stdout line except responses to our own control requests. */
  onMessage(msg: any): void;
  onExit(reason: Localized): void;
}

export interface StreamJsonOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  protocolLog?: string;
  /** Kills the process tree rooted at pid. Default: `taskkill /T /F` on Windows, SIGKILL elsewhere. Tests replace it. */
  killTree?: (pid: number) => void;
}

export function defaultKillTree(pid: number): void {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
    return;
  }
  // macOS / Linux: the CLI was started as the leader of its own process group (detached), so the group takes its
  // children (tools, MCP servers, an npm wrapper's native binary) with it.
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

/** POSIX: start CLIs in their own process group so defaultKillTree can stop the whole tree. */
export const OWN_GROUP = process.platform !== 'win32';

export class ControlError extends Error {
  readonly notice: NoticeText | null;
  constructor(message: Localized) {
    super(zhOf(message));
    this.name = 'ControlError';
    this.notice = typeof message === 'string' ? null : message;
  }
}

export class StreamJsonProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private exited = false;
  private seq = 0;
  private readonly pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout }>();
  stderrTail = '';
  exitReason: Localized | null = null;

  private readonly command: string;
  private readonly args: string[];
  private readonly opts: StreamJsonOptions;
  private readonly handlers: StreamJsonHandlers;

  constructor(command: string, args: string[], opts: StreamJsonOptions, handlers: StreamJsonHandlers) {
    this.command = command;
    this.args = args;
    this.opts = opts;
    this.handlers = handlers;
  }

  get running(): boolean {
    return !!this.child && !this.exited;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  start(): void {
    this.log('spawn', { command: this.command, args: this.args, cwd: this.opts.cwd });
    const child = spawn(this.command, this.args, {
      cwd: this.opts.cwd,
      env: this.opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: OWN_GROUP,
    });
    this.child = child;
    child.stdin.on('error', () => {}); // surfaced through 'exit'
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => {
      this.stderrTail = (this.stderrTail + d).slice(-4000);
      this.log('stderr', d);
    });
    createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line));
    const onGone = (reason: NoticeText) => {
      if (this.exited) return;
      this.exited = true;
      const tail = this.stderrTail.trim();
      this.exitReason = tail ? L('{reason}：{tail}', '{reason}: {tail}', { reason, tail: tail.slice(-500) }) : reason;
      this.log('exit', zhOf(this.exitReason));
      for (const [, p] of this.pending) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(new ControlError(this.exitReason));
      }
      this.pending.clear();
      this.handlers.onExit(this.exitReason);
    };
    child.on('error', (e) => onGone(L('无法启动 {cmd}：{error}', 'Could not start {cmd}: {error}', { cmd: this.command, error: e.message })));
    // 'close' (not 'exit') so that every stdout line has been delivered before we report the exit.
    child.on('close', (code, signal) =>
      onGone(L('claude 进程已退出（code {code}{signal}）', 'The claude process exited (code {code}{signal})', { code: String(code ?? 'null'), signal: signal ? `, ${signal}` : null })),
    );
  }

  send(msg: unknown): void {
    if (!this.running) return;
    this.log('out', msg);
    this.child!.stdin.write(JSON.stringify(msg) + '\n');
  }

  /** Sends a control_request and resolves with the CLI's control_response payload. */
  control(request: Record<string, unknown>, timeoutMs = 30_000): Promise<any> {
    if (!this.running) return Promise.reject(new ControlError(this.exitReason ?? L('claude 进程未运行', 'The claude process is not running')));
    const request_id = `ht-${++this.seq}-${String(request.subtype ?? 'req')}`;
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(request_id);
              reject(new ControlError(L('{req} 在 {ms} ms 内未得到响应', '{req} got no response within {ms} ms', { req: String(request.subtype), ms: timeoutMs })));
            }, timeoutMs)
          : undefined;
      this.pending.set(request_id, { resolve, reject, timer });
      this.send({ type: 'control_request', request_id, request });
    });
  }

  /** Answers a control_request the CLI sent us (e.g. can_use_tool). */
  respond(requestId: string, response: unknown): void {
    this.send({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
  }

  respondError(requestId: string, error: string): void {
    this.send({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error } });
  }

  /** Closes stdin (the CLI exits on EOF when idle), then force-kills the process tree if it lingers. */
  async close(graceMs = 3000): Promise<void> {
    const child = this.child;
    if (!child || this.exited) return;
    const gone = new Promise<void>((r) => child.once('close', () => r()));
    child.stdin.end();
    if ((await Promise.race([gone.then(() => 'gone' as const), sleep(graceMs).then(() => 'timeout' as const)])) === 'timeout') {
      this.kill();
      await Promise.race([gone, sleep(2000)]);
    }
  }

  /**
   * Kills the tree and waits (bounded) until the process is gone.
   * Resolves true only when the process has actually exited; false means its state is unknown.
   */
  async terminate(waitMs = 3000): Promise<boolean> {
    const child = this.child;
    if (!child || this.exited) return true;
    const gone = new Promise<void>((r) => child.once('close', () => r()));
    this.kill();
    await Promise.race([gone, sleep(waitMs)]);
    return this.exited;
  }

  /** True once kill() was called: the process may still be exiting, but it must not be given more work. */
  killRequested = false;

  /** Immediate tree kill (used when continuing could bill the wrong account). */
  kill(): void {
    const child = this.child;
    if (!child || this.exited || !child.pid) return;
    this.killRequested = true;
    (this.opts.killTree ?? defaultKillTree)(child.pid);
  }

  private onLine(line: string) {
    if (!line.trim()) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      this.log('in-raw', line);
      return;
    }
    this.log('in', msg);
    if (msg?.type === 'control_response') {
      const r = msg.response ?? {};
      const p = this.pending.get(r.request_id);
      if (p) {
        this.pending.delete(r.request_id);
        if (p.timer) clearTimeout(p.timer);
        if (r.subtype === 'error') p.reject(new ControlError(String(r.error ?? 'control request failed')));
        else p.resolve(r.response ?? {});
        return;
      }
    }
    this.handlers.onMessage(msg);
  }

  private log(dir: string, msg: unknown) {
    if (!this.opts.protocolLog) return;
    try {
      // Redacted field by field (redactForLog), so the line stays valid JSON.
      const line = JSON.stringify({ t: new Date().toISOString(), pid: this.child?.pid, dir, msg: redactForLog(redact(msg)) });
      appendFileSync(this.opts.protocolLog, line + '\n');
    } catch {
      // logging must never break the protocol
    }
  }
}

/** Secrets in text (errors, stderr): see redact.ts. */
export { redactText as redactSecrets } from '../../redact.ts';

/** Image content blocks are logged by size only (never their bytes). */
function redactImages(msg: any): unknown {
  const content = msg?.message?.content;
  if (!Array.isArray(content) || !content.some((b: any) => b?.type === 'image')) return msg;
  return {
    ...msg,
    message: {
      ...msg.message,
      content: content.map((b: any) =>
        b?.type === 'image' && typeof b.source?.data === 'string'
          ? { ...b, source: { ...b.source, data: `[${b.source.data.length} base64 chars]` } }
          : b,
      ),
    },
  };
}

function redact(msg: any): unknown {
  msg = redactImages(msg);
  const acct = msg?.response?.response?.account;
  if (msg?.type !== 'control_response' || !acct || typeof acct !== 'object') return msg;
  return {
    ...msg,
    response: {
      ...msg.response,
      response: { ...msg.response.response, account: { ...acct, email: acct.email ? '[redacted]' : acct.email, organization: acct.organization ? '[redacted]' : acct.organization } },
    },
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

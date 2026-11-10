import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { defaultKillTree } from '../claude/process.ts';
import { redactForLog, redactText } from '../../redact.ts';

/** JSON-RPC request id as sent on the wire (Codex app-server uses numbers or strings). */
export type RpcId = number | string;

export class RpcError extends Error {
  readonly code: number | undefined;
  readonly data: unknown;
  /** The message is shown in the chat and stored: secrets a runtime echoes back (its stderr, its error) are removed. */
  constructor(message: string, code?: number, data?: unknown) {
    super(redactText(message));
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

export interface RpcHandlers {
  onNotification(method: string, params: any): void;
  /** Server -> client request. The handler must eventually call respond()/respondError() for `id`. */
  onServerRequest(id: RpcId, method: string, params: any): void;
  onExit(reason: string): void;
}

export interface JsonRpcProcessOptions {
  cwd?: string;
  protocolLog?: string;
  /** Child environment (default: this process's). */
  env?: NodeJS.ProcessEnv;
  /** Name used in errors, e.g. "app-server" (default) or "agy acp". */
  name?: string;
}

/**
 * Line-delimited JSON-RPC 2.0 over a child process's stdio, as used by `codex app-server` and ACP agents (`agy acp`).
 * Optionally appends every line in both directions to a local JSONL protocol log (receipts).
 */
export class JsonRpcProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<RpcId, { resolve: (v: any) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout }>();
  private stderrTail = '';
  private exited = false;

  private readonly command: string;
  private readonly args: string[];
  private readonly handlers: RpcHandlers;
  private readonly opts: JsonRpcProcessOptions;

  constructor(command: string, args: string[], handlers: RpcHandlers, opts: JsonRpcProcessOptions = {}) {
    this.command = command;
    this.args = args;
    this.handlers = handlers;
    this.opts = opts;
  }

  get running(): boolean {
    return !!this.child && !this.exited;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  start(): void {
    const child = spawn(this.command, this.args, {
      cwd: this.opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: this.opts.env ?? process.env,
      // POSIX: its own process group, so a forced close also stops what app-server started.
      detached: process.platform !== 'win32',
    });
    this.child = child;
    child.stdin.on('error', () => {}); // surfaced through 'exit'
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => {
      this.stderrTail = (this.stderrTail + d).slice(-4000);
      this.log('stderr', d);
    });
    createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line));
    const onGone = (reason: string) => {
      if (this.exited) return;
      this.exited = true;
      const err = new RpcError(`${reason}${this.stderrTail ? `: ${this.stderrTail.trim().slice(-500)}` : ''}`);
      for (const [, p] of this.pending) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
      this.handlers.onExit(err.message);
    };
    child.on('error', (e) => onGone(`failed to start ${this.command}: ${e.message}`));
    child.on('exit', (code, signal) => onGone(`${this.opts.name ?? 'app-server'} exited (code ${code ?? 'null'}${signal ? `, ${signal}` : ''})`));
  }

  request<T = any>(method: string, params: unknown, timeoutMs = 60_000): Promise<T> {
    if (!this.running) return Promise.reject(new RpcError(`${this.opts.name ?? 'app-server'} is not running`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs) : undefined;
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params });
  }

  respond(id: RpcId, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  respondError(id: RpcId, code: number, message: string): void {
    this.write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  /** Closes stdin (the server exits on EOF), then force-kills the process tree if it lingers. */
  async close(graceMs = 3000): Promise<void> {
    const child = this.child;
    if (!child || this.exited) return;
    const gone = new Promise<void>((r) => child.once('exit', () => r()));
    child.stdin.end();
    const timer = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), graceMs));
    if ((await Promise.race([gone, timer])) === 'timeout' && !this.exited && child.pid) {
      defaultKillTree(child.pid);
      await Promise.race([gone, new Promise((r) => setTimeout(r, 2000))]);
    }
  }

  private write(msg: unknown) {
    if (!this.running) return;
    this.log('out', msg);
    this.child!.stdin.write(JSON.stringify(msg) + '\n');
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
    if (msg.id !== undefined && msg.id !== null && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (p.timer) clearTimeout(p.timer);
      if (msg.error) p.reject(new RpcError(String(msg.error.message ?? 'error'), msg.error.code, msg.error.data));
      else p.resolve(msg.result);
      return;
    }
    if (typeof msg.method !== 'string') return;
    if (msg.id !== undefined && msg.id !== null) this.handlers.onServerRequest(msg.id, msg.method, msg.params ?? {});
    else this.handlers.onNotification(msg.method, msg.params ?? {});
  }

  private log(dir: string, msg: unknown) {
    if (!this.opts.protocolLog) return;
    try {
      // Redacted field by field (redactForLog), so the line stays valid JSON.
      appendFileSync(this.opts.protocolLog, JSON.stringify({ t: new Date().toISOString(), dir, msg: redactForLog(msg) }) + '\n');
    } catch {
      // logging must never break the protocol
    }
  }
}

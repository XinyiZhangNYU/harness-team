import { delimiter } from 'node:path';
import { L, type Localized, type NoticeText } from '../../shared/notices.ts';
import { type AntigravityAdapterOptions, type AntigravityDetection, detectAntigravity } from './adapters/antigravity/adapter.ts';
import type { ClaudeAdapterOptions } from './adapters/claude/adapter.ts';
import { type ClaudeDetection, detectClaude } from './adapters/claude/detect.ts';
import { extraBinDirs, loginShellPath, mergePath } from './adapters/cli-path.ts';
import { type CodexAdapterOptions, type CodexDetection, detectCodex } from './adapters/codex/adapter.ts';
import { type DshAdapterOptions, type DshDetection, detectDsh } from './adapters/dsh/adapter.ts';
import { type OpenCodeAdapterOptions, type OpenCodeDetection, detectOpenCode } from './adapters/opencode/adapter.ts';
import { type CursorAdapterOptions, type CursorDetection, detectCursor } from './adapters/cursor/adapter.ts';
import { type GrokAdapterOptions, type GrokDetection, detectGrok } from './adapters/grok/adapter.ts';
import { type KimiAdapterOptions, type KimiDetection, detectKimi } from './adapters/kimi/adapter.ts';
import { type CopilotAdapterOptions, type CopilotDetection, detectCopilot } from './adapters/copilot/adapter.ts';
import { redactText } from './redact.ts';

/**
 * Detection of the official harness CLIs, at start and again on request (Check again in the add-member form), so a
 * CLI installed or logged in while Harness Team runs is picked up without a restart. None of them is required.
 */

/** Found (an adapter can be built, possibly with a `problem`), or missing with the reason. */
export type Detected<O> = { options: O; missing?: undefined } | { options?: undefined; missing: NoticeText };

export interface DetectedRuntimes {
  codex: Detected<Omit<CodexAdapterOptions, 'clientVersion'>> & { detection: CodexDetection | null };
  claude: Detected<ClaudeAdapterOptions> & { detection: ClaudeDetection | null };
  antigravity: Detected<AntigravityAdapterOptions> & { detection: AntigravityDetection | null };
  dsh: Detected<DshAdapterOptions> & { detection: DshDetection | null };
  opencode: Detected<OpenCodeAdapterOptions> & { detection: OpenCodeDetection | null };
  cursor: Detected<CursorAdapterOptions> & { detection: CursorDetection | null };
  grok: Detected<GrokAdapterOptions> & { detection: GrokDetection | null };
  kimi: Detected<KimiAdapterOptions> & { detection: KimiDetection | null };
  copilot: Detected<CopilotAdapterOptions> & { detection: CopilotDetection | null };
}

export interface DetectOptions {
  codex: boolean;
  claude: boolean;
  /** Absent = true. */
  antigravity?: boolean;
  /** Absent = true. */
  dsh?: boolean;
  /** Absent = true. */
  opencode?: boolean;
  /** Absent = true. */
  cursor?: boolean;
  /** Absent = true. */
  grok?: boolean;
  /** Absent = true. */
  kimi?: boolean;
  /** Absent = true. */
  copilot?: boolean;
  codexProtocolLog?: string;
  claudeProtocolLog?: string;
  antigravityProtocolLog?: string;
  dshProtocolLog?: string;
  opencodeProtocolLog?: string;
  cursorProtocolLog?: string;
  grokProtocolLog?: string;
  kimiProtocolLog?: string;
  copilotProtocolLog?: string;
}

const notice = (x: Localized): NoticeText => (typeof x === 'string' ? L(x, x) : x);

/**
 * One harness's detection that fails unexpectedly makes only that harness unavailable, with the reason (secrets
 * removed): the others are still detected and the app still starts.
 */
async function isolated<T>(name: string, detect: () => Promise<T>): Promise<T> {
  try {
    return await detect();
  } catch (e) {
    const reason = redactText(((e as Error)?.message ?? String(e)).split('\n')[0] ?? 'error');
    return { command: null, error: L('检测 {name} 失败：{reason}', 'Detecting {name} failed: {reason}', { name, reason }) } as unknown as T;
  }
}

export async function detectRuntimes(o: DetectOptions): Promise<DetectedRuntimes> {
  await widenPath().catch(() => {});
  const [codex, claude, antigravity, dsh, opencode, cursor, grok, kimi, copilot] = await Promise.all([
    o.codex ? isolated('codex', () => detectCodex()) : null,
    o.claude ? isolated('claude', () => detectClaude()) : null,
    o.antigravity !== false ? isolated('agy', () => detectAntigravity()) : null,
    o.dsh !== false ? isolated('dsh', () => detectDsh()) : null,
    o.opencode !== false ? isolated('opencode', () => detectOpenCode()) : null,
    o.cursor !== false ? isolated('cursor-agent', () => detectCursor()) : null,
    o.grok !== false ? isolated('grok', () => detectGrok()) : null,
    o.kimi !== false ? isolated('kimi', () => detectKimi()) : null,
    o.copilot !== false ? isolated('copilot', () => detectCopilot()) : null,
  ]);
  return {
    codex: !codex
      ? { missing: L('已用 --no-codex 停用', 'Disabled with --no-codex'), detection: null }
      : !codex.command || codex.error
        ? { missing: notice(codex.error ?? L('未找到 codex', 'codex was not found')), detection: codex }
        : {
            options: {
              command: codex.command,
              argsPrefix: codex.argsPrefix ?? [],
              version: codex.version,
              loginStatus: codex.loginStatus,
              problem: codex.problem ?? null,
              billing: codex.billing ?? null,
              protocolLog: o.codexProtocolLog,
              redetect: () => detectCodex(),
            },
            detection: codex,
          },
    claude: !claude
      ? { missing: L('已用 --no-claude 停用', 'Disabled with --no-claude'), detection: null }
      : !claude.command || claude.error
        ? { missing: notice(claude.error ?? L('未找到 claude', 'claude was not found')), detection: claude }
        : {
            options: {
              command: claude.command,
              argsPrefix: claude.argsPrefix,
              version: claude.version,
              auth: claude.auth,
              problem: claude.problem,
              protocolLog: o.claudeProtocolLog,
            },
            detection: claude,
          },
    antigravity: !antigravity
      ? { missing: L('已用 --no-antigravity 停用', 'Disabled with --no-antigravity'), detection: null }
      : !antigravity.command || antigravity.error
        ? { missing: notice(antigravity.error ?? L('未找到 agy', 'agy was not found')), detection: antigravity }
        : {
            options: {
              command: antigravity.command,
              argsPrefix: antigravity.argsPrefix,
              flavor: antigravity.flavor,
              version: antigravity.version,
              skipPermissionsFlag: antigravity.skipPermissionsFlag ?? null,
              problem: null,
              protocolLog: o.antigravityProtocolLog,
            },
            detection: antigravity,
          },
    dsh: !dsh
      ? { missing: L('已用 --no-dsh 停用', 'Disabled with --no-dsh'), detection: null }
      : !dsh.command || dsh.error
        ? { missing: notice(dsh.error ?? L('未找到 dsh', 'dsh was not found')), detection: dsh }
        : {
            options: { command: dsh.command, argsPrefix: dsh.argsPrefix, version: dsh.version, problem: null, protocolLog: o.dshProtocolLog },
            detection: dsh,
          },
    opencode: !opencode
      ? { missing: L('已用 --no-opencode 停用', 'Disabled with --no-opencode'), detection: null }
      : !opencode.command || opencode.error
        ? { missing: notice(opencode.error ?? L('未找到 opencode', 'opencode was not found')), detection: opencode }
        : {
            options: { command: opencode.command, argsPrefix: opencode.argsPrefix, version: opencode.version, problem: null, protocolLog: o.opencodeProtocolLog },
            detection: opencode,
          },
    cursor: !cursor
      ? { missing: L('已用 --no-cursor 停用', 'Disabled with --no-cursor'), detection: null }
      : !cursor.command || cursor.error
        ? { missing: notice(cursor.error ?? L('未找到 cursor-agent', 'cursor-agent was not found')), detection: cursor }
        : {
            options: { command: cursor.command, argsPrefix: cursor.argsPrefix, installRoot: cursor.installRoot ?? null, version: cursor.version, problem: null, protocolLog: o.cursorProtocolLog },
            detection: cursor,
          },
    grok: !grok
      ? { missing: L('已用 --no-grok 停用', 'Disabled with --no-grok'), detection: null }
      : !grok.command || grok.error
        ? { missing: notice(grok.error ?? L('未找到 grok', 'grok was not found')), detection: grok }
        : {
            options: { command: grok.command, argsPrefix: grok.argsPrefix, version: grok.version, problem: null, protocolLog: o.grokProtocolLog },
            detection: grok,
          },
    kimi: !kimi
      ? { missing: L('已用 --no-kimi 停用', 'Disabled with --no-kimi'), detection: null }
      : !kimi.command || kimi.error
        ? { missing: notice(kimi.error ?? L('未找到 kimi', 'kimi was not found')), detection: kimi }
        : {
            options: { command: kimi.command, argsPrefix: kimi.argsPrefix, version: kimi.version, problem: null, protocolLog: o.kimiProtocolLog },
            detection: kimi,
          },
    copilot: !copilot
      ? { missing: L('已用 --no-copilot 停用', 'Disabled with --no-copilot'), detection: null }
      : !copilot.command || copilot.error
        ? { missing: notice(copilot.error ?? L('未找到 copilot', 'copilot was not found')), detection: copilot }
        : {
            options: { command: copilot.command, argsPrefix: copilot.argsPrefix, version: copilot.version, problem: null, protocolLog: o.copilotProtocolLog },
            detection: copilot,
          },
  };
}

/**
 * macOS / Linux: adds what the login shell puts on PATH, and the usual install folders, to this process's PATH, so the
 * CLIs are found, and npm-installed ones (`#!/usr/bin/env node`) find node, also when the app was opened from Finder or
 * a desktop launcher. Child processes inherit it. Windows keeps its PATH (findCli looks in the extra folders itself).
 */
export async function widenPath(): Promise<void> {
  if (process.platform === 'win32') return;
  const shell = await loginShellPath();
  process.env.PATH = mergePath(process.env.PATH ?? '', [...(shell ? shell.split(delimiter) : []), ...extraBinDirs()]);
}

import { randomUUID } from 'node:crypto';
import { L } from '../../../shared/notices.ts';
import type { RuntimeDescriptor } from '../../../shared/protocol.ts';
import { ENVELOPE_MARKERS } from '../team/envelope.ts';
import type { AgentSession, RuntimeAdapter, TurnEventSink, TurnInput, TurnResult } from './types.ts';

/**
 * Clearly-labelled MOCK runtime used only to exercise the chat UI and Core plumbing.
 * It has no tools, cannot read or modify files, and never emits activity or approval events.
 *
 * It quotes the messages it was asked to handle with "@" neutralised (so quoting never wakes anyone). For routing
 * tests, `mock-say: <text>` in a non-quoted line of a handled message makes it append `<text>` verbatim (which may
 * @mention, and may itself contain a further `mock-say:` for chains). A fullwidth "＠" in that text becomes "@", so a
 * test can script a chain without the user's own message mentioning the later agents.
 */
export class MockAdapter implements RuntimeAdapter {
  readonly kind = 'mock' as const;
  private readonly chunkDelayMs: number;

  constructor(opts: { chunkDelayMs?: number } = {}) {
    this.chunkDelayMs = opts.chunkDelayMs ?? 60;
  }

  describe(): RuntimeDescriptor {
    return {
      kind: 'mock',
      backend: 'mock',
      label: 'Mock',
      isMock: true,
      available: true,
      note: L('仅用于验证界面与消息流：没有工具、不能读写文件、不会产生审批。', 'Only for checking the interface and message flow: no tools, no file access, no approvals.'),
      requiresWorkspace: false,
      capabilities: {
        streaming: true,
        nativeTools: false,
        nativeApprovals: false,
        interrupt: true,
        resume: false,
        steer: false,
        teamMcp: false,
        standingInstructions: false,
      },
    };
  }

  async openSession(args: { resumeNativeSessionId?: string }): Promise<AgentSession> {
    return new MockSession(args.resumeNativeSessionId ?? `mock-${randomUUID()}`, this.chunkDelayMs);
  }
}

class MockSession implements AgentSession {
  readonly nativeSessionId: string;
  private readonly chunkDelayMs: number;

  constructor(id: string, chunkDelayMs: number) {
    this.nativeSessionId = id;
    this.chunkDelayMs = chunkDelayMs;
  }

  async runTurn(input: TurnInput, sink: TurnEventSink, signal: AbortSignal): Promise<TurnResult> {
    const section = triggerSection(input.text);
    const quoted = section
      .split('\n')
      .slice(0, 6)
      .map((l) => `> ${l.replaceAll('@', '＠')}`)
      .join('\n');
    // Directive anywhere in a non-quoted line: everything after the first "mock-say:" is said (with "＠" -> "@").
    const says = [...section.matchAll(/^(?!>).*?mock-say:\s*(.+)$/gm)].map((m) => m[1]!.trim().replaceAll('＠', '@'));
    sink({ type: 'turn.started', nativeTurnId: `mock-turn-${randomUUID()}` });
    const reply =
      `**[Mock 回复 · 非真实 Agent]**\n\n${quoted}\n\n` +
      (says.length ? `${says.join('\n')}\n\n` : '') +
      '这条消息由模拟运行时生成：没有调用模型，没有执行任何工具，也没有读取或修改文件。\n\n' +
      '```text\nruntime: mock\nsession: ' +
      this.nativeSessionId +
      '\n```';
    const chunks = reply.match(/[\s\S]{1,12}/g) ?? [];
    for (const chunk of chunks) {
      if (signal.aborted) return { status: 'interrupted' };
      await sleep(this.chunkDelayMs, signal);
      if (signal.aborted) return { status: 'interrupted' };
      sink({ type: 'text.delta', text: chunk });
    }
    return { status: 'completed' };
  }

  async close(): Promise<void> {}
}

/** The "messages to handle" part of a Core envelope (whole text if it is not an envelope). */
function triggerSection(text: string): string {
  const heading = ENVELOPE_MARKERS.trigger.find((h) => text.includes(h));
  if (!heading) return text;
  const from = text.indexOf(heading) + heading.length;
  const ends = ENVELOPE_MARKERS.after.map((m) => text.indexOf(m, from)).filter((i) => i >= 0);
  return text.slice(from, ends.length ? Math.min(...ends) : undefined).trim();
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0) return resolve();
    const t = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}

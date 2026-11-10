import { L, type Localized } from '../../../shared/notices.ts';
import type { RuntimeDescriptor, RuntimeKind } from '../../../shared/protocol.ts';
import type { RuntimeAdapter } from './types.ts';

const NO_CAPABILITIES = {
  streaming: false,
  nativeTools: false,
  nativeApprovals: false,
  interrupt: false,
  resume: false,
  steer: false,
  teamMcp: false,
  standingInstructions: false,
};

/** Placeholders so the UI can show real runtimes as "not connected yet" instead of pretending. */
const PLANNED: Record<Exclude<RuntimeKind, 'mock'>, RuntimeDescriptor> = {
  codex: {
    kind: 'codex',
    label: 'Codex',
    isMock: false,
    available: false,
    installed: false,
    note: L('未启用：本次启动未注册 Codex 运行时。', 'Not enabled: no Codex runtime was registered in this run.'),
    requiresWorkspace: true,
    capabilities: NO_CAPABILITIES,
  },
  claude: {
    kind: 'claude',
    label: 'Claude Code',
    isMock: false,
    available: false,
    installed: false,
    note: L('未启用：本次启动未注册 Claude Code 运行时（未找到 claude，或使用了 --no-claude）。', 'Not enabled: no Claude Code runtime was registered in this run (claude was not found, or --no-claude was used).'),
    requiresWorkspace: true,
    capabilities: NO_CAPABILITIES,
  },
  antigravity: {
    kind: 'antigravity',
    label: 'Antigravity',
    isMock: false,
    available: false,
    installed: false,
    note: L('未启用：本次启动未注册 Antigravity 运行时（未找到 agy，或使用了 --no-antigravity）。', 'Not enabled: no Antigravity runtime was registered in this run (agy was not found, or --no-antigravity was used).'),
    requiresWorkspace: true,
    capabilities: NO_CAPABILITIES,
  },
  dsh: {
    kind: 'dsh',
    label: 'DeepSeek Harness',
    isMock: false,
    available: false,
    installed: false,
    note: L('未启用：本次启动未注册 DeepSeek Harness 运行时（未找到 dsh，或使用了 --no-dsh）。', 'Not enabled: no DeepSeek Harness runtime was registered in this run (dsh was not found, or --no-dsh was used).'),
    requiresWorkspace: true,
    capabilities: NO_CAPABILITIES,
  },
  opencode: {
    kind: 'opencode',
    label: 'OpenCode',
    isMock: false,
    available: false,
    installed: false,
    note: L('未启用：本次启动未注册 OpenCode 运行时（未找到 opencode，或使用了 --no-opencode）。', 'Not enabled: no OpenCode runtime was registered in this run (opencode was not found, or --no-opencode was used).'),
    requiresWorkspace: true,
    capabilities: NO_CAPABILITIES,
  },
  chat: {
    kind: 'chat',
    label: 'Chat',
    isMock: false,
    available: false,
    installed: false,
    note: L('未启用：本次启动未注册聊天成员。', 'Not enabled: chat members were not registered in this run.'),
    requiresWorkspace: false,
    capabilities: NO_CAPABILITIES,
  },
};

export class AdapterRegistry {
  private readonly adapters = new Map<RuntimeKind, RuntimeAdapter>();
  /** Why a real runtime without an adapter is missing (not found, could not run, disabled). */
  private readonly missing = new Map<RuntimeKind, Localized>();

  /** Records why `kind` has no adapter (null clears it). */
  setMissing(kind: RuntimeKind, reason: Localized | null): void {
    if (reason) this.missing.set(kind, reason);
    else this.missing.delete(kind);
  }

  register(adapter: RuntimeAdapter): void {
    this.adapters.set(adapter.kind, adapter);
  }

  get(kind: RuntimeKind): RuntimeAdapter | undefined {
    return this.adapters.get(kind);
  }

  all(): RuntimeAdapter[] {
    return [...this.adapters.values()];
  }

  describeAll(): RuntimeDescriptor[] {
    const kinds: RuntimeKind[] = ['mock', 'codex', 'claude', 'antigravity', 'dsh', 'opencode', 'chat'];
    return kinds.map((k) => {
      const a = this.adapters.get(k);
      if (a) return a.describe();
      if (k !== 'mock') {
        const why = this.missing.get(k);
        return why ? { ...PLANNED[k], problem: why, note: why } : PLANNED[k];
      }
      return {
        kind: 'mock',
        label: 'Mock',
        isMock: true,
        available: false,
        note: L('未启用', 'Not enabled'),
        requiresWorkspace: false,
        capabilities: NO_CAPABILITIES,
      };
    });
  }
}

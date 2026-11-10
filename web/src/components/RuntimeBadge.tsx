import { createContext, useContext, type ReactNode } from 'react';
import { avatarDefaultKey, type Agent, type AgentWithStatus, type AvatarDefaultKey, type AvatarDefaults } from '../../../shared/protocol.ts';
import { useT } from '../i18n.tsx';

export const RUNTIME_NAME: Record<AgentWithStatus['runtimeKind'], string> = {
  mock: 'Mock',
  codex: 'Codex',
  claude: 'Claude Code',
  antigravity: 'Antigravity',
  dsh: 'DeepSeek Harness',
  opencode: 'OpenCode',
  chat: 'Chat',
};

/**
 * Text shown in an agent's avatar: a fixed two-letter mark per real runtime (self-drawn, no vendor logos — see
 * docs/IMPLEMENTATION_STATUS.md), the first letter of the name for mock members.
 */
export function avatarText(runtimeKind: AgentWithStatus['runtimeKind'], displayName: string): string {
  if (runtimeKind === 'claude') return 'CC';
  if (runtimeKind === 'codex') return 'Cx';
  if (runtimeKind === 'antigravity') return 'AG';
  if (runtimeKind === 'dsh') return 'DS';
  if (runtimeKind === 'opencode') return 'OC';
  return displayName.slice(0, 1).toUpperCase();
}

/** Default member avatar per runtime, from the server (App provides it). */
export const AvatarDefaultsContext = createContext<AvatarDefaults>({});

/** The default picture of the runtime (chat members: of their model provider), if one is set. */
export function useAvatarDefault(key: AvatarDefaultKey | null): string | null {
  const defaults = useContext(AvatarDefaultsContext);
  return key ? (defaults[key] ?? null) : null;
}

/**
 * A member's avatar: the picture the user chose, else the runtime's default picture, else the runtime's letter mark.
 * Decorative (the name is next to it).
 */
export function AgentAvatar(props: {
  agent: Pick<Agent, 'runtimeKind' | 'displayName' | 'avatar'> & { providerId?: string | null };
  /** Overrides the member's own picture (e.g. an unsaved choice in the settings dialog); null = none of its own. */
  src?: string | null;
  className?: string;
  as?: 'span' | 'div';
  children?: ReactNode;
}) {
  const fallback = useAvatarDefault(avatarDefaultKey(props.agent));
  const src = (props.src !== undefined ? props.src : props.agent.avatar) ?? fallback;
  const Tag = props.as ?? 'span';
  return (
    <Tag className={`avatar avatar-${props.agent.runtimeKind}${src ? ' has-img' : ''}${props.className ? ` ${props.className}` : ''}`} aria-hidden="true">
      {src ? <img src={src} alt="" /> : avatarText(props.agent.runtimeKind, props.agent.displayName)}
      {props.children}
    </Tag>
  );
}

/** Always shows the real runtime identity; per-token billing and mock agents are marked. */
export function RuntimeBadge({ agent }: { agent: AgentWithStatus }) {
  const t = useT();
  if (agent.isMock) return <span className="badge badge-mock">Mock</span>;
  // A member of the removed model-provider route no longer runs.
  const legacy = !!agent.providerId && agent.runtimeKind !== 'chat';
  return (
    <span className={`badge badge-${agent.runtimeKind}${legacy ? ' badge-off' : ''}`} title={agent.workspace ?? undefined}>
      {RUNTIME_NAME[agent.runtimeKind]}
      {legacy ? ` · ${t('agent.unavailable')}` : agent.billing === 'metered_api' ? ` · ${t('billing.metered')}` : ''}
    </span>
  );
}

/** Marks a login billed per token. */
export function MeteredBadge() {
  const t = useT();
  return (
    <span className="badge badge-metered" title={t('billing.meteredTitle')}>
      {t('billing.metered')}
    </span>
  );
}

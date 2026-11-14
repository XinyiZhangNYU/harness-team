import { type ComponentProps, memo, useEffect, useMemo, useRef, useState } from 'react';
import Markdown, { type Components, defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { noticeCode } from '../../../shared/notices.ts';
import type { AgentWithStatus, DeliveryInfo, Message, MessageIntent } from '../../../shared/protocol.ts';
import { initial } from '../avatar.ts';
import { formatTime, fullTime, splitNotice } from '../format.ts';
import { usePrefs, type TFunc, useNoticeText } from '../i18n.tsx';
import { CITATION_HREF, citationsAsText, extractCitations, localLinkPath } from '../file-citations.ts';
import { AttachmentGrid, FileCitationChip } from './Attachments.tsx';
import { DeliveryChips } from './DeliveryChips.tsx';
import { Icon } from './Icon.tsx';
import { AgentAvatar, RuntimeBadge } from './RuntimeBadge.tsx';
import { ActivityItem, ApprovalCard, SessionChoiceCard } from './RuntimeEvents.tsx';

function statusLabel(t: TFunc, s: Message['status']): string | null {
  return s === 'streaming' ? t('msg.streaming') : s === 'interrupted' ? t('msg.interrupted') : s === 'failed' ? t('msg.failed') : null;
}

const intentLabel = (t: TFunc, i: MessageIntent) => t(`intent.${i}`);

/** Markdown images show their alt text instead of being fetched. */
export const NO_IMAGES: Components = { img: ({ alt }) => (alt ? <span>{alt}</span> : null) };

/** Copies text from a click; falls back to a selection copy where the Clipboard API is refused (embedded views). */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const back = document.activeElement as HTMLElement | null;
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.select();
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      ta.remove();
      back?.focus();
    }
  }
}

/** An icon button that copies `text()`; shows a tick for a moment after it worked. */
function CopyButton({ text, className, label }: { text: () => string; className: string; label: 'msg.copyCode' | 'msg.copyReply' }) {
  const { t } = usePrefs();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);
  const title = t(copied ? 'msg.copied' : label);
  return (
    <button
      type="button"
      className={`${className}${copied ? ' copied' : ''}`}
      onClick={() => void copyText(text()).then((ok) => ok && setCopied(true))}
      title={title}
      aria-label={title}
    >
      <Icon name={copied ? 'check' : 'copy'} size={14} />
    </button>
  );
}

/** A code block with a copy button in its top-right corner. */
function CodeBlock({ node: _node, children, ...rest }: ComponentProps<'pre'> & { node?: unknown }) {
  const ref = useRef<HTMLPreElement>(null);
  return (
    <div className="code-block">
      <pre ref={ref} {...rest}>
        {children}
      </pre>
      <CopyButton className="code-copy" label="msg.copyCode" text={() => (ref.current?.textContent ?? '').replace(/\n$/, '')} />
    </div>
  );
}

/** What message bodies render with: no images, copyable code blocks. */
const BODY: Components = { ...NO_IMAGES, pre: CodeBlock };

/** Links to a local file keep their target (`C:/…` and `file:` would otherwise be dropped as unknown schemes). */
const keepLocalLinks = (url: string) => (localLinkPath(url) ? url : defaultUrlTransform(url));

/** A message body; Codex file citations, local paths in code spans and links to local files become file chips (file-citations.ts). */
export function MessageMarkdown({ body, workspace }: { body: string; workspace: string | null | undefined }) {
  const { text, citations } = useMemo(() => extractCitations(body), [body]);
  const components = useMemo<Components>(
    () => ({
      ...BODY,
      a: ({ href, children, node: _node, ...rest }) => {
        const c = href?.startsWith(CITATION_HREF) ? citations[Number(href.slice(CITATION_HREF.length))] : undefined;
        if (c) return <FileCitationChip citation={c} workspace={workspace} />;
        const local = localLinkPath(href);
        if (local) return <FileCitationChip citation={local} workspace={workspace} label={children} />;
        return (
          <a href={href} {...rest}>
            {children}
          </a>
        );
      },
    }),
    [citations, workspace],
  );
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={components} urlTransform={keepLocalLinks}>
      {text}
    </Markdown>
  );
}

export const MessageItem = memo(function MessageItem(props: {
  message: Message;
  sender?: AgentWithStatus;
  deliveries?: DeliveryInfo[];
  agents?: Record<string, AgentWithStatus>;
  /** Runtime rows (tool activity, approvals): show the member's avatar in the gutter. */
  showAvatar?: boolean;
  /** Takes back the user's queued message (`edit`: its text goes back to the composer). */
  onWithdraw?: (message: Message, edit: boolean) => void;
  /** The sender's working folder in this chat, when it is not its own (Room.memberWorkspaces). */
  senderWorkspace?: string;
}) {
  const { t, locale, userAvatar, userLabel } = usePrefs();
  const noticeText = useNoticeText();
  const { message: m, sender } = props;
  const time = (
    <time dateTime={m.createdAt} title={fullTime(m.createdAt, locale)}>
      {formatTime(m.createdAt, locale)}
    </time>
  );
  const onWithdraw = props.onWithdraw;
  const chips = props.deliveries?.length ? (
    <DeliveryChips
      deliveries={props.deliveries}
      agents={props.agents ?? {}}
      onWithdraw={m.senderKind === 'user' && onWithdraw ? (edit) => onWithdraw(m, edit) : undefined}
    />
  ) : null;
  if (m.meta?.type === 'withdrawn') {
    return (
      <div className="msg-system" data-seq={m.seq}>
        {t('msg.withdrawn')} {time}
      </div>
    );
  }
  const meta = m.meta?.type === 'chat' ? m.meta : null;

  const noticeMeta = m.meta?.type === 'notice' ? m.meta.notice : null;
  const body = noticeText(noticeMeta, m.body);
  if (m.kind === 'system' && m.meta?.type === 'notice' && m.meta.sessionChoice) {
    return <SessionChoiceCard message={m} sender={props.agents?.[m.meta.sessionChoice.agentId]} />;
  }
  if (m.kind === 'system') {
    // Multi-line notices (native session info: tools, MCP servers, skills…) show one line; the rest is folded.
    const { summary, detail } = splitNotice(body, noticeCode(noticeMeta) === 'session.info');
    return (
      <div className="msg-system" data-seq={m.seq}>
        {detail ? (
          <details className="system-detail">
            <summary>
              {summary} {time}
            </summary>
            <pre>{detail}</pre>
          </details>
        ) : (
          <>
            {summary} {time}
          </>
        )}
      </div>
    );
  }
  if (m.kind === 'activity') return <ActivityItem message={m} sender={sender} showAvatar={props.showAvatar} />;
  if (m.kind === 'approval') return <ApprovalCard message={m} sender={sender} showAvatar={props.showAvatar} />;

  const isUser = m.senderKind === 'user';
  const name = isUser ? userLabel : sender ? `${sender.displayName}${sender.deletedAt ? ` ${t('msg.deleted')}` : ''}` : t('msg.unknown');
  const status = statusLabel(t, m.status);
  return (
    <article className={`msg ${isUser ? 'msg-user' : 'msg-agent'} msg-${m.status}`} data-seq={m.seq}>
      {sender && !isUser ? (
        <AgentAvatar agent={sender} as="div" />
      ) : (
        <div className={`avatar${isUser ? ` avatar-user${userAvatar ? ' has-img' : ''}` : ''}`} aria-hidden="true">
          {isUser && userAvatar ? <img src={userAvatar} alt="" /> : isUser ? initial(name) : '?'}
        </div>
      )}
      <div className="msg-main">
      <header className="msg-head">
        <span className="msg-sender">{name}</span>
        {sender && <span className="msg-handle">@{sender.handle}</span>}
        {sender && <RuntimeBadge agent={sender} billing={m.meta?.type === 'chat' || m.meta?.type === 'notice' ? m.meta.billing : undefined} />}
        <span className="msg-time">{time}</span>
        {meta?.phase === 'commentary' && <span className="badge">{t('msg.update')}</span>}
        {meta?.via === 'team_mcp' && <span className="badge">Team MCP</span>}
        {meta?.intent && meta.intent !== 'chat' && <span className={`badge intent-${meta.intent}`}>{intentLabel(t, meta.intent)}</span>}
        {m.meta?.type === 'command' && <span className="badge badge-command">{t(m.meta.skill ? 'msg.skill' : 'msg.command')}</span>}
        {m.meta?.type === 'scheduled' && (
          <span className="msg-scheduled" title={t('sched.fromTask')} aria-label={t('sched.fromTask')}>
            <Icon name="clock" size={12} />
          </span>
        )}
        {status &&<span className={`msg-status st-${m.status}`}>{status}</span>}
      </header>
      {(body || !m.attachments?.length) && (
        <div className={`msg-body markdown${noticeMeta ? ' msg-body-notice' : ''}`}>
          {body ? (
            // react-markdown does not render raw HTML by default. Images are not loaded at all: a same-origin URL would be
            // requested with the session cookie as soon as a member's reply shows (CSP only blocks remote ones).
            <MessageMarkdown body={body} workspace={props.senderWorkspace ?? sender?.workspace} />
          ) : (
            <span className="muted">…</span>
          )}
          {m.status === 'streaming' && <span className="cursor" aria-hidden="true" />}
        </div>
      )}
      {m.attachments?.length ? <AttachmentGrid roomId={m.roomId} attachments={m.attachments} /> : null}
      {!isUser && body && m.status !== 'streaming' && (
        <div className="msg-actions">
          <CopyButton className="msg-copy" label="msg.copyReply" text={() => citationsAsText(body)} />
        </div>
      )}
      {chips}
      </div>
    </article>
  );
});

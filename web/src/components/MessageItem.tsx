import { memo, useMemo } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { noticeCode } from '../../../shared/notices.ts';
import type { AgentWithStatus, DeliveryInfo, Message, MessageIntent } from '../../../shared/protocol.ts';
import { initial } from '../avatar.ts';
import { formatTime, fullTime, splitNotice } from '../format.ts';
import { usePrefs, type TFunc, useNoticeText } from '../i18n.tsx';
import { CITATION_HREF, extractCitations } from '../file-citations.ts';
import { AttachmentGrid, FileCitationChip } from './Attachments.tsx';
import { DeliveryChips } from './DeliveryChips.tsx';
import { AgentAvatar, RuntimeBadge } from './RuntimeBadge.tsx';
import { ActivityItem, ApprovalCard, SessionChoiceCard } from './RuntimeEvents.tsx';

function statusLabel(t: TFunc, s: Message['status']): string | null {
  return s === 'streaming' ? t('msg.streaming') : s === 'interrupted' ? t('msg.interrupted') : s === 'failed' ? t('msg.failed') : null;
}

const intentLabel = (t: TFunc, i: MessageIntent) => t(`intent.${i}`);

/** Markdown images show their alt text instead of being fetched. */
export const NO_IMAGES: Components = { img: ({ alt }) => (alt ? <span>{alt}</span> : null) };

/** A message body; Codex file citations become file chips (file-citations.ts). */
function MessageMarkdown({ body, workspace }: { body: string; workspace: string | null | undefined }) {
  const { text, citations } = useMemo(() => extractCitations(body), [body]);
  const components = useMemo<Components>(
    () =>
      citations.length
        ? {
            ...NO_IMAGES,
            a: ({ href, children, node: _node, ...rest }) => {
              const c = href?.startsWith(CITATION_HREF) ? citations[Number(href.slice(CITATION_HREF.length))] : undefined;
              return c ? <FileCitationChip citation={c} workspace={workspace} /> : <a href={href} {...rest}>{children}</a>;
            },
          }
        : NO_IMAGES,
    [citations, workspace],
  );
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={components}>
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
}) {
  const { t, locale, userAvatar, userLabel } = usePrefs();
  const noticeText = useNoticeText();
  const { message: m, sender } = props;
  const time = (
    <time dateTime={m.createdAt} title={fullTime(m.createdAt, locale)}>
      {formatTime(m.createdAt, locale)}
    </time>
  );
  const chips = props.deliveries?.length ? <DeliveryChips deliveries={props.deliveries} agents={props.agents ?? {}} /> : null;
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
        {status && <span className={`msg-status st-${m.status}`}>{status}</span>}
      </header>
      {(body || !m.attachments?.length) && (
        <div className={`msg-body markdown${noticeMeta ? ' msg-body-notice' : ''}`}>
          {body ? (
            // react-markdown does not render raw HTML by default. Images are not loaded at all: a same-origin URL would be
            // requested with the session cookie as soon as a member's reply shows (CSP only blocks remote ones).
            <MessageMarkdown body={body} workspace={sender?.workspace} />
          ) : (
            <span className="muted">…</span>
          )}
          {m.status === 'streaming' && <span className="cursor" aria-hidden="true" />}
        </div>
      )}
      {m.attachments?.length ? <AttachmentGrid roomId={m.roomId} attachments={m.attachments} /> : null}
      {chips}
      </div>
    </article>
  );
});

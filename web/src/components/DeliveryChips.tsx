import { type NoticeLang, renderNotice } from '../../../shared/notices.ts';
import type { AgentWithStatus, DeliveryInfo } from '../../../shared/protocol.ts';
import { usePrefs, type TFunc } from '../i18n.tsx';
import { Icon } from './Icon.tsx';

function stageTitle(d: DeliveryInfo, t: TFunc, locale: string, lang: NoticeLang): string {
  const at = (iso: string) => new Date(iso).toLocaleString(locale, { hourCycle: 'h23' });
  const rows = [
    `${t('delivery.t.stored')}: ${at(d.createdAt)}`,
    d.dispatchedAt && `${t('delivery.t.dispatched')}: ${at(d.dispatchedAt)}`,
    d.acceptedAt && `${t('delivery.t.accepted')}: ${at(d.acceptedAt)}`,
    d.repliedAt && `${t('delivery.t.replied')}: ${at(d.repliedAt)}`,
    d.finishedAt && `${t('delivery.t.finished')}: ${at(d.finishedAt)}`,
    d.hop > 0 && t('delivery.t.hop', { n: d.hop }),
    d.errorNotice ? renderNotice(d.errorNotice, lang) : d.error,
  ];
  return rows.filter(Boolean).join('\n');
}

const WAITING = new Set<DeliveryInfo['state']>(['queued', 'held']);

/**
 * Per-recipient push delivery stages for one source message. With `onWithdraw` (the user's own message), copies still
 * queued can be taken back: all of it with its text back in the composer when nobody had it yet, else only the
 * queued copies.
 */
export function DeliveryChips(props: { deliveries: DeliveryInfo[]; agents: Record<string, AgentWithStatus>; onWithdraw?: (edit: boolean) => void }) {
  const { t, locale, lang } = usePrefs();
  const waiting = props.deliveries.some((d) => WAITING.has(d.state));
  const untouched = props.deliveries.every((d) => WAITING.has(d.state) || d.state === 'skipped');
  const withdraw = props.onWithdraw;
  return (
    <div className="delivery-chips">
      {props.deliveries.map((d) => (
        <span key={d.id} className={`chip chip-${d.state}`} title={stageTitle(d, t, locale, lang)}>
          @{props.agents[d.agentId]?.handle ?? '?'} · {t(`delivery.${d.state}`)}
        </span>
      ))}
      {withdraw && waiting && (
        <>
          {untouched && (
            <button type="button" className="chip chip-action" onClick={() => withdraw(true)}>
              <Icon name="edit" size={12} />
              {t('msg.withdrawEdit')}
            </button>
          )}
          <button type="button" className="chip chip-action" onClick={() => withdraw(false)}>
            <Icon name="x" size={12} />
            {t(untouched ? 'msg.withdraw' : 'msg.cancelQueued')}
          </button>
        </>
      )}
    </div>
  );
}

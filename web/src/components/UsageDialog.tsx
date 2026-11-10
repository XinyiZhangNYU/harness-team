import { useEffect, useState } from 'react';
import { cacheHitRate, usageTotal, type UsageGroup, type UsageSummary, type UsageTotals } from '../../../shared/protocol.ts';
import { api } from '../api.ts';
import { compactNumber, formatPercent, formatUsd, localDay } from '../format.ts';
import { usePrefs, type TFunc } from '../i18n.tsx';
import { Dialog, errorText } from './Dialog.tsx';
import { HelpTip } from './HelpTip.tsx';
import { Icon } from './Icon.tsx';
import { Segmented } from './SettingsDialog.tsx';

type Range = 'today' | '7d' | '30d' | 'all';
type GroupBy = 'project' | 'model' | 'member';
const RANGE_DAYS: Record<Range, number | null> = { today: 1, '7d': 7, '30d': 30, all: null };

/** Local midnight `days - 1` days ago, so "7 days" means today and the six days before it. */
function rangeStart(range: Range): Date | null {
  const days = RANGE_DAYS[range];
  if (days === null) return null;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (days - 1));
  return d;
}

/**
 * Token usage of members' turns run in Harness Team, as the runtimes reported it. Nothing from the CLIs' own history
 * outside the app is counted.
 */
export function UsageDialog(props: { onClose: () => void }) {
  const { t, locale } = usePrefs();
  const [range, setRange] = useState<Range>('7d');
  const [data, setData] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [groupBy, setGroupBy] = useState<GroupBy>('project');

  useEffect(() => {
    let live = true;
    setError(null);
    api
      .usage(rangeStart(range)?.toISOString() ?? null)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [range, reload]);

  const num = (n: number) => compactNumber(n, locale);
  const tokens = (g: UsageTotals, n: number) => tokenText(g, n, num);
  const ranges: { value: Range; label: string }[] = [
    { value: 'today', label: t('usage.today') },
    { value: '7d', label: t('usage.days', { n: 7 }) },
    { value: '30d', label: t('usage.days', { n: 30 }) },
    { value: 'all', label: t('usage.all') },
  ];
  const totals = data?.totals;
  const hit = totals && totals.tokenTurns === totals.turns ? cacheHitRate(totals) : null;
  const groups: Record<GroupBy, { label: string; rows: UsageGroup[]; name: (g: UsageGroup) => GroupName }> | null = data
    ? {
        project: { label: t('usage.byProject'), rows: data.byProject, name: (g) => projectName(g, t) },
        model: { label: t('usage.byModel'), rows: data.byModel, name: (g) => modelName(g, t) },
        member: { label: t('usage.byMember'), rows: data.byAgent, name: (g) => memberName(g, t) },
      }
    : null;

  return (
    <Dialog
      title={
        <>
          {t('usage.title')} <HelpTip text={t('usage.note')} />
        </>
      }
      label={t('usage.title')}
      className="usage-dialog" onClose={props.onClose}>
      <div className="usage-toolbar">
        <Segmented value={range} options={ranges} onChange={setRange} label={t('usage.range')} />
        <button type="button" className="icon-btn" aria-label={t('usage.refresh')} title={t('usage.refresh')} onClick={() => setReload((n) => n + 1)}>
          <Icon name="refresh" />
        </button>
      </div>
      {error && (
        <div className="error-text" role="alert">
          {error}
        </div>
      )}
      {!data && !error && <div className="hint">{t('usage.loading')}</div>}
      {data && totals && (
        <>
          <div className="usage-tiles">
            <Tile
              label={t('usage.total')}
              value={tokens(totals, usageTotal(totals))}
              title={tokensTitle(totals, usageTotal(totals).toLocaleString(locale), t)}
              sub={totals.cacheRead + totals.cacheWrite > 0 ? t('usage.withoutCache', { n: num(usageTotal(totals) - totals.cacheRead - totals.cacheWrite) }) : undefined}
            />
            <Tile label={t('usage.input')} value={tokens(totals, totals.input)} title={tokensTitle(totals, `${t('usage.inputHint')} ${totals.input.toLocaleString(locale)}`, t)} />
            <Tile
              label={t('usage.cache')}
              value={tokens(totals, totals.cacheRead + totals.cacheWrite)}
              title={tokensTitle(totals, t('usage.cacheDetail', { read: totals.cacheRead.toLocaleString(locale), write: totals.cacheWrite.toLocaleString(locale) }), t)}
            />
            <Tile label={t('usage.hitRate')} value={hit === null ? '—' : formatPercent(hit, locale)} title={t('usage.hitRateHint')} />
            <Tile
              label={t('usage.output')}
              value={tokens(totals, totals.output)}
              title={tokensTitle(totals, totals.reasoning ? t('usage.reasoningDetail', { n: totals.reasoning.toLocaleString(locale) }) : totals.output.toLocaleString(locale), t)}
            />
            <Tile label={t('usage.turns')} value={totals.turns.toLocaleString(locale)} />
            <Tile
              label={t('usage.cost')}
              value={costText(totals, locale)}
              title={`${t('usage.costHint')}${totals.costPartial || (totals.costUsd === null && totals.turns > 0) ? `\n${t('usage.costUnpriced')}` : ''}`}
            />
          </div>
          {/* Empty only without turns: a turn the runtime reported only a cost for (no tokens) still has a breakdown. */}
          {totals.turns === 0 ? (
            <div className="usage-empty">{t('usage.empty')}</div>
          ) : (
            <>
              <DayBars days={data.byDay} range={range} t={t} locale={locale} />
              {groups && (
                <section className="usage-section">
                  <div className="usage-section-head">
                    <h3 id="usage-breakdown">{t('usage.breakdown')}</h3>
                    <select aria-labelledby="usage-breakdown" value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
                      {(Object.keys(groups) as GroupBy[]).map((k) => (
                        <option key={k} value={k}>
                          {groups[k].label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <GroupTable rows={groups[groupBy].rows} name={groups[groupBy].name} t={t} locale={locale} />
                </section>
              )}
            </>
          )}
        </>
      )}
    </Dialog>
  );
}

function Tile(props: { label: string; value: string; title?: string; sub?: string }) {
  return (
    <div className="usage-tile" title={props.title}>
      <div className="usage-tile-label">{props.label}</div>
      <div className="usage-tile-value">{props.value}</div>
      {props.sub && <div className="usage-tile-sub">{props.sub}</div>}
    </div>
  );
}

/** One bar per local day; days of a fixed range without usage are shown as empty bars. */
function DayBars(props: { days: UsageGroup[]; range: Range; t: TFunc; locale: string }) {
  if (props.range === 'today') return null;
  const byKey = new Map(props.days.map((d) => [d.key, d]));
  let keys: string[];
  const start = rangeStart(props.range);
  if (start) {
    keys = [];
    for (let d = new Date(start); d <= new Date(); d.setDate(d.getDate() + 1)) keys.push(localDay(d));
  } else {
    keys = props.days.map((d) => d.key ?? '').filter(Boolean);
  }
  if (keys.length < 2) return null;
  const max = Math.max(1, ...props.days.map(usageTotal));
  const label = (key: string) => new Date(`${key}T00:00:00`).toLocaleDateString(props.locale, { month: 'numeric', day: 'numeric' });
  return (
    <section className="usage-section">
      <h3>{props.t('usage.byDay')}</h3>
      <div className="usage-bars" role="list">
        {keys.map((key) => {
          const g = byKey.get(key);
          const total = g ? usageTotal(g) : 0;
          const shown = g ? tokenText(g, total, (n) => n.toLocaleString(props.locale)) : '0';
          return (
            <div key={key} className="usage-bar" role="listitem" title={`${label(key)} · ${shown}`}>
              <div className="usage-bar-fill" style={{ height: `${total ? Math.max(3, (total / max) * 100) : 0}%` }} />
            </div>
          );
        })}
      </div>
      <div className="usage-bars-axis">
        <span>{label(keys[0]!)}</span>
        <span>{label(keys[keys.length - 1]!)}</span>
      </div>
    </section>
  );
}

type GroupName = { text: string; title?: string; tag?: string };

function GroupTable(props: { rows: UsageGroup[]; name: (g: UsageGroup) => GroupName; t: TFunc; locale: string }) {
  const { t, locale } = props;
  if (!props.rows.length) return <div className="usage-empty">{t('usage.empty')}</div>;
  const num = (n: number) => compactNumber(n, locale);
  return (
    <div className="usage-table-wrap">
      <table className="usage-table">
        <thead>
          <tr>
            <th />
            <th>{t('usage.turns')}</th>
            <th>{t('usage.input')}</th>
            <th>{t('usage.cache')}</th>
            <th title={t('usage.hitRateHint')}>{t('usage.hitRateShort')}</th>
            <th>{t('usage.output')}</th>
            <th>{t('usage.total')}</th>
            <th title={t('usage.costHint')}>{t('usage.cost')}</th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map((g, i) => {
            const n = props.name(g);
            return (
              <tr key={`${g.key ?? ''}-${g.runtimeKind ?? ''}-${i}`}>
                <td className="usage-name" title={n.title ?? n.text}>
                  <span>{n.text}</span>
                  {n.tag && <span className="usage-tag">{n.tag}</span>}
                </td>
                <td>{g.turns.toLocaleString(locale)}</td>
                <td title={tokensTitle(g, undefined, t)}>{tokenText(g, g.input, num)}</td>
                <td title={tokensTitle(g, t('usage.cacheDetail', { read: g.cacheRead.toLocaleString(locale), write: g.cacheWrite.toLocaleString(locale) }), t)}>
                  {tokenText(g, g.cacheRead + g.cacheWrite, num)}
                </td>
                <td>{g.tokenTurns === g.turns ? rateText(g, locale) : '—'}</td>
                <td title={tokensTitle(g, undefined, t)}>{tokenText(g, g.output, num)}</td>
                <td className="usage-strong" title={tokensTitle(g, undefined, t)}>{tokenText(g, usageTotal(g), num)}</td>
                <td title={g.costPartial || g.costUsd === null ? t('usage.costUnpriced') : undefined}>{costText(g, locale)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** A reply can have partial model counts even when no reply has complete counts. */
function tokenText(g: UsageTotals, n: number, fmt: (n: number) => string): string {
  if (g.turns > 0 && g.tokenTurns === 0 && usageTotal(g) === 0 && g.reasoning === 0) return '—';
  return `${g.tokenTurns < g.turns ? '≥ ' : ''}${fmt(n)}`;
}

function tokensTitle(g: UsageTotals, title: string | undefined, t: TFunc): string | undefined {
  return g.tokenTurns < g.turns ? t('usage.tokensUnknown', { n: g.turns - g.tokenTurns }) : title;
}

/** "—" when nothing could be priced; "≥ $x" when some models had no price. */
function costText(g: UsageTotals, locale: string): string {
  if (g.costUsd === null) return '—';
  return `${g.costPartial ? '≥ ' : ''}${formatUsd(g.costUsd, locale)}`;
}

function rateText(g: UsageGroup, locale: string): string {
  const r = cacheHitRate(g);
  return r === null ? '—' : formatPercent(r, locale);
}

const RUNTIME_LABEL: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', mock: 'Mock' };

function projectName(g: UsageGroup, t: TFunc) {
  if (!g.key) return { text: t('usage.noProject') };
  const base = g.key.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || g.key;
  return { text: base, title: g.key };
}

function modelName(g: UsageGroup, t: TFunc) {
  return { text: g.key ?? t('usage.unknownModel'), tag: g.runtimeKind ? (RUNTIME_LABEL[g.runtimeKind] ?? g.runtimeKind) : undefined };
}

function memberName(g: UsageGroup, t: TFunc) {
  return { text: g.label ?? t('usage.deletedMember'), tag: g.runtimeKind ? (RUNTIME_LABEL[g.runtimeKind] ?? g.runtimeKind) : undefined };
}


import { useEffect, useState } from 'react';
import { unquotePath, type DirListing, type RecentWorkspacesResponse, type WorkspaceSource } from '../../../shared/protocol.ts';
import { api } from '../api.ts';
import { useLocalized, useT } from '../i18n.tsx';
import { Dialog, errorText } from './Dialog.tsx';
import { Icon } from './Icon.tsx';

/**
 * Folder field: type a path, pick a folder (native dialog in the desktop app, an in-app browser otherwise), or take
 * one of the project folders already used with Codex / Claude Code.
 */
export function WorkspacePicker(props: { value: string; onChange: (path: string) => void; label?: string }) {
  const t = useT();
  const [recentOpen, setRecentOpen] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);

  async function browse() {
    setBrowseError(null);
    const desktop = window.harnessDesktop;
    if (desktop) {
      try {
        const picked = await desktop.pickFolder(props.value.trim() || undefined);
        if (picked) props.onChange(picked);
      } catch (e) {
        setBrowseError(t('ws.pickerError', { error: errorText(e) }));
      }
      return;
    }
    setBrowserOpen(true);
  }

  return (
    <div className="field">
      <label className="field-label">{props.label ?? t('add.workspace')}</label>
      <div className="input-group">
        <input value={props.value} maxLength={1000} aria-label={props.label ?? t('add.workspace')} onChange={(e) => props.onChange(pasted(e.target.value))} />
        <button type="button" onClick={() => void browse()}>
          {t('ws.browse')}
        </button>
        <button type="button" aria-expanded={recentOpen} onClick={() => setRecentOpen((o) => !o)}>
          {recentOpen ? t('ws.hide') : t('ws.recent')}
        </button>
      </div>
      {browseError && <div className="error-text">{browseError}</div>}
      {recentOpen && (
        <RecentWorkspaces
          current={props.value}
          onPick={(p) => {
            props.onChange(p);
            setRecentOpen(false);
          }}
        />
      )}
      {browserOpen && (
        <FolderBrowser
          start={props.value.trim() || null}
          onCancel={() => setBrowserOpen(false)}
          onPick={(p) => {
            props.onChange(p);
            setBrowserOpen(false);
          }}
        />
      )}
    </div>
  );
}

/** A whole quoted path (Explorer's "Copy as path") loses its quotes; anything else is kept as typed. */
const pasted = (v: string) => (unquotePath(v) !== v.trim() ? unquotePath(v) : v);

/** Whether "Recent" also lists folders from your Codex / Claude Code history (per window; on unless turned off). */
const HISTORY_KEY = 'ht.recentHistory';
function loadHistoryPref(): boolean {
  try {
    return localStorage.getItem(HISTORY_KEY) !== '0';
  } catch {
    return true;
  }
}

function RecentWorkspaces(props: { current: string; onPick: (path: string) => void }) {
  const t = useT();
  const lz = useLocalized();
  const [data, setData] = useState<RecentWorkspacesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [history, setHistory] = useState(loadHistoryPref);
  const sourceLabel: Record<WorkspaceSource, string> = { codex: 'Codex', claude: 'Claude Code', harness: t('ws.member') };
  const sourceTip: Record<WorkspaceSource, string> = {
    codex: t('ws.fromCodex'),
    claude: t('ws.fromClaude'),
    harness: t('ws.fromMember'),
  };

  function load(withHistory = history) {
    setLoading(true);
    setError(null);
    api
      .recentWorkspaces(withHistory)
      .then(setData, (e) => setError(errorText(e)))
      .finally(() => setLoading(false));
  }
  useEffect(() => load(), []);

  function toggleHistory(on: boolean) {
    setHistory(on);
    try {
      localStorage.setItem(HISTORY_KEY, on ? '1' : '0');
    } catch {
      // a per-window convenience
    }
    load(on);
  }

  const q = filter.trim().toLowerCase();
  const list = (data?.workspaces ?? []).filter((w) => !q || w.path.toLowerCase().includes(q));
  const current = props.current.trim().toLowerCase();

  return (
    <div className="recent-workspaces">
      <div className="input-group">
        <input value={filter} aria-label={t('ws.filter')} placeholder={t('ws.filter')} onChange={(e) => setFilter(e.target.value)} />
        <button type="button" className="icon-btn" title={t('common.refresh')} aria-label={t('common.refresh')} disabled={loading} onClick={() => load()}>
          <Icon name="refresh" />
        </button>
      </div>
      <label className="check recent-history">
        <input type="checkbox" checked={history} onChange={(e) => toggleHistory(e.target.checked)} />
        <span>{t('ws.includeHistory')}</span>
      </label>
      {loading && <div className="hint">{t('ws.loading')}</div>}
      {error && <div className="error-text">{error}</div>}
      {data?.errors.map((e) => (
        <div key={e.source} className="error-text">
          {lz(e.message)}
        </div>
      ))}
      {!loading && data && list.length === 0 && (
        <div className="hint">{q ? t('ws.noMatch') : history ? t('ws.none') : t('ws.noneMembers')}</div>
      )}
      <ul>
        {list.map((w) => (
          <li key={w.path}>
            <button
              type="button"
              className={`recent-item${w.path.toLowerCase() === current ? ' selected' : ''}`}
              title={w.path}
              onClick={() => props.onPick(w.path)}
            >
              <span className="recent-name">{w.name}</span>
              <span className="recent-path">{w.path}</span>
              <span className="recent-meta">
                {w.sources.map((s) => (
                  <span key={s} className="chip" title={sourceTip[s]}>
                    {sourceLabel[s]}
                  </span>
                ))}
                {w.lastUsedAt && <span>{formatDate(w.lastUsedAt)}</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Folders most people never pick: dot-folders, `$Recycle.Bin`, `System Volume Information` and the like. */
function isHiddenDir(name: string): boolean {
  return name.startsWith('.') || name.startsWith('$') || name === 'System Volume Information';
}

/**
 * In-app folder browser (web build; the desktop app uses the native dialog). Like the Windows picker: a click selects
 * a folder, a double click or Enter opens it, and "Select" takes the selected folder (or the one being shown).
 */
function FolderBrowser(props: { start: string | null; onPick: (path: string) => void; onCancel: () => void }) {
  const t = useT();
  const [listing, setListing] = useState<DirListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  function open(path: string | null, fallback?: boolean) {
    setLoading(true);
    setError(null);
    api
      .listDirs(path)
      .then(
        (l) => {
          setListing(l);
          setFilter('');
          setSelected(null);
        },
        (e) => {
          if (fallback) return open(null);
          setError(errorText(e));
        },
      )
      .finally(() => setLoading(false));
  }
  useEffect(() => open(props.start, true), []);

  const q = filter.trim().toLowerCase();
  const all = listing?.dirs ?? [];
  const shown = all.filter((d) => (q ? d.name.toLowerCase().includes(q) : !isHiddenDir(d.name)));
  const hiddenCount = q ? 0 : all.length - shown.length;
  const target = selected ?? listing?.path ?? null;
  const placeLabel = (p: DirListing['places'][number]) => t(`ws.place_${p.id}`);
  // The top level is the drive list on Windows ("This PC") and `/` elsewhere (Finder calls it "Computer").
  const rootLabel = t(/Windows/i.test(navigator.userAgent) ? 'ws.thisPc' : 'ws.computer');

  return (
    <Dialog
      title={t('ws.choose')}
      className="folder-browser"
      onClose={props.onCancel}
      actions={
        <>
          <span className="folder-target mono" title={target ?? undefined}>
            {target ?? ''}
          </span>
          <button type="button" onClick={props.onCancel}>
            {t('common.cancel')}
          </button>
          <button type="button" className="primary" disabled={!target || loading} onClick={() => target && props.onPick(target)}>
            {t('ws.select')}
          </button>
        </>
      }
    >
      <div className="folder-places">
        <button type="button" className="chip-btn" onClick={() => open(null)}>
          {rootLabel}
        </button>
        {listing?.places.map((p) => (
          <button key={p.path} type="button" className="chip-btn" title={p.path} onClick={() => open(p.path)}>
            {placeLabel(p)}
          </button>
        ))}
      </div>
      <div className="folder-current">
        <button
          type="button"
          className="icon-btn"
          title={t('ws.up')}
          aria-label={t('ws.up')}
          disabled={!listing?.path || loading}
          onClick={() => open(listing?.parent ?? null)}
        >
          <Icon name="arrowUp" />
        </button>
        <span className="mono" title={listing?.path ?? undefined}>
          {listing?.path ?? rootLabel}
        </span>
        {loading && <span className="spinner" aria-label={t('ws.loading')} />}
      </div>
      <input
        value={filter}
        aria-label={t('ws.filterFolders')}
        placeholder={t('ws.filterFolders')}
        onChange={(e) => {
          setFilter(e.target.value);
          setSelected(null);
        }}
        onKeyDown={(e) => {
          // Enter in the filter opens the only (or first) match: type a few letters, press Enter, keep going.
          if (e.key === 'Enter' && shown[0]) {
            e.preventDefault();
            open(shown[0].path);
          }
        }}
      />
      {error && <div className="error-text">{error}</div>}
      <ul className={`folder-list${loading ? ' is-loading' : ''}`} aria-busy={loading}>
        {shown.map((d) => (
          <li key={d.path}>
            <button
              type="button"
              className={`folder-item${selected === d.path ? ' selected' : ''}`}
              aria-pressed={selected === d.path}
              title={t('ws.openHint')}
              onClick={() => setSelected(d.path)}
              onDoubleClick={() => open(d.path)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  open(d.path);
                }
              }}
            >
              <Icon name="folder" /> <span className="folder-name">{d.name}</span>
              {d.git && <span className="chip">Git</span>}
            </button>
          </li>
        ))}
        {listing && !loading && shown.length === 0 && <li className="hint">{q ? t('ws.noMatch') : t('ws.noSub')}</li>}
      </ul>
      {hiddenCount > 0 && <div className="hint">{t('ws.hiddenDirs', { n: hiddenCount })}</div>}
      {listing?.truncated && <div className="hint">{t('ws.truncated')}</div>}
    </Dialog>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
}

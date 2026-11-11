import { useEffect, useState } from 'react';
import {
  CHAT_API_FORMATS,
  CHAT_MODEL_FIELD_NAMES,
  DEFAULT_CHAT_MEMBER,
  type ChatApiFormat,
  type ChatConnectionCheck,
  type ChatMemberSettings,
  type ChatModel,
  type ChatModelFields,
  type ChatModelTest,
  type ChatPreset,
  type ChatProvider,
  type ChatProvidersResponse,
  type SaveChatModelRequest,
  type SaveChatProviderRequest,
} from '../../../shared/protocol.ts';
import { api } from '../api.ts';
import { useLocalized, useT, type TFunc } from '../i18n.tsx';
import { compactNumber } from '../format.ts';
import { Dialog, errorText } from './Dialog.tsx';
import { HelpTip } from './HelpTip.tsx';
import { Icon } from './Icon.tsx';

// ---- shared state ----

let cached: ChatProvidersResponse | null = null;
const listeners = new Set<(r: ChatProvidersResponse) => void>();
function publish(r: ChatProvidersResponse) {
  cached = r;
  for (const l of listeners) l(r);
}
/** Loads the providers again and tells every open view. */
export async function reloadChatProviders(): Promise<ChatProvidersResponse> {
  const r = await api.chatProviders();
  publish(r);
  return r;
}
/** Replaces one provider in the shared state (after a change that returned it). */
function putProvider(p: ChatProvider) {
  if (!cached) return void reloadChatProviders().catch(() => undefined);
  const has = cached.providers.some((x) => x.id === p.id);
  publish({ ...cached, providers: has ? cached.providers.map((x) => (x.id === p.id ? p : x)) : [...cached.providers, p] });
}

export function useChatProviders() {
  const [data, setData] = useState<ChatProvidersResponse | null>(cached);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    listeners.add(setData);
    reloadChatProviders().then(
      () => setError(null),
      (e) => setError(errorText(e)),
    );
    return () => void listeners.delete(setData);
  }, []);
  return { data, error };
}

const FORMAT_NAME: Record<ChatApiFormat, string> = {
  openai_chat: 'OpenAI Chat Completions',
  anthropic: 'Anthropic Messages',
  openai_responses: 'OpenAI Responses',
  gemini: 'Gemini',
};

const EFFORTS = new Set(['none', 'off', 'on', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
export const reasoningName = (t: TFunc, s: string) =>
  s === 'disabled' || s === 'none' ? t('effort.off') : s === 'enabled' ? t('effort.on') : EFFORTS.has(s) ? t(`effort.${s}` as Parameters<TFunc>[0]) : s;

const modelName = (m: Pick<ChatModel, 'id' | 'displayName'>) => (m.displayName && m.displayName !== m.id ? `${m.displayName} · ${m.id}` : m.id);

/** Providers a chat member can use: on, not from an older version, with at least one model on. */
export const usableProviders = (data: ChatProvidersResponse | null): ChatProvider[] =>
  (data?.providers ?? []).filter((p) => p.enabled && !p.legacy && p.models.some((m) => m.enabled));

// ---- the provider pages (shown inside Settings) ----

/** A page Settings shows in place of its own content: a new provider, one provider, or one of its models. */
export type ProviderView = { kind: 'new'; preset: ChatPreset | null } | { kind: 'provider'; id: string } | { kind: 'model'; id: string; modelId: string };

/** The providers part of the Settings page: the saved providers and the presets to add one. */
export function ProviderSettings(props: { onOpen: (view: ProviderView) => void }) {
  const t = useT();
  const { data, error } = useChatProviders();
  if (!data) return error ? <div className="error-text">{error}</div> : <div className="hint">{t('common.loading')}</div>;
  return <ProviderList data={data} onOpen={(id) => props.onOpen({ kind: 'provider', id })} onNew={(preset) => props.onOpen({ kind: 'new', preset })} />;
}

/**
 * Title, footer and content of a provider page; null when Settings shows its own content. `onView(null)` goes back to
 * Settings.
 */
export function useProviderPage(view: ProviderView | null, onView: (v: ProviderView | null) => void) {
  const t = useT();
  const { data, error } = useChatProviders();
  const [busy, setBusy] = useState(false);
  if (!view) return null;
  const provider = view.kind === 'provider' || view.kind === 'model' ? data?.providers.find((p) => p.id === view.id) : undefined;
  const model = view.kind === 'model' ? provider?.models.find((m) => m.id === view.modelId) : undefined;
  const back = () => onView(view.kind === 'model' ? { kind: 'provider', id: view.id } : null);
  const title = view.kind === 'new' ? t('cp.addProvider') : view.kind === 'model' ? (model?.id ?? t('cp.providers')) : (provider?.label ?? t('cp.providers'));
  const actions = (
    <>
      <button type="button" className="push-left" disabled={busy} onClick={back}>
        {t('common.back')}
      </button>
      <button type="submit" form="chat-provider-form" className="primary" disabled={busy}>
        {busy ? t('common.saving') : view.kind === 'new' ? t('common.create') : t('common.save')}
      </button>
    </>
  );
  const body = !data ? (
    error ? <div className="error-text">{error}</div> : <div className="hint">{t('common.loading')}</div>
  ) : view.kind === 'new' ? (
    <ProviderForm
      key={`new-${view.preset?.id ?? 'custom'}`}
      data={data}
      preset={view.preset}
      provider={null}
      onBusy={setBusy}
      onSaved={(p) => onView({ kind: 'provider', id: p.id })}
      onDeleted={() => onView(null)}
      onModel={() => undefined}
    />
  ) : view.kind === 'provider' && provider ? (
    <ProviderForm
      key={provider.id}
      data={data}
      preset={data.presets.find((p) => p.id === provider.presetId) ?? null}
      provider={provider}
      onBusy={setBusy}
      onSaved={() => undefined}
      onDeleted={() => onView(null)}
      onModel={(modelId) => onView({ kind: 'model', id: provider.id, modelId })}
    />
  ) : view.kind === 'model' && provider && model ? (
    <ModelForm key={`${provider.id}/${model.id}`} provider={provider} model={model} onBusy={setBusy} onRemoved={back} />
  ) : (
    <div className="error-text">{t('cp.notFound')}</div>
  );
  return { title, busy, actions, body };
}

function keyStatus(p: ChatProvider, t: TFunc): { text: string; warn: boolean } {
  if (p.legacy) return { text: t('cp.legacy'), warn: true };
  if (p.key.kind === 'app') return { text: t('cp.keyApp', { hint: p.key.hint }), warn: false };
  if (p.key.kind === 'env') return { text: `$${p.key.name}${p.key.present ? '' : ` · ${t('cp.envMissing')}`}`, warn: !p.key.present };
  return { text: t('cp.keyNone'), warn: false };
}

function ProviderList(props: { data: ChatProvidersResponse; onOpen: (id: string) => void; onNew: (preset: ChatPreset | null) => void }) {
  const t = useT();
  return (
    <div className="form">
      {props.data.providers.length > 0 && (
        <ul className="pick-list">
          {props.data.providers.map((p) => {
            const k = keyStatus(p, t);
            const on = p.models.filter((m) => m.enabled).length;
            return (
              <li key={p.id}>
                <button type="button" className={`choice provider-row${p.enabled ? '' : ' disabled'}`} onClick={() => props.onOpen(p.id)}>
                  <span className="choice-main">
                    <span className="choice-title">
                      {p.label}
                      {!p.enabled && <span className="badge badge-off">{t('cp.off')}</span>}
                    </span>
                    <span className="choice-sub">
                      {FORMAT_NAME[p.format]} · {t('cp.modelCount', { n: on })} · <span className={k.warn ? 'warn-text' : undefined}>{k.text}</span>
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="field">
        <span className="field-label">{t('cp.addProvider')}</span>
        <div className="preset-grid">
          {props.data.presets.map((p) => (
            <button key={p.id} type="button" onClick={() => props.onNew(p)}>
              {p.label}
            </button>
          ))}
          <button type="button" onClick={() => props.onNew(null)}>
            {t('cp.custom')}
          </button>
        </div>
      </div>
    </div>
  );
}

type KeyKind = 'none' | 'env' | 'app';

function ProviderForm(props: {
  data: ChatProvidersResponse;
  preset: ChatPreset | null;
  provider: ChatProvider | null;
  onBusy: (b: boolean) => void;
  onSaved: (p: ChatProvider) => void;
  onDeleted: () => void;
  onModel: (modelId: string) => void;
}) {
  const t = useT();
  const lz = useLocalized();
  const p = props.provider;
  const [label, setLabel] = useState(p?.label ?? props.preset?.label ?? '');
  const [format, setFormat] = useState<ChatApiFormat>(p?.format ?? props.preset?.format ?? 'openai_chat');
  const [baseUrl, setBaseUrl] = useState(p?.baseUrl ?? props.preset?.baseUrl ?? '');
  const [enabled, setEnabled] = useState(p?.enabled ?? true);
  const [vertexProject, setVertexProject] = useState(p?.vertexProject ?? '');
  const [vertexLocation, setVertexLocation] = useState(p?.vertexLocation ?? (props.preset?.vertex ? 'global' : ''));
  const startKind: KeyKind = p ? (p.key.kind === 'none' && !p.legacy ? 'none' : p.key.kind === 'none' ? (props.data.appKeys ? 'app' : 'env') : p.key.kind) : props.data.appKeys ? 'app' : 'env';
  const [keyKind, setKeyKind] = useState<KeyKind>(startKind);
  const [envName, setEnvName] = useState(p?.key.kind === 'env' ? p.key.name : '');
  const [keyValue, setKeyValue] = useState('');
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [check, setCheck] = useState<ChatConnectionCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [newModel, setNewModel] = useState('');
  const [deleting, setDeleting] = useState(false);
  // Every preset's API needs a key: "no key" is for a custom endpoint (a local model, your own proxy).
  const keyKinds: KeyKind[] = !props.preset || (p?.key.kind === 'none' && !p.legacy) ? ['app', 'env', 'none'] : ['app', 'env'];
  const vertex = format === 'gemini' && (!!props.preset?.vertex || /aiplatform\.googleapis\.com/.test(baseUrl) || !!p?.vertexProject);

  const keyRequest = (): SaveChatProviderRequest['key'] | undefined => {
    if (keyKind === 'none') return p && p.key.kind === 'none' && !p.legacy ? undefined : { kind: 'none' };
    if (keyKind === 'env') {
      const name = envName.trim();
      return p?.key.kind === 'env' && p.key.name === name ? undefined : { kind: 'env', name };
    }
    const value = keyValue.trim();
    return value ? { kind: 'app', value } : undefined;
  };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    props.onBusy(true);
    setResult(null);
    try {
      const key = keyRequest();
      const req: SaveChatProviderRequest = {
        label: label.trim(),
        format,
        baseUrl: baseUrl.trim(),
        enabled,
        ...(vertex ? { vertexProject: vertexProject.trim() || null, vertexLocation: vertexLocation.trim() || null } : {}),
        ...(key ? { key } : {}),
      };
      const saved = p ? await api.updateChatProvider(p.id, req) : await api.createChatProvider({ ...req, presetId: props.preset?.id ?? null });
      putProvider(saved);
      setKeyValue('');
      setResult({ ok: true, text: t('agent.saved') });
      props.onSaved(saved);
    } catch (err) {
      setResult({ ok: false, text: errorText(err) });
    } finally {
      props.onBusy(false);
    }
  }

  async function runCheck() {
    if (!p) return;
    setChecking(true);
    setCheck(null);
    try {
      setCheck(await api.checkChatProvider(p.id));
    } catch (err) {
      setCheck({ ok: false, models: [], listed: false, error: { zh: errorText(err), en: errorText(err) } });
    } finally {
      setChecking(false);
    }
  }

  async function addModel(id: string) {
    if (!p || !id.trim()) return;
    setResult(null);
    try {
      putProvider(await api.addChatModel(p.id, id.trim()));
      setNewModel('');
    } catch (err) {
      setResult({ ok: false, text: errorText(err) });
    }
  }

  async function toggleModel(m: ChatModel, on: boolean) {
    if (!p) return;
    try {
      putProvider(await api.updateChatModel(p.id, m.id, { fields: { enabled: on } }));
    } catch (err) {
      setResult({ ok: false, text: errorText(err) });
    }
  }

  const listed = new Set(p?.models.map((m) => m.id) ?? []);
  const unlisted = check?.models.filter((id) => !listed.has(id)) ?? [];

  return (
    <>
      <form id="chat-provider-form" className="form" noValidate onSubmit={(e) => void save(e)}>
        <div className="field-row">
          <div className="field">
            <label className="field-label" htmlFor="cp-label">
              {t('cp.name')}
            </label>
            <input id="cp-label" value={label} maxLength={100} onChange={(e) => setLabel(e.target.value)} />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="cp-format">
              {t('cp.format')}
            </label>
            <select id="cp-format" value={format} onChange={(e) => setFormat(e.target.value as ChatApiFormat)}>
              {CHAT_API_FORMATS.map((f) => (
                <option key={f} value={f}>
                  {FORMAT_NAME[f]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="cp-url">
            Base URL
          </label>
          <input id="cp-url" className="mono" value={baseUrl} spellCheck={false} onChange={(e) => setBaseUrl(e.target.value)} />
        </div>
        {vertex && (
          <div className="field-row">
            <div className="field">
              <label className="field-label" htmlFor="cp-vproject">
                {t('cp.vertexProject')}
              </label>
              <input id="cp-vproject" className="mono" value={vertexProject} spellCheck={false} onChange={(e) => setVertexProject(e.target.value)} />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="cp-vloc">
                {t('cp.vertexLocation')}
              </label>
              <input id="cp-vloc" className="mono" value={vertexLocation} spellCheck={false} onChange={(e) => setVertexLocation(e.target.value)} />
            </div>
          </div>
        )}
        <div className="field">
          <span className="field-label">
            API Key <HelpTip text={t('cp.keyHelp')} />
          </span>
          <div className="key-kinds" role="radiogroup" aria-label="API Key">
            {keyKinds.map((k) => {
              const off = k === 'app' && !props.data.appKeys;
              return (
                <label key={k} className={`check${off ? ' disabled' : ''}`} title={off ? t('cp.keyAppUnavailable') : undefined}>
                  <input type="radio" name="cp-key" checked={keyKind === k} disabled={off} onChange={() => setKeyKind(k)} />
                  <span>{t(`cp.key_${k}`)}</span>
                </label>
              );
            })}
          </div>
          {keyKind === 'app' && (
            <input
              type="password"
              aria-label="API Key"
              autoComplete="off"
              value={keyValue}
              placeholder={p?.key.kind === 'app' ? `••••${p.key.hint}` : ''}
              onChange={(e) => setKeyValue(e.target.value)}
            />
          )}
          {keyKind === 'env' && (
            <div className="input-prefix">
              <span>$</span>
              <input aria-label={t('cp.key_env')} className="mono" value={envName} spellCheck={false} onChange={(e) => setEnvName(e.target.value)} />
            </div>
          )}
          {p && keyKind === p.key.kind && p.key.kind === 'env' && p.key.name === envName.trim() && !p.key.present && (
            <div className="warn-text">{t('cp.envMissing')}</div>
          )}
        </div>
        <label className="check">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span>{t('cp.enabled')}</span>
        </label>
        {result && <div className={result.ok ? 'ok-text' : 'error-text'}>{result.text}</div>}
      </form>

      {p && (
        <>
          <div className="field">
            <div className="field-head">
              <span className="field-label">{t('cp.models')}</span>
              <button type="button" disabled={checking} onClick={() => void runCheck()}>
                {checking ? t('cp.checking') : t('cp.check')}
              </button>
            </div>
            {check && (
              <div className={check.ok ? 'ok-text' : 'error-text'}>
                {check.ok ? (check.listed ? t('cp.checkOk', { n: check.models.length }) : t('cp.checkOkNoList')) : lz(check.error) || t('cp.checkFailed')}
              </div>
            )}
            <ul className="model-list">
              {p.models.map((m) => (
                <li key={m.id}>
                  <input type="checkbox" aria-label={t('cp.enabled')} checked={m.enabled} onChange={(e) => void toggleModel(m, e.target.checked)} />
                  <button type="button" className="link model-name" onClick={() => props.onModel(m.id)}>
                    {modelName(m)}
                  </button>
                  <span className="model-tags">
                    <span className="badge" title={t('cp.contextTokens')}>
                      {compactNumber(m.contextTokens)}
                    </span>
                    {m.image && <span className="badge">{t('cp.f_image')}</span>}
                    {m.pdf && <span className="badge">PDF</span>}
                    {m.webSearch && <span className="badge">{t('cp.f_webSearch')}</span>}
                    {!m.tools && <span className="badge badge-off">{t('cp.f_tools')}</span>}
                  </span>
                  {m.reasoningLevels.length > 0 && <span className="muted">{m.reasoningLevels.map((l) => reasoningName(t, l)).join(' / ')}</span>}
                  <button type="button" className="icon-btn" aria-label={t('cp.editModel')} title={t('cp.editModel')} onClick={() => props.onModel(m.id)}>
                    <Icon name="edit" size={14} />
                  </button>
                </li>
              ))}
            </ul>
            <div className="input-group">
              <input
                className="mono"
                aria-label={t('cp.modelId')}
                placeholder={t('cp.modelId')}
                value={newModel}
                spellCheck={false}
                onChange={(e) => setNewModel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void addModel(newModel);
                  }
                }}
              />
              <button type="button" disabled={!newModel.trim()} onClick={() => void addModel(newModel)}>
                {t('common.add')}
              </button>
            </div>
            {unlisted.length > 0 && (
              <details className="sessions">
                <summary>{t('cp.fromList', { n: unlisted.length })}</summary>
                <ul className="model-list">
                  {unlisted.map((id) => (
                    <li key={id}>
                      <span className="mono model-name">{id}</span>
                      <button type="button" onClick={() => void addModel(id)}>
                        {t('common.add')}
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
          <div>
            <button type="button" className="danger-outline" onClick={() => setDeleting(true)}>
              {t('cp.deleteProvider')}
            </button>
          </div>
          {deleting && (
            <ConfirmAction
              title={t('cp.deleteProviderTitle', { name: p.label })}
              confirmLabel={t('common.delete')}
              busyLabel={t('common.deleting')}
              danger
              onConfirm={async () => {
                await api.deleteChatProvider(p.id);
                await reloadChatProviders();
                props.onDeleted();
              }}
              onClose={() => setDeleting(false)}
            />
          )}
        </>
      )}
    </>
  );
}

/** A small confirm dialog whose action may fail (the error stays in the dialog). */
function ConfirmAction(props: {
  title: string;
  body?: string;
  confirmLabel: string;
  busyLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      alert
      title={props.title}
      busy={busy}
      onClose={props.onClose}
      actions={
        <>
          <button type="button" disabled={busy} onClick={props.onClose} autoFocus>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={props.danger ? 'danger' : 'primary'}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await props.onConfirm();
                props.onClose();
              } catch (e) {
                setError(errorText(e));
                setBusy(false);
              }
            }}
          >
            {busy ? props.busyLabel : props.confirmLabel}
          </button>
        </>
      }
    >
      {props.body && <p>{props.body}</p>}
      {error && <div className="error-text">{error}</div>}
    </Dialog>
  );
}

// ---- one model ----

type Draft = {
  displayName: string;
  enabled: boolean;
  contextTokens: string;
  maxOutputTokens: string;
  compactAt: string;
  image: boolean;
  pdf: boolean;
  tools: boolean;
  webSearch: boolean;
  explicitCache: boolean;
  replayReasoning: boolean;
  reasoningLevels: string;
  reasoningMapping: string;
  extraBody: string;
  extraHeaders: string;
  priceInput: string;
  priceOutput: string;
  priceCacheRead: string;
  priceCacheWrite: string;
};

function draftOf(m: ChatModelFields): Draft {
  return {
    displayName: m.displayName,
    enabled: m.enabled,
    contextTokens: String(m.contextTokens),
    maxOutputTokens: String(m.maxOutputTokens),
    compactAt: String(m.compactAt),
    image: m.image,
    pdf: m.pdf,
    tools: m.tools,
    webSearch: m.webSearch,
    explicitCache: m.explicitCache,
    replayReasoning: m.replayReasoning,
    reasoningLevels: m.reasoningLevels.join(', '),
    reasoningMapping: m.reasoningMapping,
    extraBody: m.extraBody,
    extraHeaders: m.extraHeaders,
    priceInput: m.price ? String(m.price.input) : '',
    priceOutput: m.price ? String(m.price.output) : '',
    priceCacheRead: m.price ? String(m.price.cacheRead) : '',
    priceCacheWrite: m.price ? String(m.price.cacheWrite) : '',
  };
}

class DraftError extends Error {}

const num = (s: string, what: string): number => {
  const n = Number(s.trim());
  if (!s.trim() || !Number.isFinite(n)) throw new DraftError(what);
  return n;
};

/** The fields of a draft as the model would store them (throws DraftError naming a field that is not a number). */
function fieldsOf(d: Draft, t: TFunc): ChatModelFields {
  const prices = [d.priceInput, d.priceOutput, d.priceCacheRead, d.priceCacheWrite];
  const price = prices.every((x) => !x.trim())
    ? null
    : {
        input: num(d.priceInput, t('cp.priceInput')),
        output: num(d.priceOutput, t('cp.priceOutput')),
        cacheRead: d.priceCacheRead.trim() ? num(d.priceCacheRead, t('cp.priceCacheRead')) : 0,
        cacheWrite: d.priceCacheWrite.trim() ? num(d.priceCacheWrite, t('cp.priceCacheWrite')) : 0,
      };
  return {
    displayName: d.displayName.trim(),
    enabled: d.enabled,
    contextTokens: num(d.contextTokens, t('cp.contextTokens')),
    maxOutputTokens: num(d.maxOutputTokens, t('cp.maxOutputTokens')),
    compactAt: num(d.compactAt, t('cp.compactAt')),
    image: d.image,
    pdf: d.pdf,
    tools: d.tools,
    webSearch: d.webSearch,
    explicitCache: d.explicitCache,
    replayReasoning: d.replayReasoning,
    reasoningLevels: d.reasoningLevels
      .split(/[,，\s]+/)
      .map((x) => x.trim())
      .filter(Boolean),
    reasoningMapping: d.reasoningMapping.trim(),
    extraBody: d.extraBody.trim(),
    extraHeaders: d.extraHeaders.trim(),
    price,
  };
}

function ModelForm(props: { provider: ChatProvider; model: ChatModel; onBusy: (b: boolean) => void; onRemoved: () => void }) {
  const t = useT();
  const lz = useLocalized();
  const m = props.model;
  const [d, setD] = useState<Draft>(() => draftOf(m));
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [asking, setAsking] = useState<'test' | 'remove' | null>(null);
  const [test, setTest] = useState<ChatModelTest | null>(null);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const manual = new Set(m.manual);
  const mark = (k: keyof ChatModelFields) => (manual.has(k) ? ' manual' : '');

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setResult(null);
    let next: ChatModelFields;
    try {
      next = fieldsOf(d, t);
    } catch (err) {
      if (err instanceof DraftError) return setResult({ ok: false, text: t('cp.notNumber', { field: err.message }) });
      throw err;
    }
    const fields: SaveChatModelRequest['fields'] = {};
    for (const k of CHAT_MODEL_FIELD_NAMES) {
      if (JSON.stringify(next[k]) !== JSON.stringify(m[k])) (fields as Record<string, unknown>)[k] = next[k];
    }
    if (!Object.keys(fields).length) return setResult({ ok: true, text: t('agent.noChange') });
    props.onBusy(true);
    try {
      const p = await api.updateChatModel(props.provider.id, m.id, { fields });
      putProvider(p);
      const saved = p.models.find((x) => x.id === m.id);
      if (saved) setD(draftOf(saved));
      setResult({ ok: true, text: t('agent.saved') });
    } catch (err) {
      setResult({ ok: false, text: errorText(err) });
    } finally {
      props.onBusy(false);
    }
  }

  async function resetAll() {
    setResult(null);
    props.onBusy(true);
    try {
      const fields: SaveChatModelRequest['fields'] = {};
      for (const k of m.manual) (fields as Record<string, null>)[k] = null;
      const p = await api.updateChatModel(props.provider.id, m.id, { fields });
      putProvider(p);
      const saved = p.models.find((x) => x.id === m.id);
      if (saved) setD(draftOf(saved));
      setResult({ ok: true, text: t('agent.saved') });
    } catch (err) {
      setResult({ ok: false, text: errorText(err) });
    } finally {
      props.onBusy(false);
    }
  }

  const check = (k: 'enabled' | 'image' | 'pdf' | 'tools' | 'webSearch' | 'explicitCache' | 'replayReasoning') => (
    <label className={`check${mark(k)}`}>
      <input type="checkbox" checked={d[k]} onChange={(e) => set(k, e.target.checked)} />
      <span>{t(`cp.f_${k}`)}</span>
    </label>
  );
  const text = (k: 'displayName' | 'contextTokens' | 'maxOutputTokens' | 'compactAt' | 'reasoningLevels', label: string, mono = false) => (
    <div className={`field${mark(k)}`}>
      <label className="field-label" htmlFor={`cm-${k}`}>
        {label}
      </label>
      <input id={`cm-${k}`} className={mono ? 'mono' : undefined} value={d[k]} spellCheck={false} onChange={(e) => set(k, e.target.value)} />
    </div>
  );
  const area = (k: 'reasoningMapping' | 'extraBody' | 'extraHeaders', label: string) => (
    <div className={`field${mark(k)}`}>
      <label className="field-label" htmlFor={`cm-${k}`}>
        {label}
      </label>
      <textarea id={`cm-${k}`} className="mono" rows={3} value={d[k]} spellCheck={false} onChange={(e) => set(k, e.target.value)} />
    </div>
  );
  const LIST_KEY = { priceInput: 'input', priceOutput: 'output', priceCacheRead: 'cacheRead', priceCacheWrite: 'cacheWrite' } as const;
  const price = (k: 'priceInput' | 'priceOutput' | 'priceCacheRead' | 'priceCacheWrite') => (
    <div className="field">
      <label className="field-label" htmlFor={`cm-${k}`}>
        {t(`cp.${k}`)}
      </label>
      <input
        id={`cm-${k}`}
        inputMode="decimal"
        value={d[k]}
        placeholder={m.listPrice ? String(m.listPrice[LIST_KEY[k]]) : undefined}
        onChange={(e) => set(k, e.target.value)}
      />
    </div>
  );

  return (
    <>
      <form id="chat-provider-form" className="form" noValidate onSubmit={(e) => void save(e)}>
        {text('displayName', t('cp.displayName'))}
        {check('enabled')}
        <div className="field-row">
          {text('contextTokens', t('cp.contextTokens'))}
          {text('maxOutputTokens', t('cp.maxOutputTokens'))}
        </div>
        <div className="check-grid">
          {check('image')}
          {check('pdf')}
          {check('tools')}
          {check('webSearch')}
          {check('explicitCache')}
          {check('replayReasoning')}
        </div>
        <div className="field-row">
          {text('reasoningLevels', t('cp.reasoningLevels'), true)}
          {text('compactAt', t('cp.compactAt'))}
        </div>
        {area('reasoningMapping', t('cp.reasoningMapping'))}
        {area('extraBody', t('cp.extraBody'))}
        {area('extraHeaders', t('cp.extraHeaders'))}
        <div className={`field${mark('price')}`}>
          <span className="field-label">{t('cp.price')}</span>
          <div className="price-grid">
            {price('priceInput')}
            {price('priceOutput')}
            {price('priceCacheRead')}
            {price('priceCacheWrite')}
          </div>
        </div>
        {result && <div className={result.ok ? 'ok-text' : 'error-text'}>{result.text}</div>}
      </form>
      <div className="button-row">
        <button type="button" disabled={!m.manual.length} onClick={() => void resetAll()}>
          {t('cp.resetRecommended')}
        </button>
        <button type="button" onClick={() => setAsking('test')}>
          {t('cp.test')}
        </button>
        <button type="button" className="danger-outline push-left" onClick={() => setAsking('remove')}>
          {t('cp.removeModel')}
        </button>
      </div>
      {test && (
        <div className={test.ok ? 'test-result' : 'error-text'}>
          {test.ok ? (
            <>
              <div>{test.text || '—'}</div>
              {test.usage && (
                <div className="muted">
                  {t('cp.testUsage', { input: test.usage.input, cache: test.usage.cacheRead, output: test.usage.output })}
                </div>
              )}
            </>
          ) : (
            lz(test.error) || t('cp.checkFailed')
          )}
        </div>
      )}
      {asking === 'test' && (
        <ConfirmAction
          title={t('cp.testTitle', { model: m.id })}
          body={t('cp.testBody', { provider: props.provider.label })}
          confirmLabel={t('cp.testSend')}
          busyLabel={t('cp.testing')}
          onConfirm={async () => {
            setTest(null);
            setTest(await api.testChatModel(props.provider.id, m.id));
          }}
          onClose={() => setAsking(null)}
        />
      )}
      {asking === 'remove' && (
        <ConfirmAction
          title={t('cp.removeModelTitle', { model: m.id })}
          confirmLabel={t('common.delete')}
          busyLabel={t('common.deleting')}
          danger
          onConfirm={async () => {
            putProvider(await api.removeChatModel(props.provider.id, m.id));
            props.onRemoved();
          }}
          onClose={() => setAsking(null)}
        />
      )}
    </>
  );
}

// ---- chat member fields (add-member form and member dialog) ----

/**
 * Provider, model and reasoning level of a chat member. With `fixedProvider` the provider cannot change. Providers are
 * managed in Settings.
 */
export function ChatModelPicker(props: {
  providerId: string;
  model: string;
  effort: string;
  fixedProvider?: boolean;
  onChange: (v: { providerId: string; model: string; effort: string }) => void;
}) {
  const t = useT();
  const { data, error } = useChatProviders();
  const usable = usableProviders(data);
  const provider = data?.providers.find((p) => p.id === props.providerId) ?? null;
  const models = provider?.models.filter((m) => m.enabled || m.id === props.model) ?? [];
  const selected = provider?.models.find((m) => m.id === props.model) ?? null;
  const levels = selected?.reasoningLevels ?? [];

  // Start with the first usable provider and its first model.
  useEffect(() => {
    if (!data || props.fixedProvider) return;
    if (provider && usable.some((p) => p.id === provider.id)) return;
    const first = usable[0];
    const m = first?.models.find((x) => x.enabled);
    if (first && m) props.onChange({ providerId: first.id, model: m.id, effort: '' });
    else if (props.providerId) props.onChange({ providerId: '', model: '', effort: '' });
  }, [data]);

  const pickProvider = (id: string) => {
    const p = usable.find((x) => x.id === id);
    const m = p?.models.find((x) => x.enabled);
    props.onChange({ providerId: id, model: m?.id ?? '', effort: '' });
  };

  return (
    <>
      {!data ? (
        error ? <div className="error-text">{error}</div> : <div className="hint">{t('common.loading')}</div>
      ) : usable.length === 0 && !props.fixedProvider ? null : (
        <>
          <div className="field">
            <label className="field-label" htmlFor="chat-provider">
              {t('cp.provider')}
            </label>
            <select id="chat-provider" value={props.providerId} disabled={props.fixedProvider} onChange={(e) => pickProvider(e.target.value)}>
              {props.fixedProvider && provider && !usable.includes(provider) && <option value={provider.id}>{provider.label}</option>}
              {(props.fixedProvider ? usable.filter((p) => p.id === props.providerId) : usable).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
              {!provider && <option value={props.providerId}>{props.providerId ? t('cp.notFound') : '—'}</option>}
            </select>
          </div>
          <div className="field-row">
            <div className="field">
              <label className="field-label" htmlFor="chat-model">
                {t('model.model')}
              </label>
              <select
                id="chat-model"
                value={props.model}
                onChange={(e) => {
                  const next = provider?.models.find((m) => m.id === e.target.value);
                  props.onChange({ providerId: props.providerId, model: e.target.value, effort: next?.reasoningLevels.includes(props.effort) ? props.effort : '' });
                }}
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {modelName(m)}
                    {m.enabled ? '' : ` · ${t('cp.off')}`}
                  </option>
                ))}
                {props.model && !selected && <option value={props.model}>{t('model.notListed', { model: props.model })}</option>}
              </select>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="chat-effort">
                {t('model.effort')}
              </label>
              <select
                id="chat-effort"
                value={props.effort}
                disabled={!levels.length && !props.effort}
                onChange={(e) => props.onChange({ providerId: props.providerId, model: props.model, effort: e.target.value })}
              >
                <option value="">{t('common.default')}</option>
                {levels.map((l) => (
                  <option key={l} value={l}>
                    {reasoningName(t, l)}
                  </option>
                ))}
                {props.effort && !levels.includes(props.effort) && <option value={props.effort}>{t('model.unsupported', { value: props.effort })}</option>}
              </select>
            </div>
          </div>
        </>
      )}
    </>
  );
}

/** Whether the chosen model offers native web search (the setting is greyed otherwise). */
export function useChatModel(providerId: string, model: string): ChatModel | null {
  const { data } = useChatProviders();
  return data?.providers.find((p) => p.id === providerId)?.models.find((m) => m.id === model) ?? null;
}

export function ChatSettingsFields(props: { value: ChatMemberSettings; model: ChatModel | null; onChange: (v: ChatMemberSettings) => void }) {
  const t = useT();
  const v = props.value;
  const webOff = !!props.model && !props.model.webSearch;
  const fetchOff = !!props.model && !props.model.tools;
  return (
    <>
      <div className="check-grid">
        <label className="check">
          <input type="checkbox" checked={v.projectTools} onChange={(e) => props.onChange({ ...v, projectTools: e.target.checked })} />
          <span>{t('cp.projectTools')}</span>
        </label>
        <label className={`check${webOff ? ' disabled' : ''}`} title={webOff ? t('cp.webSearchUnsupported') : undefined}>
          <input type="checkbox" checked={v.webSearch && !webOff} disabled={webOff} onChange={(e) => props.onChange({ ...v, webSearch: e.target.checked })} />
          <span>{t('cp.webSearch')}</span>
        </label>
        <label className={`check${fetchOff ? ' disabled' : ''}`} title={fetchOff ? t('cp.webFetchUnsupported') : undefined}>
          <input type="checkbox" checked={!!v.webFetch && !fetchOff} disabled={fetchOff} onChange={(e) => props.onChange({ ...v, webFetch: e.target.checked })} />
          <span>{t('cp.webFetch')}</span>
        </label>
      </div>
      <div className="field-row">
        <div className="field">
          <label className="field-label" htmlFor="chat-daily">
            {t('cp.dailyTokenLimit')}
          </label>
          <input
            id="chat-daily"
            inputMode="numeric"
            value={String(v.dailyTokenLimit)}
            onChange={(e) => props.onChange({ ...v, dailyTokenLimit: Math.min(1_000_000_000, Math.max(0, Math.floor(Number(e.target.value.replace(/[,_\s]/g, '')) || 0))) })}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="chat-rounds">
            {t('cp.maxToolRounds')}
          </label>
          <input
            id="chat-rounds"
            inputMode="numeric"
            value={String(v.maxToolRounds)}
            onChange={(e) => props.onChange({ ...v, maxToolRounds: Math.min(200, Math.max(1, Math.floor(Number(e.target.value) || 1))) })}
          />
        </div>
      </div>
    </>
  );
}

export const chatDefaults = (): ChatMemberSettings => ({ ...DEFAULT_CHAT_MEMBER });

/** A chat model as already loaded (display only; no request). */
export function cachedChatModel(providerId: string | null, id: string | null): ChatModel | null {
  if (!providerId || !id) return null;
  return cached?.providers.find((p) => p.id === providerId)?.models.find((m) => m.id === id) ?? null;
}

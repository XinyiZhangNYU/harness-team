import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode, type Ref } from 'react';
import { AVATAR_DEFAULT_KINDS, chatAvatarKey, type AvatarDefaultKey, type BrowserSettings, type BrowserSettingsResponse } from '../../../shared/protocol.ts';
import { api } from '../api.ts';
import type { NotifyState } from '../attention.ts';
import { AvatarError, avatarFromFile, initial } from '../avatar.ts';
import { USER_NAME_MAX, usePrefs, useT, type Lang, type Theme } from '../i18n.tsx';
import { PALETTE_IDS, paletteName, paletteSwatch } from '../themes.ts';
import { ProviderSettings, useChatProviders, useProviderPage, type ProviderView } from './ChatProviders.tsx';
import { Dialog } from './Dialog.tsx';
import { AgentAvatar, RUNTIME_NAME, useAvatarDefault } from './RuntimeBadge.tsx';

type Section = 'avatars' | 'providers' | 'browser';

const LANGS: { value: Lang; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'zh', label: '简体中文' },
];

export function SettingsDialog(props: {
  notify: NotifyState;
  onToggleNotify: () => void;
  onClose: () => void;
}) {
  const { t, lang, theme, palette, dark, setLang, setTheme, setPalette } = usePrefs();
  const themes: { value: Theme; label: string }[] = [
    { value: 'system', label: t('settings.themeSystem') },
    { value: 'light', label: t('settings.themeLight') },
    { value: 'dark', label: t('settings.themeDark') },
  ];
  // A sub-page replaces the settings in the same dialog: member avatars, the providers, or one provider page (whose
  // Back returns to the providers). Back from a section returns to the settings, at the button that opened it.
  const [section, setSection] = useState<Section | null>(null);
  const [providerView, setProviderView] = useState<ProviderView | null>(null);
  const page = useProviderPage(providerView, setProviderView);
  const anchor = useRef<HTMLDivElement>(null);
  const openers = useRef<Partial<Record<Section, HTMLButtonElement | null>>>({});
  const at = page ? 'provider' : (section ?? 'main');
  const was = useRef(at);
  useLayoutEffect(() => {
    const body = anchor.current?.closest<HTMLElement>('.dialog-body');
    const from = was.current;
    if (!body || at === from) return;
    was.current = at;
    if (at === 'main') {
      const b = openers.current[from as Section];
      b?.scrollIntoView({ block: 'nearest' });
      b?.focus();
      return;
    }
    body.scrollTop = 0;
    (body.querySelector<HTMLElement>('input:not([type="hidden"]):not([hidden]), select, textarea') ?? body.querySelector<HTMLElement>('button'))?.focus();
  }, [at]);
  if (page)
    return (
      <Dialog title={page.title} className="settings-dialog settings-page" busy={page.busy} onClose={props.onClose} actions={page.actions}>
        <div ref={anchor} className="contents" />
        {page.body}
      </Dialog>
    );
  if (section) {
    const back = (
      <button type="button" className="push-left" onClick={() => setSection(null)}>
        {t('common.back')}
      </button>
    );
    return (
      <Dialog
        title={section === 'avatars' ? t('settings.memberAvatars') : section === 'browser' ? t('settings.browser') : t('cp.providers')}
        className="settings-dialog settings-page"
        onClose={props.onClose}
        actions={back}
      >
        <div ref={anchor} className="contents" />
        {section === 'avatars' ? (
          <AvatarDefaults />
        ) : section === 'browser' ? (
          <BrowserSettingsPage />
        ) : (
          <ProviderSettings onOpen={setProviderView} />
        )}
      </Dialog>
    );
  }
  return (
    <Dialog title={t('settings.title')} className="settings-dialog" onClose={props.onClose}>
      <div ref={anchor} className="contents" />
      <ProfileSetting
        avatarsButton={
          <button type="button" ref={(b) => void (openers.current.avatars = b)} onClick={() => setSection('avatars')}>
            {t('settings.memberAvatars')}
          </button>
        }
      />
      <section className="settings-row">
        <div className="settings-label">{t('cp.providers')}</div>
        <ProvidersEntry buttonRef={(b) => void (openers.current.providers = b)} onOpen={() => setSection('providers')} />
      </section>
      <section className="settings-row">
        <div className="settings-label">{t('settings.browser')}</div>
        <BrowserEntry buttonRef={(b) => void (openers.current.browser = b)} onOpen={() => setSection('browser')} />
      </section>
      <section className="settings-row">
        <div className="settings-label">{t('settings.language')}</div>
        <Segmented value={lang} options={LANGS} onChange={setLang} label={t('settings.language')} />
      </section>
      <section className="settings-row">
        <div className="settings-label">{t('settings.theme')}</div>
        <Segmented value={theme} options={themes} onChange={setTheme} label={t('settings.theme')} />
      </section>
      <section className="settings-row">
        <div className="settings-label">{t('settings.palette')}</div>
        <div>
          <div className="palette-grid" role="radiogroup" aria-label={t('settings.palette')}>
            {PALETTE_IDS.map((id) => {
              const [accent, bg] = paletteSwatch(id, dark);
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={palette === id}
                  className={palette === id ? 'on' : undefined}
                  onClick={() => setPalette(id)}
                >
                  <span className="palette-swatch" aria-hidden="true">
                    <span style={{ background: bg }} />
                    <span style={{ background: accent }} />
                  </span>
                  {id === 'default' ? t('settings.paletteDefault') : paletteName(id, lang)}
                </button>
              );
            })}
          </div>
        </div>
      </section>
      <section className="settings-row">
        <div className="settings-label">{t('settings.notifications')}</div>
        <div>
          <label className="check">
            <input
              type="checkbox"
              checked={props.notify === 'on'}
              disabled={props.notify === 'unsupported' || props.notify === 'blocked'}
              onChange={props.onToggleNotify}
            />
            {t('settings.notifyApprovals')}
          </label>
          {props.notify === 'blocked' && <div className="hint">{t('settings.notifyBlocked')}</div>}
          {props.notify === 'unsupported' && <div className="hint">{t('settings.notifyUnsupported')}</div>}
        </div>
      </section>
      <DesktopCheck label={t('settings.power')} text={t('settings.keepAwake')} get={(d) => d.getKeepAwake} set={(d) => d.setKeepAwake} />
      <DesktopCheck label={t('settings.updates')} text={t('settings.autoUpdate')} get={(d) => d.getAutoUpdate} set={(d) => d.setAutoUpdate} />
      <DesktopCheck label={t('settings.startup')} text={t('settings.openAtLogin')} get={(d) => d.getOpenAtLogin} set={(d) => d.setOpenAtLogin} />
    </Dialog>
  );
}

type DesktopShell = NonNullable<typeof window.harnessDesktop>;

/**
 * A setting the desktop shell keeps (keep awake, automatic updates, open at login). Shown only where the shell offers
 * it: an older shell lacks the call, and one that does not offer the setting answers null.
 */
function DesktopCheck(props: {
  label: string;
  text: string;
  get: (d: DesktopShell) => (() => Promise<boolean | null>) | undefined;
  set: (d: DesktopShell) => ((on: boolean) => Promise<boolean | null>) | undefined;
}) {
  const desktop = window.harnessDesktop;
  const get = desktop ? props.get(desktop) : undefined;
  const set = desktop ? props.set(desktop) : undefined;
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    get?.().then((v) => live && setOn(v), () => undefined);
    return () => {
      live = false;
    };
  }, [desktop]);
  if (!get || !set || on === null) return null;
  return (
    <section className="settings-row">
      <div className="settings-label">{props.label}</div>
      <div>
        <label className="check">
          <input
            type="checkbox"
            checked={on}
            disabled={busy}
            onChange={(e) => {
              const want = e.target.checked;
              setBusy(true);
              set(want)
                .then((v) => setOn(v ?? on), () => undefined)
                .finally(() => setBusy(false));
            }}
          />
          {props.text}
        </label>
      </div>
    </section>
  );
}

/**
 * Your name and avatar as this app shows them (kept in localStorage). Display only: agents keep seeing "用户".
 * The avatar is an uploaded image (cropped and scaled in the page) or the first letter of the name.
 */
function ProfileSetting(props: { avatarsButton: ReactNode }) {
  const { t, userAvatar, setUserAvatar, userName, setUserName, userLabel } = usePrefs();
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const url = await avatarFromFile(file);
      if (!setUserAvatar(url)) setError(t('settings.avatarSaveFailed'));
    } catch (e) {
      setError(e instanceof AvatarError && e.reason === 'tooBig' ? t('settings.avatarTooBig') : t('settings.avatarError'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-row">
      <div className="settings-label">{t('settings.profile')}</div>
      <div>
        <div className="avatar-setting" role="group" aria-label={t('settings.avatar')}>
          <span className={`avatar avatar-user avatar-lg${userAvatar ? ' has-img' : ''}`} aria-hidden="true">
            {userAvatar ? <img src={userAvatar} alt="" /> : initial(userLabel)}
          </span>
          <button type="button" disabled={busy} onClick={() => input.current?.click()}>
            {userAvatar ? t('settings.avatarChange') : t('settings.avatarUpload')}
          </button>
          {userAvatar && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setError(null);
                if (!setUserAvatar(null)) setError(t('settings.avatarSaveFailed'));
              }}
            >
              {t('settings.avatarRemove')}
            </button>
          )}
          <input
            ref={input}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            hidden
            onChange={(e) => {
              void pick(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </div>
        {error && (
          <div className="error-text" role="alert">
            {error}
          </div>
        )}
        <label className="profile-name">
          <span>{t('settings.name')}</span>
          <input
            value={userName}
            maxLength={USER_NAME_MAX}
            placeholder={t('common.you')}
            autoComplete="off"
            onChange={(e) => setUserName(e.target.value)}
          />
        </label>
        <div className="profile-more">{props.avatarsButton}</div>
      </div>
    </section>
  );
}

/** The providers on the settings page: one entry with the count and names; the list is a page of its own. */
function ProvidersEntry(props: { buttonRef: Ref<HTMLButtonElement>; onOpen: () => void }) {
  const t = useT();
  const { data } = useChatProviders();
  const providers = data?.providers ?? [];
  return (
    <button type="button" ref={props.buttonRef} className="choice provider-row providers-entry" onClick={props.onOpen}>
      <span className="choice-main">
        <span className="choice-title">{t('cp.providerCount', { n: providers.length })}</span>
        {providers.length > 0 && <span className="choice-sub">{providers.map((p) => p.label).join(' · ')}</span>}
      </span>
    </button>
  );
}

const BROWSER_NAME = { chrome: 'Google Chrome', msedge: 'Microsoft Edge', firefox: 'Mozilla Firefox' } as const;

function useBrowserSettings() {
  const [data, setData] = useState<BrowserSettingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.browserSettings().then(
      (r) => live && setData(r),
      (e) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, []);
  return { data, setData, error, setError };
}

function BrowserEntry(props: { buttonRef: Ref<HTMLButtonElement>; onOpen: () => void }) {
  const t = useT();
  const { data } = useBrowserSettings();
  const using = data?.using ? BROWSER_NAME[data.using] : data ? t('settings.browserNone') : '';
  return (
    <button type="button" ref={props.buttonRef} className="choice provider-row providers-entry" onClick={props.onOpen}>
      <span className="choice-main">
        <span className="choice-title">{using || '\u00a0'}</span>
      </span>
    </button>
  );
}

/** Browser of API members: which browser, and the two tools the user may turn on or off. */
function BrowserSettingsPage() {
  const t = useT();
  const { data, setData, error, setError } = useBrowserSettings();
  const [busy, setBusy] = useState(false);
  if (!data) return error ? <div className="error-text" role="alert">{error}</div> : null;
  const save = (next: BrowserSettings) => {
    setBusy(true);
    setError(null);
    api
      .setBrowserSettings(next)
      .then(setData, (e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  const s = data.settings;
  const shown = s.browser === 'auto' ? data.using : s.browser;
  return (
    <>
      {data.unavailable && (
        <div className="error-text" role="alert">
          {data.unavailable === 'package' ? t('cp.browserNoPackage') : t('cp.browserNoBrowser')}
        </div>
      )}
      <section className="settings-row">
        <div className="settings-label">{t('settings.browserWhich')}</div>
        <div className="segmented" role="radiogroup" aria-label={t('settings.browserWhich')}>
          {(['chrome', 'msedge', 'firefox'] as const).map((b) => (
            <button
              key={b}
              type="button"
              role="radio"
              aria-checked={shown === b}
              className={shown === b ? 'on' : undefined}
              disabled={busy || !data.installed[b]}
              title={data.installed[b] ? undefined : t('settings.browserNotInstalled', { name: BROWSER_NAME[b] })}
              onClick={() => save({ ...s, browser: b })}
            >
              {BROWSER_NAME[b]}
            </button>
          ))}
        </div>
      </section>
      <section className="settings-row">
        <div className="settings-label">{t('settings.browserTools')}</div>
        <div>
          <label className="check">
            <input type="checkbox" checked={s.fileUpload} disabled={busy} onChange={(e) => save({ ...s, fileUpload: e.target.checked })} />
            {t('settings.browserUpload')}
          </label>
          <label className="check">
            <input type="checkbox" checked={s.evaluate} disabled={busy} onChange={(e) => save({ ...s, evaluate: e.target.checked })} />
            {t('settings.browserEvaluate')}
          </label>
        </div>
      </section>
      {error && (
        <div className="error-text" role="alert">
          {error}
        </div>
      )}
    </>
  );
}

/** Every runtime's default member avatar, then one per saved model provider (its chat members share it). */
function AvatarDefaults() {
  const { t } = usePrefs();
  const providers = (useChatProviders().data?.providers ?? []).filter((p) => !p.legacy);
  return (
    <div className="avatar-defaults">
      <div className="avatar-group-label">{t('settings.harnesses')}</div>
      {AVATAR_DEFAULT_KINDS.map((kind) => (
        <AvatarDefaultSetting key={kind} avatarKey={kind} name={RUNTIME_NAME[kind]} agent={{ runtimeKind: kind, displayName: RUNTIME_NAME[kind], avatar: null }} />
      ))}
      {providers.length > 0 && <div className="avatar-group-label">{t('cp.providers')}</div>}
      {providers.map((p) => (
        <AvatarDefaultSetting key={p.id} avatarKey={chatAvatarKey(p.id)} name={p.label} agent={{ runtimeKind: 'chat', displayName: p.label, avatar: null, providerId: p.id }} />
      ))}
    </div>
  );
}

/** One default member avatar (stored by the Core, shown for members of that runtime / provider without their own). */
function AvatarDefaultSetting({ avatarKey: kind, name, agent }: { avatarKey: AvatarDefaultKey; name: string; agent: ComponentProps<typeof AgentAvatar>['agent'] }) {
  const { t } = usePrefs();
  const current = useAvatarDefault(kind);
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (avatar: string | null) => {
    try {
      await api.setAvatarDefault(kind, avatar);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      await save(await avatarFromFile(file));
    } catch (e) {
      setError(e instanceof AvatarError && e.reason === 'tooBig' ? t('settings.avatarTooBig') : t('settings.avatarError'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="avatar-default" role="group" aria-label={name}>
      <div className="avatar-setting">
        <AgentAvatar agent={agent} />
        <span className="avatar-default-name">{name}</span>
        <button type="button" disabled={busy} onClick={() => input.current?.click()}>
          {current ? t('settings.avatarChange') : t('settings.avatarUpload')}
        </button>
        {current && (
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setError(null);
              setBusy(true);
              await save(null);
              setBusy(false);
            }}
          >
            {t('settings.avatarRemove')}
          </button>
        )}
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          hidden
          onChange={(e) => {
            void pick(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>
      {error && (
        <div className="error-text" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

export function Segmented<T extends string>(props: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={props.label}>
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={props.value === o.value}
          className={props.value === o.value ? 'on' : undefined}
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

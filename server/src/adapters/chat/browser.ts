import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { realPath, relativeInside } from '../../path-key.ts';
import { type AgentLanguage, type ApprovalDecision, DEFAULT_BROWSER_SETTINGS, type BrowserChoice, type BrowserSettings } from '../../../../shared/protocol.ts';
import { checkUrl, FetchError, privateHost } from './web-fetch.ts';
import { JsonRpcProcess, RpcError } from '../codex/rpc.ts';
import type { MediaCaps } from './project-tools.ts';
import type { ToolDef, ToolMedia } from './wire.ts';

/**
 * Browser tools of chat members: Playwright MCP (@playwright/mcp, Apache-2.0) over stdio, driving the system's own
 * Chrome, Edge or Firefox (Playwright downloads no browser; Firefox is driven over WebDriver BiDi). One process per
 * member session, with its own browser profile (one per browser) under the app's data folder, so a site the user signs in to in that window stays signed in for that member in that
 * chat. Harness Team decides which calls run without asking (browserCallKind) and exposes only the tools below. File
 * upload and page JavaScript are offered when the user turns them on (BrowserSettings); Playwright's own
 * run_code_unsafe (code in this computer's Node process, not in the page) is never offered.
 */

const require = createRequire(import.meta.url);

export const BROWSER_TOOL_NAMES = [
  'browser_navigate',
  'browser_navigate_back',
  'browser_snapshot',
  'browser_find',
  'browser_click',
  'browser_type',
  'browser_fill_form',
  'browser_select_option',
  'browser_press_key',
  'browser_hover',
  'browser_wait_for',
  'browser_take_screenshot',
  'browser_tabs',
  'browser_handle_dialog',
  'browser_close',
  'browser_file_upload',
  'browser_evaluate',
] as const;
export type BrowserToolName = (typeof BROWSER_TOOL_NAMES)[number];
export const isBrowserTool = (name: string): name is BrowserToolName => (BROWSER_TOOL_NAMES as readonly string[]).includes(name);

/** The Playwright MCP entry point, or null when the package is missing. */
export function browserCli(): string | null {
  try {
    const cli = join(dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js');
    return existsSync(cli) ? cli : null;
  } catch {
    return null;
  }
}

export interface FoundBrowser {
  /** Playwright channel. */
  channel: Exclude<BrowserChoice, 'auto'>;
  /** The executable, passed to Playwright as is (so a browser installed for this user only is found too). */
  path: string;
}

export const BROWSER_CHANNELS = ['chrome', 'msedge', 'firefox'] as const satisfies readonly FoundBrowser['channel'][];

/** Playwright MCP's --browser value: the installed Firefox is its moz-firefox channel (WebDriver BiDi). */
export const playwrightBrowser = (channel: FoundBrowser['channel']): string => (channel === 'firefox' ? 'moz-firefox' : channel);

/** Where each browser is installed, for all users or for this user only. */
function candidates(channel: FoundBrowser['channel']): string[] {
  if (process.platform === 'win32') {
    const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter((x): x is string => !!x);
    const rel = {
      chrome: join('Google', 'Chrome', 'Application', 'chrome.exe'),
      msedge: join('Microsoft', 'Edge', 'Application', 'msedge.exe'),
      firefox: join('Mozilla Firefox', 'firefox.exe'),
    }[channel];
    return roots.map((r) => join(r, rel));
  }
  if (process.platform === 'darwin') {
    const app = {
      chrome: 'Google Chrome.app/Contents/MacOS/Google Chrome',
      msedge: 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      firefox: 'Firefox.app/Contents/MacOS/firefox',
    }[channel];
    return [join('/Applications', app), join(homedir(), 'Applications', app)];
  }
  return {
    chrome: ['/opt/google/chrome/chrome', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'],
    msedge: ['/opt/microsoft/msedge/msedge', '/usr/bin/microsoft-edge-stable', '/usr/bin/microsoft-edge'],
    firefox: ['/usr/lib/firefox/firefox', '/usr/bin/firefox', '/snap/bin/firefox', '/opt/firefox/firefox'],
  }[channel];
}

/** Installed browsers: each channel's executable, or null. */
export function installedBrowsers(): Record<FoundBrowser['channel'], string | null> {
  const find = (c: FoundBrowser['channel']) => candidates(c).find((p) => existsSync(p)) ?? null;
  return { chrome: find('chrome'), msedge: find('msedge'), firefox: find('firefox') };
}

/** The browser to start: the chosen one; for auto, or when the chosen one is missing, Chrome, then Edge, then Firefox. */
export function findBrowser(choice: BrowserChoice = 'auto'): FoundBrowser | null {
  const have = installedBrowsers();
  const order: FoundBrowser['channel'][] = choice === 'auto' ? [...BROWSER_CHANNELS] : [choice, ...BROWSER_CHANNELS.filter((c) => c !== choice)];
  for (const channel of order) {
    const path = have[channel];
    if (path) return { channel, path };
  }
  return null;
}

/** Why chat members cannot use the browser on this computer (null = they can). */
export function browserUnavailable(): 'package' | 'no_browser' | null {
  if (!browserCli()) return 'package';
  if (!findBrowser()) return 'no_browser';
  return null;
}

/** The app's browser settings: one file in the data folder (the defaults when it is missing or unreadable). */
export class BrowserSettingsFile {
  private readonly file: string;
  private cached: BrowserSettings | null = null;

  constructor(dataDir: string) {
    this.file = join(dataDir, 'browser', 'settings.json');
  }

  get(): BrowserSettings {
    if (this.cached) return this.cached;
    let raw: Partial<Record<keyof BrowserSettings, unknown>> = {};
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      if (parsed && typeof parsed === 'object') raw = parsed;
    } catch {
      // missing or unreadable: the defaults
    }
    const d = DEFAULT_BROWSER_SETTINGS;
    this.cached = {
      browser: raw.browser === 'auto' || (BROWSER_CHANNELS as readonly unknown[]).includes(raw.browser) ? (raw.browser as BrowserChoice) : d.browser,
      fileUpload: typeof raw.fileUpload === 'boolean' ? raw.fileUpload : d.fileUpload,
      evaluate: typeof raw.evaluate === 'boolean' ? raw.evaluate : d.evaluate,
    };
    return this.cached;
  }

  set(next: BrowserSettings): BrowserSettings {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    renameSync(tmp, this.file);
    this.cached = { ...next };
    return this.cached;
  }
}

const target = { type: 'string', description: 'Exact element reference (ref) from the page snapshot' };
const element = { type: 'string', description: 'What the element is, in a few words (shown to the user when the action asks for approval)' };
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false });

export function browserToolDefs(caps: MediaCaps, settings: Pick<BrowserSettings, 'fileUpload' | 'evaluate'>): ToolDef[] {
  const extra: ToolDef[] = [];
  if (settings.fileUpload)
    extra.push({
      name: 'browser_file_upload',
      description:
        'Choose the files for the file chooser the page has open (click the page\u2019s upload button first). Paths are absolute, or relative to your working folder. The user approves every upload.',
      parameters: obj({ paths: { type: 'array', items: { type: 'string' }, description: 'Files to upload' } }, ['paths']),
    });
  if (settings.evaluate)
    extra.push({
      name: 'browser_evaluate',
      description: 'Run JavaScript in the page and get its result: a function () => { ... }, or (element) => { ... } with an element.',
      parameters: obj({ function: { type: 'string', description: 'The function, as source code' }, element, target }, ['function']),
    });
  return [
    { name: 'browser_navigate', description: 'Open a URL in the browser (http or https).', parameters: obj({ url: { type: 'string', description: 'The URL to open' } }, ['url']) },
    { name: 'browser_navigate_back', description: 'Go back to the previous page.', parameters: obj({}) },
    {
      name: 'browser_snapshot',
      description: 'Read the current page as an accessibility tree with element refs. Use it after an action to see the page, and to find refs for clicking and typing.',
      parameters: obj({ target, depth: { type: 'number', description: 'Limit the depth of the tree' } }),
    },
    {
      name: 'browser_find',
      description: 'Search the current page snapshot for text (or a /regex/), returning the matching elements with their refs; cheaper than a whole snapshot.',
      parameters: obj({ text: { type: 'string', description: 'Case-insensitive text to find' }, regex: { type: 'string', description: 'Regular expression instead of text' }, maxResults: { type: 'number' } }),
    },
    {
      name: 'browser_click',
      description: 'Click an element of the page.',
      parameters: obj(
        {
          element,
          target,
          doubleClick: { type: 'boolean' },
          button: { type: 'string', enum: ['left', 'right', 'middle'] },
          modifiers: { type: 'array', items: { type: 'string', enum: ['Alt', 'Control', 'ControlOrMeta', 'Meta', 'Shift'] } },
        },
        ['element', 'target'],
      ),
    },
    {
      name: 'browser_type',
      description: 'Type text into an editable element.',
      parameters: obj(
        { element, target, text: { type: 'string' }, submit: { type: 'boolean', description: 'Press Enter after typing' }, slowly: { type: 'boolean', description: 'One character at a time' } },
        ['element', 'target', 'text'],
      ),
    },
    {
      name: 'browser_fill_form',
      description: 'Fill several form fields at once.',
      parameters: obj(
        {
          fields: {
            type: 'array',
            items: obj(
              {
                target,
                name: { type: 'string', description: 'Field name' },
                type: { type: 'string', enum: ['textbox', 'checkbox', 'radio', 'combobox', 'slider'] },
                value: { type: 'string', description: 'Text; true/false for a checkbox; the option text for a combobox' },
              },
              ['target', 'name', 'type', 'value'],
            ),
          },
        },
        ['fields'],
      ),
    },
    {
      name: 'browser_select_option',
      description: 'Select options in a dropdown.',
      parameters: obj({ element, target, values: { type: 'array', items: { type: 'string' } } }, ['element', 'target', 'values']),
    },
    { name: 'browser_press_key', description: 'Press a key, such as Enter, ArrowLeft or a.', parameters: obj({ key: { type: 'string' } }, ['key']) },
    { name: 'browser_hover', description: 'Move the mouse over an element.', parameters: obj({ element, target }, ['element', 'target']) },
    {
      name: 'browser_wait_for',
      description: 'Wait for text to appear or disappear, or for some seconds (at most 30).',
      parameters: obj({ time: { type: 'number' }, text: { type: 'string' }, textGone: { type: 'string' } }),
    },
    {
      name: 'browser_take_screenshot',
      description: caps.image
        ? 'Take a screenshot of the page (or of one element) and look at it. Use browser_snapshot to find elements to act on.'
        : 'Not useful for this model, which cannot look at images: use browser_snapshot.',
      parameters: obj({ element, target, fullPage: { type: 'boolean' } }),
    },
    {
      name: 'browser_tabs',
      description: 'List, open, close or select browser tabs.',
      parameters: obj({ action: { type: 'string', enum: ['list', 'new', 'close', 'select'] }, index: { type: 'number' }, url: { type: 'string', description: 'For new: URL to open' } }, ['action']),
    },
    { name: 'browser_handle_dialog', description: 'Accept or dismiss a dialog of the page.', parameters: obj({ accept: { type: 'boolean' }, promptText: { type: 'string' } }, ['accept']) },
    { name: 'browser_close', description: 'Close the page.', parameters: obj({}) },
    ...extra,
  ];
}

/** Arguments sent on: only what browserToolDefs offers (no file names, no other browser contexts). */
const ALLOWED_ARGS: Record<BrowserToolName, readonly string[]> = {
  browser_navigate: ['url'],
  browser_navigate_back: [],
  browser_snapshot: ['target', 'depth'],
  browser_find: ['text', 'regex', 'maxResults'],
  browser_click: ['element', 'target', 'doubleClick', 'button', 'modifiers'],
  browser_type: ['element', 'target', 'text', 'submit', 'slowly'],
  browser_fill_form: ['fields'],
  browser_select_option: ['element', 'target', 'values'],
  browser_press_key: ['key'],
  browser_hover: ['element', 'target'],
  browser_wait_for: ['time', 'text', 'textGone'],
  browser_take_screenshot: ['element', 'target', 'fullPage'],
  browser_tabs: ['action', 'index', 'url'],
  browser_handle_dialog: ['accept', 'promptText'],
  browser_close: [],
  browser_file_upload: ['paths'],
  browser_evaluate: ['function', 'element', 'target'],
};

export function browserArgs(name: BrowserToolName, args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ALLOWED_ARGS[name]) if (args[k] !== undefined) out[k] = args[k];
  if (name === 'browser_fill_form' && Array.isArray(out.fields)) {
    out.fields = out.fields.map((f) => {
      const o = (f && typeof f === 'object' ? f : {}) as Record<string, unknown>;
      return { target: o.target, name: o.name, type: o.type, value: o.value };
    });
  }
  if (name === 'browser_take_screenshot') out.scale = 'css';
  return out;
}

/**
 * What a call does to a site:
 * - observe: reads the page that is open, or only changes tabs (runs without asking);
 * - navigate: opens a URL (asks for that site);
 * - act: clicks, types, fills, runs JavaScript or answers a dialog on the page that is open (asks for that page's site);
 * - upload: sends files of this computer to the page that is open (asks every time, whatever was allowed before).
 */
export type BrowserCallKind = { kind: 'observe' } | { kind: 'navigate'; url: string } | { kind: 'act' } | { kind: 'upload' };

export function browserCallKind(name: BrowserToolName, args: Record<string, unknown>): BrowserCallKind {
  switch (name) {
    case 'browser_navigate':
      return { kind: 'navigate', url: typeof args.url === 'string' ? args.url : '' };
    case 'browser_tabs':
      return args.action === 'new' && typeof args.url === 'string' && args.url.trim() ? { kind: 'navigate', url: args.url } : { kind: 'observe' };
    case 'browser_click':
    case 'browser_type':
    case 'browser_fill_form':
    case 'browser_select_option':
    case 'browser_press_key':
    case 'browser_hover':
    case 'browser_handle_dialog':
    case 'browser_evaluate':
      return { kind: 'act' };
    case 'browser_file_upload':
      return { kind: 'upload' };
    default:
      return { kind: 'observe' };
  }
}

/** A call on the page that is open (act, upload): which page that is gets read again first, as it may have moved by itself. */
export function actsOnPage(name: BrowserToolName, raw: Record<string, unknown>): boolean {
  const k = browserCallKind(name, browserArgs(name, raw)).kind;
  return k === 'act' || k === 'upload';
}

/** One line for the approval card: what the action does. */
export function describeBrowserCall(name: BrowserToolName, args: Record<string, unknown>): string {
  const s = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v ?? ''));
  const el = typeof args.element === 'string' && args.element ? `“${args.element}”` : s(args.target);
  switch (name) {
    case 'browser_click':
      return `click ${el}`;
    case 'browser_type':
      return `type into ${el}: ${s(args.text)}${args.submit ? ' + Enter' : ''}`;
    case 'browser_fill_form':
      return `fill ${Array.isArray(args.fields) ? args.fields.map((f) => `${s((f as Record<string, unknown>)?.name)} = ${s((f as Record<string, unknown>)?.value)}`).join('; ') : ''}`;
    case 'browser_select_option':
      return `select ${s(args.values)} in ${el}`;
    case 'browser_press_key':
      return `press ${s(args.key)}`;
    case 'browser_hover':
      return `hover over ${el}`;
    case 'browser_handle_dialog':
      return `${args.accept ? 'accept' : 'dismiss'} the dialog${typeof args.promptText === 'string' ? `: ${args.promptText}` : ''}`;
    case 'browser_evaluate':
      return `run JavaScript${args.target !== undefined ? ` on ${el}` : ''}:\n${s(args.function)}`;
    case 'browser_file_upload':
      return `upload ${Array.isArray(args.paths) ? args.paths.map(s).join(', ') : ''}`;
    default:
      return name;
  }
}

const UPLOAD_MAX_FILES = 20;
const UPLOAD_MAX_BYTES = 100 * 1024 * 1024;

export interface UploadFile {
  /** Absolute path of the file the user approves. */
  path: string;
  size: number;
}

/**
 * Checks the files of browser_file_upload: absolute, or relative to the member's working folder; existing files (not
 * folders) of at most 100 MB, 20 at most; nothing of the app's data folder except chat attachments. Throws a message
 * for the model.
 */
export function prepareUploads(paths: unknown, workDir: string | null, dataDir: string): UploadFile[] {
  if (!Array.isArray(paths) || !paths.length || paths.some((p) => typeof p !== 'string' || !p.trim())) throw new Error('paths must be a non-empty list of file paths');
  if (paths.length > UPLOAD_MAX_FILES) throw new Error(`at most ${UPLOAD_MAX_FILES} files at a time`);
  const data = realPath(dataDir);
  const attachments = join(data, 'attachments');
  return (paths as string[]).map((raw) => {
    const p = raw.trim().replace(/^"(.*)"$/, '$1');
    if (!isAbsolute(p) && !workDir) throw new Error(`${p}: use an absolute path (this member has no working folder)`);
    const abs = isAbsolute(p) ? resolve(p) : resolve(workDir!, p);
    let st;
    try {
      st = statSync(abs);
    } catch {
      throw new Error(`${abs}: no such file`);
    }
    if (!st.isFile()) throw new Error(`${abs}: not a file`);
    if (st.size > UPLOAD_MAX_BYTES) throw new Error(`${abs}: larger than 100 MB`);
    const real = realPath(abs);
    if ((real === data || relativeInside(data, real) !== null) && relativeInside(attachments, real) === null) throw new Error(`${abs}: this file is not available`);
    return { path: abs, size: st.size };
  });
}

export function sizeText(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** host[:port] of the page the browser shows (lower case), or null when there is none or it is not a web page. */
export function pageHost(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.host.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** One browser call, checked and described for its approval card (chat members and runtime members share it). */
export interface BrowserPlan {
  /** The arguments Playwright gets (the URL normalized, upload paths absolute). */
  args: Record<string, unknown>;
  kind: BrowserCallKind;
  /** Site the call is about (the URL's, or the open page's), or null. */
  host: string | null;
  title: string;
  detail: string;
  /** The card's detail: for an action, the open page's URL under it. */
  shown: string;
  reason: string;
  options: ApprovalDecision[];
}

/**
 * Checks one browser call against the browser settings (upload, page JavaScript), the URL rules and the upload rules,
 * and words its approval card in `lang`. Throws a message for the model.
 */
export function planBrowserCall(
  name: BrowserToolName,
  raw: Record<string, unknown>,
  ctx: { pageUrl: string | null; pageHost: string | null; workDir: string | null; dataDir: string; allowPrivate: boolean; lang: AgentLanguage; prefs: BrowserSettings },
): BrowserPlan {
  const zh = ctx.lang === 'zh';
  if (name === 'browser_file_upload' && !ctx.prefs.fileUpload) throw new Error('file upload is turned off in the browser settings');
  if (name === 'browser_evaluate' && !ctx.prefs.evaluate) throw new Error('page JavaScript is turned off in the browser settings');
  const args = browserArgs(name, raw);
  const kind = browserCallKind(name, args);
  let uploads: UploadFile[] = [];
  if (kind.kind === 'upload') {
    uploads = prepareUploads(args.paths, ctx.workDir, ctx.dataDir);
    args.paths = uploads.map((f) => f.path);
  }
  let host: string | null;
  let title: string;
  let detail: string;
  if (kind.kind === 'navigate') {
    let url: URL;
    try {
      url = checkUrl(kind.url, ctx.allowPrivate);
    } catch (e) {
      throw new Error(e instanceof FetchError ? e.message : `failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    args.url = url.href;
    host = url.host.toLowerCase();
    title = `${name} ${url.href.slice(0, 200)}`;
    detail = url.href;
  } else {
    host = ctx.pageHost;
    detail =
      kind.kind === 'upload'
        ? uploads.map((f) => `${f.path} (${sizeText(f.size)})`).join('\n')
        : kind.kind === 'act'
          ? describeBrowserCall(name, args)
          : JSON.stringify(args) === '{}'
            ? ''
            : JSON.stringify(args).slice(0, 500);
    title = kind.kind === 'upload' ? `${name} ${uploads.map((f) => basename(f.path)).join(', ').slice(0, 160)}` : kind.kind === 'act' ? `${name} ${detail.split('\n')[0]!.slice(0, 160)}` : name;
  }
  const where = host ?? (zh ? '当前页面' : 'the current page');
  const reason =
    kind.kind === 'navigate'
      ? zh
        ? `用浏览器打开 ${where} 的网页（网站会收到这个网址，页面内容会发给模型）`
        : `Open a page of ${where} in the browser (the site receives this URL, the model receives the page)`
      : kind.kind === 'upload'
        ? zh
          ? `把 ${uploads.length} 个文件交给 ${where} 的网页上传（网站会收到这些文件）`
          : `Give ${uploads.length} file(s) to the upload of a page of ${where} (the site receives these files)`
        : name === 'browser_evaluate'
          ? zh
            ? `在 ${where} 的网页里运行 JavaScript（能读写这个网页，并以你的登录身份访问这个网站）`
            : `Run JavaScript in a page of ${where} (it can read and change the page and reach the site as you)`
          : zh
            ? `在 ${where} 的网页上操作（网站会收到这次操作）`
            : `Act on a page of ${where} (the site receives this action)`;
  const options: ApprovalDecision[] = host && kind.kind !== 'upload' ? ['allow', 'allow_session', 'deny'] : ['allow', 'deny'];
  const shown = kind.kind !== 'navigate' && ctx.pageUrl ? `${detail}\n${ctx.pageUrl}` : detail;
  return { args, kind, host, title, detail, shown, reason, options };
}

export interface BrowserResult {
  text: string;
  media: ToolMedia[];
  isError: boolean;
  /** Playwright's text as it came (browser_tabs: the tab list). */
  raw: string;
}

/**
 * The URL of the current tab in a browser_tabs result (Playwright writes the tab list first, from its own state, not
 * from page content). A tab line is `- i: (current) [title](url)`; titles are not escaped, so with a `](` in the title
 * or the URL every reading is returned, and each must pass. null: no tab is open. Throws on anything else.
 */
export function currentTabUrls(raw: string): string[] | null {
  const lines = raw.split('\n');
  if (lines[0] !== '### Result') throw new Error('no tab list');
  const body: string[] = [];
  for (const l of lines.slice(1)) {
    if (l.startsWith('### ')) break;
    body.push(l);
  }
  if (body[0]?.startsWith('No open tabs')) return null;
  const current = body.filter((l) => /^- \d+: \(current\) \[/.test(l));
  if (current.length !== 1) throw new Error('no current tab in the tab list');
  let rest = current[0]!.replace(/^- \d+: \(current\) \[/, '').replace(/ \[crashed\]$/, '');
  if (!rest.endsWith(')')) throw new Error('unreadable tab line');
  rest = rest.slice(0, -1);
  const urls: string[] = [];
  for (let i = rest.indexOf(']('); i !== -1; i = rest.indexOf('](', i + 1)) urls.push(rest.slice(i + 2));
  if (!urls.length) throw new Error('unreadable tab line');
  return urls;
}

/** Which pages of a call may reach the model. */
export interface PageGate {
  /** No approvals in this mode: only the local network is kept out. */
  fullAccess: boolean;
  allowPrivate: boolean;
  /** The site the user allowed for this call (opened, or acted on), if any. */
  approvedHost: string | null;
  /** Sites allowed for the session. */
  covers: (host: string) => boolean;
}

/**
 * Why the page the tab shows may not go to the model, or null. The tab may have left the site that was allowed: a
 * redirect, a script, a link. Its page then goes to the model only when it is the site allowed for this call, the
 * page already shown, or a site allowed for the session; never this computer or the local network.
 */
export async function pageRefusal(urls: string[], gate: PageGate, shownHost: string | null): Promise<string | null> {
  for (const raw of urls) {
    let u: URL | null = null;
    try {
      u = new URL(raw);
    } catch {
      u = null;
    }
    if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) {
      if (u && (u.protocol === 'about:' || u.protocol === 'chrome-error:')) continue;
      if (gate.fullAccess) continue;
      return `the page is at ${raw.slice(0, 200)}, which is not a web page; its content is withheld`;
    }
    if (!gate.allowPrivate && (await privateHost(u.hostname))) return `the page went to ${u.host}, which is this computer or the local network; its content is withheld`;
    if (gate.fullAccess) continue;
    const host = u.host.toLowerCase();
    if (host === gate.approvedHost || host === shownHost || gate.covers(host)) continue;
    return `the page went to ${u.href.slice(0, 300)}, a site the user has not allowed; its content is withheld. To read it, open that URL with browser_navigate (the user is asked).`;
  }
  return null;
}

export interface BrowserProcessOptions {
  /** Browser profiles (kept between sessions): one folder per browser in here. */
  profileRoot: string;
  /** Working folder of the process: Playwright MCP's own files (snapshots, screenshots) go here. */
  outDir: string;
  env: NodeJS.ProcessEnv;
  /** Which browser to start (read when the process starts). */
  choice: () => BrowserChoice;
  headless?: boolean;
  protocolLog?: string;
}

const CALL_TIMEOUT_MS = 120_000;

/** One Playwright MCP process. Started on the first call; the browser itself starts on the first page. */
export class BrowserProcess {
  private rpc: JsonRpcProcess | null = null;
  private starting: Promise<JsonRpcProcess> | null = null;
  /**
   * URL of the current tab, from Playwright's tab list (never from page content): one reading, or more when the
   * tab line is ambiguous. null: no page.
   */
  pageUrls: string[] | null = null;
  /** Host of the page whose content last went to the model. */
  private shownHost: string | null = null;
  private readonly opts: BrowserProcessOptions;

  constructor(opts: BrowserProcessOptions) {
    this.opts = opts;
  }

  private start(): Promise<JsonRpcProcess> {
    if (this.rpc?.running) return Promise.resolve(this.rpc);
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const cli = browserCli();
      const found = findBrowser(this.opts.choice());
      if (!cli) throw new RpcError('missing @playwright/mcp');
      if (!found) throw new RpcError('no Google Chrome, Microsoft Edge or Mozilla Firefox found');
      const profileDir = join(this.opts.profileRoot, found.channel);
      mkdirSync(profileDir, { recursive: true });
      mkdirSync(this.opts.outDir, { recursive: true });
      const args = [
        cli,
        '--browser',
        playwrightBrowser(found.channel),
        '--executable-path',
        found.path,
        '--user-data-dir',
        profileDir,
        '--output-dir',
        this.opts.outDir,
        '--no-webmcp',
        '--ignore-roots',
        ...(this.opts.headless ? ['--headless'] : []),
      ];
      // In the desktop app this process is Electron: run the script as plain Node.
      const env = { ...this.opts.env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) };
      const rpc: JsonRpcProcess = new JsonRpcProcess(
        process.execPath,
        args,
        {
          onNotification: () => {},
          onServerRequest: (id) => rpc.respondError(id, -32601, 'not supported'),
          onExit: () => {
            if (this.rpc === rpc) this.rpc = null;
          },
        },
        { cwd: this.opts.outDir, env, name: 'Playwright MCP', protocolLog: this.opts.protocolLog },
      );
      rpc.start();
      try {
        await rpc.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'harness-team', version: '1' } }, 30_000);
      } catch (e) {
        await rpc.close();
        throw e;
      }
      rpc.notify('notifications/initialized');
      this.rpc = rpc;
      return rpc;
    })();
    return this.starting.finally(() => {
      this.starting = null;
    });
  }

  /** The current tab's URL, for the user to see. */
  get pageUrl(): string | null {
    return this.pageUrls?.join('\n') ?? null;
  }

  /** Host of the current tab, when every reading agrees. */
  get pageHost(): string | null {
    const hosts = new Set((this.pageUrls ?? []).map(pageHost));
    return hosts.size === 1 ? [...hosts][0]! : null;
  }

  /** Reads the current tab again (when the browser runs). */
  async readPage(signal: AbortSignal): Promise<void> {
    if (!this.rpc?.running) {
      this.pageUrls = null;
      return;
    }
    const r = await this.call('browser_tabs', { action: 'list' }, signal);
    this.pageUrls = currentTabUrls(r.raw);
  }

  /**
   * Before a call: refuses a URL to open, or a page to act on, that is this computer or the local network (a name
   * may resolve there). Throws a message for the model.
   */
  async checkTarget(plan: BrowserPlan, allowPrivate: boolean): Promise<void> {
    if (allowPrivate || plan.kind.kind === 'observe') return;
    const urls = plan.kind.kind === 'navigate' ? [String(plan.args.url)] : (this.pageUrls ?? []);
    for (const raw of urls) {
      let u: URL;
      try {
        u = new URL(raw);
      } catch {
        continue;
      }
      if ((u.protocol === 'http:' || u.protocol === 'https:') && (await privateHost(u.hostname))) {
        throw new Error(`${u.host} is this computer or the local network; the browser does not open or act on it`);
      }
    }
  }

  /**
   * After a call: reads which page the tab shows now and returns why it may not go to the model (null: it may).
   * browser_tabs answers with the tab list itself.
   */
  async checkPage(name: BrowserToolName, r: BrowserResult, gate: PageGate, signal: AbortSignal): Promise<string | null> {
    if (name === 'browser_close') {
      this.pageUrls = null;
      this.shownHost = null;
      return null;
    }
    try {
      if (name === 'browser_tabs' && !r.isError) this.pageUrls = currentTabUrls(r.raw);
      else await this.readPage(signal);
    } catch (e) {
      this.shownHost = null;
      return `could not confirm which page is open (${e instanceof Error ? e.message : String(e)}); its content is withheld`;
    }
    const refusal = await pageRefusal(this.pageUrls ?? [], gate, this.shownHost);
    this.shownHost = refusal ? null : this.pageHost;
    return refusal;
  }

  async call(name: BrowserToolName, args: Record<string, unknown>, signal: AbortSignal): Promise<BrowserResult> {
    const rpc = await this.start();
    const aborted = new Promise<never>((_, reject) => {
      if (signal.aborted) reject(new RpcError('cancelled: the user stopped the turn'));
      signal.addEventListener('abort', () => reject(new RpcError('cancelled: the user stopped the turn')), { once: true });
    });
    aborted.catch(() => {});
    const r = await Promise.race([rpc.request<{ content?: unknown[]; isError?: boolean }>('tools/call', { name, arguments: args }, CALL_TIMEOUT_MS), aborted]);
    const texts: string[] = [];
    const media: ToolMedia[] = [];
    for (const c of Array.isArray(r?.content) ? r.content : []) {
      const item = c as { type?: string; text?: string; data?: string; mimeType?: string };
      if (item.type === 'text' && typeof item.text === 'string') texts.push(item.text);
      else if (item.type === 'image' && typeof item.data === 'string') media.push({ type: 'image', mime: item.mimeType || 'image/png', data: item.data, name: 'screenshot' });
    }
    const raw = texts.join('\n');
    return { text: tidy(raw), media, isError: !!r?.isError, raw };
  }

  /**
   * Copies approved files into this process's folder (Playwright reads files only there) under their own names, and
   * returns the copies. The browser may read them when the page sends the form, so they stay until the session ends.
   */
  stageUploads(files: UploadFile[]): string[] {
    const dir = join(this.opts.outDir, 'uploads', randomUUID());
    mkdirSync(dir, { recursive: true });
    const used = new Set<string>();
    return files.map((f, i) => {
      let name = basename(f.path);
      if (used.has(name.toLowerCase())) name = `${i + 1}-${name}`;
      used.add(name.toLowerCase());
      const to = join(dir, name);
      copyFileSync(f.path, to);
      return to;
    });
  }

  async close(): Promise<void> {
    const rpc = this.rpc ?? (await this.starting?.catch(() => null)) ?? null;
    this.rpc = null;
    this.pageUrls = null;
    this.shownHost = null;
    await rpc?.close().catch(() => {});
    try {
      rmSync(join(this.opts.outDir, 'uploads'), { recursive: true, force: true });
    } catch {
      // a copy the browser still holds: removed with the next session
    }
  }
}

/**
 * The model reads results, not Playwright's files: the generated code is left out, and links to files Playwright
 * wrote (snapshots, screenshots) become a hint or plain text.
 */
export function tidy(text: string): string {
  return text
    .replace(/### Ran Playwright code\n```[a-z]*\n[\s\S]*?\n```\n?/g, '')
    .replace(/^- \[Snapshot\]\([^)]*\)$/gm, '- (call browser_snapshot to read the page)')
    .replace(/\[([^\]\n]+)\]\((?!https?:)[^)\n]*\)/g, '$1')
    .trim();
}

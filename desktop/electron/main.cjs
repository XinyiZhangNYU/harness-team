'use strict';
// Harness Team desktop shell (Electron, Windows-first evaluation build).
//
// The shell only hosts the existing local UI: it starts the unchanged Core (server/src/main.ts) in an Electron
// utility process, waits for its "ready" message, and shows the loopback page in a window. The page gets no Node access
// and no credentials; its only additions over the browser are the native folder picker, opening / showing attached
// files (preload.cjs, attachment-open.cjs) and the application menu (menu.cjs; on Windows the page draws the title
// bar with its ☰ button). Claude Code / Codex
// keep using the user's own installed CLIs and logins exactly as in the localhost mode (which keeps working without
// this shell).

const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, net, powerMonitor, powerSaveBlocker, safeStorage, screen, shell, utilityProcess } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { attachmentPath, canOpenDirectly } = require('./attachment-open.cjs');
const { readState, restoreBounds, writeState } = require('./window-state.cjs');
const { createUpdater, launchInstaller } = require('./updater.cjs');
const { PAGE_COMMANDS, REPO_URL, secondLaunchNotice, cleanMenuState, diagnosticsText, emptyMenuState, isSettingsKey, menuTemplate, osLabel } = require('./menu.cjs');

const PREFERRED_PORT = 4317;
const SHUTDOWN_TIMEOUT_MS = 15_000;
const ATTENTION_POLL_MS = 3_000;
/** In-app updates: the installed Windows app only (the installer is the NSIS Setup of each release). */
const UPDATES = process.platform === 'win32' && app.isPackaged;
const UPDATE_FIRST_CHECK_MS = 30_000;
const UPDATE_CHECK_EVERY_MS = 6 * 60 * 60_000;
/** Windows: the page draws the window's title bar (☰ menu); preload.cjs gives the page the same height. */
const CUSTOM_TITLE_BAR = process.platform === 'win32';
const TITLE_BAR_HEIGHT = 36;

/** Same folder, as the platform's default file system compares names. */
const samePath = (a, b) => (process.platform === 'win32' || process.platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b);
const DATA_DIR = process.env.HT_DATA_DIR || path.join(app.getPath('userData'), 'data');

// One window at a time. A second launch focuses the running window; one that asked for another data folder is also
// told that it was not opened (macOS `open` without -n reuses the running app and starts no second process at all).
if (!app.requestSingleInstanceLock({ dataDir: path.resolve(DATA_DIR) })) {
  app.quit();
} else {
  app.setAppUserModelId('dev.harness-team.desktop');
  main();
}

function main() {
  /** @type {Electron.UtilityProcess | null} */
  let core = null;
  /** @type {{ url: string, launchUrl: string, dataDir: string } | null} */
  let info = null;
  /** @type {BrowserWindow | null} */
  let win = null;
  let quitting = false;
  let coreExited = false;
  /** The quit question being asked, if any: a second Cmd+Q / close joins it instead of opening another. */
  let confirming = null;
  /** @type {AbortController | null} closes that question's dialog. */
  let questionAbort = null;
  /** The system is logging out, restarting or shutting down. */
  let systemEnding = false;
  /** Reads Core's attention counts every ATTENTION_POLL_MS while the window exists. */
  let attentionTimer = null;
  let polling = false;
  /** powerSaveBlocker id while members work, else null. */
  let keepAwakeId = null;
  let lastApprovals = 0;
  /** @type {Electron.NativeImage | null} */
  let overlayDot = null;
  /** What the application menu lists, as the page last reported it. */
  let menuState = emptyMenuState();
  /** A downloaded, verified installer to run as the app exits (set by "Restart to update"). */
  let installOnQuit = null;
  let updateTimer = null;

  const dataDir = DATA_DIR;
  // With HT_DATA_DIR (a separate instance's data), its logs stay with that data instead of joining the default ones.
  const logDir = process.env.HT_DATA_DIR ? path.join(dataDir, 'logs') : path.join(app.getPath('userData'), 'logs');
  const log = openLog(logDir);

  // Dialog language: the page's language (Settings → Language) when the window is up, remembered for the next start;
  // before that, the last one seen, else the system's.
  const langFile = path.join(app.getPath('userData'), 'ui-lang');
  let uiLang = null;
  try {
    const saved = fs.readFileSync(langFile, 'utf8').trim();
    if (saved === 'zh' || saved === 'en') uiLang = saved;
  } catch {
    // not saved yet
  }
  const lang = () => uiLang || (/^zh/i.test(app.getLocale()) ? 'zh' : 'en');
  const tr = (zh, en) => (lang() === 'zh' ? zh : en);

  const updater = UPDATES
    ? createUpdater({
        currentVersion: app.getVersion(),
        dir: path.join(app.getPath('userData'), 'updates'),
        fetch: (url, init) => net.fetch(url, init),
        log: (s) => log.write(s),
        onState: (s) => {
          if (win && !win.isDestroyed()) win.webContents.send('ht:update', s);
        },
      })
    : null;
  async function syncPageLang() {
    if (!win || win.isDestroyed()) return;
    try {
      const l = String(await win.webContents.executeJavaScript('document.documentElement.lang'));
      const next = /^zh/i.test(l) ? 'zh' : 'en';
      if (next !== uiLang) {
        uiLang = next;
        fs.writeFileSync(langFile, next);
      }
    } catch {
      // page not ready: keep the current choice
    }
  }

  app.on('second-instance', (_e, _argv, _cwd, extra) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
    const requested = extra && typeof extra.dataDir === 'string' ? extra.dataDir : null;
    const notice = secondLaunchNotice(lang(), path.resolve(dataDir), requested, samePath);
    if (notice) void dialog.showMessageBox(win, { type: 'info', ...notice });
  });

  // macOS: clicking the Dock icon brings back the window that closing only hid.
  app.on('activate', () => {
    if (!win || win.isDestroyed()) return;
    win.show();
    win.focus();
  });

  app.whenReady().then(async () => {
    // macOS ignores the window `icon`. The packaged app gets its .icns from electron-builder, but `npm run desktop`
    // runs the stock Electron.app, so set the Dock icon here.
    if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(path.join(__dirname, '..', 'icons', 'icon.png'));
    // macOS / Linux: logging out, restarting or shutting down quits without asking, since a Cancel there would hold up
    // the system; a question already open is closed. Unfinished turns are marked Interrupted at the next start, as
    // with "Quit anyway". preventDefault asks the system to wait while Core stops its harness processes.
    powerMonitor.on('shutdown', (e) => {
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
      onSystemEnding();
    });
    updateMenu();
    try {
      info = await startCore(PREFERRED_PORT).catch((e) => (e && e.portInUse ? startCore(0) : Promise.reject(e)));
    } catch (e) {
      dialog.showErrorBox(tr('Harness Team 无法启动', 'Harness Team could not start'), `${(e && e.message) || e}\n\n${tr('日志：', 'Log: ')}${log.file}`);
      app.exit(1);
      return;
    }
    createWindow();
  });

  /**
   * Chat member API keys: the Core (a utility process) has no safeStorage, so it asks here. Data is base64; the plain
   * key passes only through this IPC channel and is never logged.
   */
  function answerSecret(child, m) {
    const reply = (r) => child.postMessage({ type: 'secret-result', id: m.id, ...r });
    try {
      if (typeof m.id !== 'number' || typeof m.data !== 'string') throw new Error('bad request');
      if (!safeStorage.isEncryptionAvailable()) throw new Error('the system key store is not available');
      if (m.op === 'encrypt') reply({ ok: true, data: safeStorage.encryptString(m.data).toString('base64') });
      else if (m.op === 'decrypt') reply({ ok: true, data: safeStorage.decryptString(Buffer.from(m.data, 'base64')) });
      else throw new Error('bad request');
    } catch (e) {
      reply({ ok: false, error: e && e.message ? String(e.message) : 'failed' });
    }
  }

  function startCore(port) {
    return new Promise((resolve, reject) => {
      const entry = path.join(app.getAppPath(), 'server', 'src', 'main.ts');
      const args = ['--port', String(port), '--data-dir', dataDir];
      log.write(`[shell] starting Core: ${entry} --port ${port} --data-dir ${dataDir}`);
      const child = utilityProcess.fork(entry, args, {
        stdio: 'pipe',
        serviceName: 'Harness Team Core',
        // Language of Core's startup error, which the dialog below shows.
        env: { ...process.env, HT_LANG: lang() },
      });
      let stderr = '';
      let settled = false;
      child.stdout?.on('data', (d) => log.write(String(d)));
      child.stderr?.on('data', (d) => {
        stderr = (stderr + String(d)).slice(-4000);
        log.write(String(d));
      });
      child.on('message', (m) => {
        if (m && m.type === 'secret') {
          answerSecret(child, m);
          return;
        }
        if (m && m.type === 'ready' && !settled) {
          settled = true;
          core = child;
          resolve(m);
        }
      });
      child.on('exit', (code) => {
        if (!settled) {
          settled = true;
          const err = new Error(stderr.trim().split('\n').slice(-3).join('\n') || `Core exited with code ${code}`);
          err.portInUse = /已被占用|is already in use/.test(stderr);
          reject(err);
          return;
        }
        coreExited = true;
        log.write(`[shell] Core exited with code ${code}`);
        if (!quitting) {
          dialog.showErrorBox(
            tr('Harness Team 已停止', 'Harness Team stopped'),
            tr(
              `本地服务意外退出（代码 ${code}）。正在运行的成员回合会在下次启动时标为「已中断」，不会自动重跑。\n\n日志：${log.file}`,
              `The local service exited unexpectedly (code ${code}). Member turns that were running are marked “Interrupted” at the next start and are not rerun automatically.\n\nLog: ${log.file}`,
            ),
          );
          app.exit(1);
        }
      });
    });
  }

  const windowStateFile = path.join(app.getPath('userData'), 'window-state.json');
  let saveStateTimer = null;
  function saveWindowState() {
    clearTimeout(saveStateTimer);
    if (!win || win.isDestroyed()) return;
    writeState(windowStateFile, win.getNormalBounds(), win.isMaximized());
  }

  function createWindow() {
    const origin = new URL(info.url).origin;
    const saved = restoreBounds(readState(windowStateFile), screen.getAllDisplays().map((d) => d.workArea));
    win = new BrowserWindow({
      width: saved ? saved.width : 1320,
      height: saved ? saved.height : 860,
      ...(saved ? { x: saved.x, y: saved.y } : {}),
      title: 'Harness Team',
      icon: path.join(__dirname, '..', 'icons', 'icon-256.png'),
      show: false,
      // Windows: the page draws the title bar (☰ opens the application menu); Windows still draws the window buttons
      // over its right end, in the page's colors. Elsewhere the system title bar stays.
      ...(CUSTOM_TITLE_BAR
        ? { titleBarStyle: 'hidden', titleBarOverlay: { ...startTitleBarColors(), height: TITLE_BAR_HEIGHT } }
        : { autoHideMenuBar: true }),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, 'preload.cjs'),
      },
    });
    if (saved && saved.maximized) win.maximize();
    win.once('ready-to-show', () => win && win.show());
    // Size and position are remembered for the next start (written shortly after the last move or resize).
    const saveSoon = () => {
      clearTimeout(saveStateTimer);
      saveStateTimer = setTimeout(saveWindowState, 500);
    };
    for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) win.on(ev, saveSoon);
    // Links in chat open in the user's browser; the window itself never leaves the local UI.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url) && !url.startsWith(origin + '/')) void shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => {
      if (url.startsWith(origin + '/')) return;
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    });
    // Ctrl+, opens Settings on Windows / Linux, where the menu item cannot show that shortcut (menu.cjs).
    if (process.platform !== 'darwin') {
      win.webContents.on('before-input-event', (e, input) => {
        if (!isSettingsKey(input)) return;
        e.preventDefault();
        runCommand('settings');
      });
    }
    // Native "choose folder" dialog for the member's working directory. Only the local UI's own page may ask, and it
    // only gets back the path the user picked (the dialog itself is the user's choice; nothing is read here).
    ipcMain.removeHandler('ht:pick-folder');
    ipcMain.handle('ht:pick-folder', async (event, defaultPath) => {
      const from = event.senderFrame && event.senderFrame.url;
      if (!win || event.sender !== win.webContents || !from || !from.startsWith(origin + '/')) return null;
      const start = typeof defaultPath === 'string' && path.isAbsolute(defaultPath) && fs.existsSync(defaultPath) ? defaultPath : undefined;
      await syncPageLang();
      const r = await dialog.showOpenDialog(win, {
        title: tr('选择文件夹', 'Choose a folder'),
        buttonLabel: tr('选择此文件夹', 'Choose this folder'),
        defaultPath: start,
        properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'],
      });
      return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
    });
    // "Open" / "Show in folder" on an attached file. The page names the attachment; the path is rebuilt under the data
    // directory and must be an existing file there. Programs, scripts and pages are only shown in their folder.
    ipcMain.removeHandler('ht:attachment');
    ipcMain.handle('ht:attachment', async (event, action, ref) => {
      const from = event.senderFrame && event.senderFrame.url;
      if (!win || event.sender !== win.webContents || !from || !from.startsWith(origin + '/')) return { ok: false, error: 'denied' };
      if (action !== 'open' && action !== 'reveal') return { ok: false, error: 'denied' };
      const p = attachmentPath(dataDir, ref);
      if (!p) return { ok: false, error: 'missing' };
      if (action === 'open' && canOpenDirectly(p)) {
        const err = await shell.openPath(p);
        if (!err) return { ok: true, revealed: false };
        log.write(`[shell] open attachment failed: ${err}`);
      }
      shell.showItemInFolder(p);
      return { ok: true, revealed: true };
    });
    const fromPage = (event) => {
      const from = event.senderFrame && event.senderFrame.url;
      return !!win && event.sender === win.webContents && !!from && from.startsWith(origin + '/');
    };
    // The page reports what the application menu lists: its chats in sidebar order, the open one, that chat's project
    // folder and the UI language.
    ipcMain.removeAllListeners('ht:menu-state');
    ipcMain.on('ht:menu-state', (event, raw) => {
      if (!fromPage(event)) return;
      menuState = cleanMenuState(raw);
      if (menuState.lang && menuState.lang !== uiLang) {
        uiLang = menuState.lang;
        try {
          fs.writeFileSync(langFile, uiLang);
        } catch {
          // remembered next time
        }
      }
      updateMenu();
    });
    // Windows: the ☰ button (or Alt / F10) opens the application menu below the button (page pixels → window pixels).
    // Alt+Space opens the Windows window menu while Alt is still down; the page never sees the Space, so releasing Alt
    // would open this menu on top of it. Windows reports that menu loop (WM_ENTERMENULOOP with wParam FALSE, i.e. not
    // a TrackPopupMenu menu like ours), and an Alt release during it or just after it closes is ignored.
    let systemMenuOpen = false;
    let systemMenuClosedAt = 0;
    if (process.platform === 'win32') {
      const WM_ENTERMENULOOP = 0x0211;
      const WM_EXITMENULOOP = 0x0212;
      const word = (b) => (Buffer.isBuffer(b) && b.length >= 4 ? b.readUInt32LE(0) : 0);
      win.hookWindowMessage(WM_ENTERMENULOOP, (wParam) => {
        if (!word(wParam)) systemMenuOpen = true;
      });
      win.hookWindowMessage(WM_EXITMENULOOP, (wParam) => {
        if (word(wParam) || !systemMenuOpen) return;
        systemMenuOpen = false;
        systemMenuClosedAt = Date.now();
      });
    }
    ipcMain.removeAllListeners('ht:show-menu');
    ipcMain.on('ht:show-menu', (event, x, y) => {
      if (!fromPage(event)) return;
      if (systemMenuOpen || Date.now() - systemMenuClosedAt < 400) return;
      const menu = Menu.getApplicationMenu();
      const zoom = win.webContents.getZoomFactor();
      if (menu) menu.popup({ window: win, x: Math.round((Number(x) || 0) * zoom), y: Math.round((Number(y) || 0) * zoom) });
    });
    // Windows: the window buttons take the page's title bar colors (theme and palette).
    ipcMain.removeAllListeners('ht:title-bar-colors');
    ipcMain.on('ht:title-bar-colors', (event, color, symbolColor) => {
      if (!fromPage(event) || !CUSTOM_TITLE_BAR) return;
      const hex = /^#[0-9a-f]{6}$/i;
      if (hex.test(String(color)) && hex.test(String(symbolColor))) win.setTitleBarOverlay({ color, symbolColor, height: TITLE_BAR_HEIGHT });
    });
    // Windows: the same for logging off, restarting or shutting down. While Windows asks whether it may end the
    // session, an open quit question is dismissed (as Cancel) so it never holds up the system; when the session
    // really ends, quit as above.
    win.on('query-session-end', () => {
      if (questionAbort) questionAbort.abort();
    });
    win.on('session-end', () => onSystemEnding());
    win.on('focus', () => win && !win.isDestroyed() && win.flashFrame(false));
    win.on('close', (e) => {
      saveWindowState();
      if (quitting) return;
      e.preventDefault();
      // macOS: closing the window keeps the app (and members' turns) running, as Mac apps do; Cmd+Q quits.
      if (process.platform === 'darwin') {
        if (win.isFullScreen()) {
          win.once('leave-full-screen', () => win && win.hide());
          win.setFullScreen(false);
        } else win.hide();
        return;
      }
      void confirmAndQuit();
    });
    // Updates: the page shows the state in the title bar and asks for the download and the restart.
    ipcMain.removeHandler('ht:update-get');
    ipcMain.handle('ht:update-get', (event) => (fromPage(event) && updater ? updater.state() : null));
    ipcMain.removeAllListeners('ht:update-action');
    ipcMain.on('ht:update-action', (event, action) => {
      if (!fromPage(event) || !updater) return;
      if (action === 'download') void updater.download();
      else if (action === 'restart') void restartToUpdate();
      else if (action === 'check') void checkUpdatesNow();
    });
    void win.loadURL(info.launchUrl);
    if (!attentionTimer) attentionTimer = setInterval(() => void pollAttention(), ATTENTION_POLL_MS);
    if (updater && !updateTimer) {
      setTimeout(() => void updater.check(), UPDATE_FIRST_CHECK_MS);
      updateTimer = setInterval(() => void updater.check(), UPDATE_CHECK_EVERY_MS);
    }
  }

  function onSystemEnding() {
    log.write('[shell] system is logging out or shutting down');
    systemEnding = true;
    if (questionAbort) questionAbort.abort();
    void quit();
  }

  /** GET from the local Core with the launch token (never written anywhere). */
  async function coreGet(pathname) {
    const token = new URL(info.launchUrl).searchParams.get('token');
    const res = await fetch(`${info.url}${pathname}`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`${pathname}: ${res.status}`);
    return res.json();
  }

  // ---- Outside the window: keep the computer awake while members work, show approvals waiting for the user ----
  async function pollAttention() {
    if (quitting || polling || !info) return;
    polling = true;
    try {
      const a = await coreGet('/api/attention');
      if (quitting) return;
      setKeepAwake(a.working > 0);
      showApprovals(a.approvals);
    } catch {
      // Core busy or stopping: try again at the next tick
    } finally {
      polling = false;
    }
  }

  /** Idle sleep (and App Nap) would cut members' turns off; the display may still sleep. Lid close still sleeps. */
  function setKeepAwake(on) {
    if (on && keepAwakeId === null) {
      keepAwakeId = powerSaveBlocker.start('prevent-app-suspension');
      log.write('[shell] members are working: keeping the computer awake');
    } else if (!on && keepAwakeId !== null) {
      powerSaveBlocker.stop(keepAwakeId);
      keepAwakeId = null;
      log.write('[shell] no member is working: the computer may sleep again');
    }
  }

  /** Number of approvals on the Dock icon (macOS) / a dot on the taskbar button (Windows); a nudge when one arrives. */
  function showApprovals(n) {
    const w = win && !win.isDestroyed() ? win : null;
    if (process.platform === 'darwin') app.dock?.setBadge(n > 0 ? String(n) : '');
    else if (process.platform === 'win32') {
      if (w) w.setOverlayIcon(n > 0 ? approvalDot() : null, n > 0 ? tr(`${n} 个待审批`, `${n} waiting for approval`) : '');
    } else app.setBadgeCount(n);
    if (n > lastApprovals && !(w && w.isVisible() && w.isFocused())) {
      if (process.platform === 'darwin') app.dock?.bounce('informational');
      else if (w) w.flashFrame(true);
    }
    if (n === 0 && w) w.flashFrame(false);
    if (n !== lastApprovals) {
      lastApprovals = n;
      updateMenu(); // the Chat menu shows the count
    }
  }

  /** A 16×16 dot for the taskbar overlay, drawn here (BGRA, premultiplied) so no extra asset is needed. */
  function approvalDot() {
    if (overlayDot) return overlayDot;
    const size = 16;
    const buf = Buffer.alloc(size * size * 4);
    const [r, g, b] = [0xe5, 0x48, 0x4d];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const d = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2);
        const alpha = Math.max(0, Math.min(1, size / 2 - 0.5 - d + 0.5));
        const i = (y * size + x) * 4;
        buf[i] = Math.round(b * alpha);
        buf[i + 1] = Math.round(g * alpha);
        buf[i + 2] = Math.round(r * alpha);
        buf[i + 3] = Math.round(255 * alpha);
      }
    }
    overlayDot = nativeImage.createFromBitmap(buf, { width: size, height: size });
    return overlayDot;
  }

  // ---- Application menu (menu.cjs): menu bar on macOS, the title bar's ☰ on Windows ----
  function updateMenu() {
    const template = menuTemplate({ platform: process.platform, zh: lang() === 'zh', state: menuState, approvals: lastApprovals, run: runCommand, updates: !!updater });
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  function runCommand(id, arg) {
    if (PAGE_COMMANDS.has(id)) {
      if (!win || win.isDestroyed()) return;
      if (!win.isVisible()) win.show();
      win.focus();
      win.webContents.send('ht:command', id, arg ?? null);
      return;
    }
    if (id === 'open-folder') void openFolder(menuState.folder);
    else if (id === 'open-logs') void openFolder(logDir);
    else if (id === 'open-data') void openFolder(dataDir);
    else if (id === 'releases') void shell.openExternal(`${REPO_URL}/releases`);
    else if (id === 'issues') void shell.openExternal(`${REPO_URL}/issues`);
    else if (id === 'about') void showAbout();
    else if (id === 'check-updates') void checkUpdatesNow();
    else if (id === 'diagnostics') void copyDiagnostics();
    else if (id === 'quit') void confirmAndQuit();
  }

  // noLink: Windows would otherwise draw buttons it doesn't recognize ("好", "Quit anyway") as "→" command links.
  function message(opts) {
    const o = { noLink: true, ...opts };
    return win && !win.isDestroyed() ? dialog.showMessageBox(win, o) : dialog.showMessageBox(o);
  }

  async function openFolder(dir) {
    let ok = false;
    try {
      ok = !!dir && fs.statSync(dir).isDirectory();
    } catch {
      // missing
    }
    if (!ok) {
      await message({ type: 'warning', buttons: [tr('好', 'OK')], message: tr('找不到这个文件夹', 'This folder was not found'), detail: String(dir || '') });
      return;
    }
    const err = await shell.openPath(dir);
    if (err) log.write(`[shell] open folder failed: ${err}`);
  }

  /** Help › Check for Updates: says what it found; a found update can be downloaded right away. */
  async function checkUpdatesNow() {
    if (!updater) return;
    await syncPageLang();
    const r = await updater.check();
    if (r.error && !r.update) {
      await message({ type: 'warning', buttons: [tr('好', 'OK')], title: tr('检查更新', 'Check for Updates'), message: tr('无法检查更新', 'Could not check for updates'), detail: r.error });
      return;
    }
    if (!r.update) {
      await message({ type: 'info', buttons: [tr('好', 'OK')], title: tr('检查更新', 'Check for Updates'), message: tr(`Harness Team ${app.getVersion()} 已是最新版本`, `Harness Team ${app.getVersion()} is up to date`) });
      return;
    }
    const s = updater.state();
    if (s.state === 'downloading' || s.state === 'ready') return;
    const a = await message({
      type: 'info',
      buttons: [tr('下载', 'Download'), tr('稍后', 'Later'), tr('查看说明', 'Release Notes')],
      defaultId: 0,
      cancelId: 1,
      title: tr('检查更新', 'Check for Updates'),
      message: tr(`Harness Team ${r.update.version} 可用（当前 ${app.getVersion()}）`, `Harness Team ${r.update.version} is available (you have ${app.getVersion()})`),
    });
    if (a.response === 0) void updater.download();
    else if (a.response === 2) void shell.openExternal(r.update.page);
  }

  /** "Restart to update": quits as the window's close does (asking when members work); the installer runs on exit. */
  async function restartToUpdate() {
    if (!updater || quitting) return;
    const file = await updater.installer();
    if (!file) return;
    installOnQuit = file;
    await confirmAndQuit();
    if (!quitting) installOnQuit = null;
  }

  function osName() {
    return osLabel(process.platform, process.getSystemVersion(), process.arch);
  }

  function showAbout() {
    return message({
      type: 'info',
      buttons: [tr('好', 'OK')],
      title: tr('关于 Harness Team', 'About Harness Team'),
      message: `Harness Team ${app.getVersion()}`,
      detail: `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}\n${osName()}\n\n${REPO_URL}`,
    });
  }

  /** Versions and each harness's detection result, for a bug report; no paths, logins or chat content. */
  async function copyDiagnostics() {
    let runtimes = null;
    let chatProviders = null;
    try {
      runtimes = (await coreGet('/api/runtimes')).runtimes ?? null;
    } catch {
      // reported as unavailable in the text
    }
    try {
      // Only how many providers a Chat member can use (as Add member counts them); no names, URLs or keys.
      const list = (await coreGet('/api/chat-providers')).providers;
      if (Array.isArray(list)) chatProviders = list.filter((p) => p && p.enabled && !p.legacy && Array.isArray(p.models) && p.models.some((m) => m && m.enabled)).length;
    } catch {
      // left out of the text
    }
    const text = diagnosticsText({ appVersion: app.getVersion(), packaged: app.isPackaged, os: osName(), versions: process.versions, runtimes, chatProviders });
    clipboard.writeText(text);
    await message({
      type: 'info',
      buttons: [tr('好', 'OK')],
      title: tr('复制诊断信息', 'Copy Diagnostic Info'),
      message: tr('诊断信息已复制到剪贴板。', 'Diagnostic info was copied to the clipboard.'),
      detail: text,
    });
  }

  /** Title bar colors before the page reports its own: the default palette's sidebar in the system's tone. */
  function startTitleBarColors() {
    return nativeTheme.shouldUseDarkColors ? { color: '#111113', symbolColor: '#ececef' } : { color: '#f7f7f8', symbolColor: '#18181b' };
  }

  function confirmAndQuit() {
    if (confirming) {
      if (win && !win.isDestroyed()) {
        if (!win.isVisible()) win.show();
        win.focus();
      }
      return confirming;
    }
    confirming = askAndQuit().finally(() => {
      confirming = null;
    });
    return confirming;
  }

  async function askAndQuit() {
    let busy = [];
    try {
      const agents = (await coreGet('/api/agents')).agents || [];
      busy = agents.filter((a) => a.status === 'working' || a.status === 'waiting');
    } catch {
      // Core unreachable: nothing to protect
    }
    if (systemEnding) return quit();
    await syncPageLang();
    if (busy.length && win && !systemEnding) {
      if (!win.isVisible()) win.show(); // the question is a sheet on the window, which may be hidden on macOS
      const names = busy.map((a) => '@' + a.handle);
      questionAbort = new AbortController();
      const r = await dialog.showMessageBox(win, {
        signal: questionAbort.signal,
        noLink: true,
        type: 'warning',
        buttons: [tr('仍然退出', 'Quit anyway'), tr('取消', 'Cancel')],
        defaultId: 1,
        cancelId: 1,
        title: tr('有成员正在工作', 'Members are working'),
        message: tr(`${names.join('、')} 仍在工作或等待中。`, `${names.join(', ')} ${names.length > 1 ? 'are' : 'is'} still working or waiting.`),
        detail: tr(
          '退出会停止 Harness Team 和它为成员启动的 Harness 进程；未完成的回合在下次启动时标为「已中断」，不会自动重跑。',
          'Quitting stops Harness Team and the harness processes it started for members; unfinished turns are marked “Interrupted” at the next start and are not rerun automatically.',
        ),
      }).finally(() => {
        questionAbort = null;
      });
      if (systemEnding) return quit();
      if (r.response !== 0) return;
    }
    await quit();
  }

  async function quit() {
    if (quitting) return;
    quitting = true;
    if (attentionTimer) clearInterval(attentionTimer);
    setKeepAwake(false);
    if (win) win.hide();
    if (updateTimer) clearInterval(updateTimer);
    await stopCore();
    if (installOnQuit) {
      try {
        launchInstaller(installOnQuit);
        log.write('[shell] quit to install an update');
      } catch (e) {
        log.write(`[shell] could not start the update installer: ${e && e.message}`);
      }
    }
    log.write('[shell] quit');
    app.exit(0);
  }

  function stopCore() {
    return new Promise((resolve) => {
      if (!core || coreExited) return resolve();
      const timer = setTimeout(() => {
        log.write('[shell] Core did not stop in time; killing it');
        core.kill();
        resolve();
      }, SHUTDOWN_TIMEOUT_MS);
      core.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      core.postMessage({ type: 'shutdown' });
    });
  }

  app.on('window-all-closed', () => void quit());
  app.on('before-quit', (e) => {
    if (quitting) return;
    e.preventDefault();
    // macOS: Cmd+Q, the app menu and the Dock's Quit arrive here, not at the window's close, so ask the same way
    // (but not while the system is logging out or shutting down).
    void (process.platform === 'darwin' && !systemEnding ? confirmAndQuit() : quit());
  });
}

/** Core output goes to <logDir>/core.log (the launch link with its token is never written). */
function openLog(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'core.log');
  try {
    if (fs.statSync(file).size > 2 * 1024 * 1024) fs.renameSync(file, file + '.1');
  } catch {
    // no previous log
  }
  return {
    file,
    write(text) {
      const safe = String(text)
        .split(/\r?\n/)
        .filter((l) => l.length > 0)
        .map((l) => l.replace(/token=[0-9a-f]+/gi, 'token=<redacted>'))
        .map((l) => `${new Date().toISOString()} ${l}`)
        .join('\n');
      if (!safe) return;
      try {
        fs.appendFileSync(file, safe + '\n');
      } catch {
        // logging must never stop the app
      }
    },
  };
}

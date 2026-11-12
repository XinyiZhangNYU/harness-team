'use strict';
// Application menu of the desktop shell. Pure: builds an Electron menu template from the platform, the language and
// what the page reported (its chats in sidebar order, the open chat, whether it has a project folder) plus the number
// of approvals waiting. `run(id, arg)` performs a command; main.cjs sends the page's commands to the window.
// macOS shows it in the menu bar; Windows shows it from the ☰ button in the window's own title bar.

const REPO_URL = 'https://github.com/XinyiZhangNYU/harness-team';

/** Commands the page carries out (sent to the window); every other id is handled by the shell. */
const PAGE_COMMANDS = new Set([
  'new-chat',
  'add-member',
  'settings',
  'usage',
  'toggle-rooms',
  'toggle-members',
  'prev-room',
  'next-room',
  'room',
  'next-approval',
]);

/** Chats listed in the Chat menu, with Ctrl/Cmd+1…9. */
const MAX_LISTED_ROOMS = 9;

/**
 * @typedef {{ rooms: { id: string, name: string }[], currentRoomId: string | null, folder: string | null, lang: 'zh' | 'en' | null }} MenuState
 */

/** @returns {MenuState} */
function emptyMenuState() {
  return { rooms: [], currentRoomId: null, folder: null, lang: null };
}

/**
 * What the page sent, checked: anything malformed becomes empty. Names are shortened; nothing else is kept.
 * @returns {MenuState}
 */
function cleanMenuState(raw) {
  const s = emptyMenuState();
  if (!raw || typeof raw !== 'object') return s;
  if (Array.isArray(raw.rooms)) {
    for (const r of raw.rooms.slice(0, 500)) {
      if (r && typeof r.id === 'string' && typeof r.name === 'string' && r.id.length <= 100) {
        s.rooms.push({ id: r.id, name: r.name.slice(0, 80) });
      }
    }
  }
  if (typeof raw.currentRoomId === 'string' && s.rooms.some((r) => r.id === raw.currentRoomId)) s.currentRoomId = raw.currentRoomId;
  if (typeof raw.folder === 'string' && raw.folder.length > 0 && raw.folder.length <= 4096) s.folder = raw.folder;
  if (raw.lang === 'zh' || raw.lang === 'en') s.lang = raw.lang;
  return s;
}

/**
 * @param {{ platform: string, zh: boolean, state: MenuState, approvals: number, run: (id: string, arg?: string) => void }} o
 * @returns {Electron.MenuItemConstructorOptions[]}
 */
function menuTemplate({ platform, zh, state, approvals, run, updates = false }) {
  const mac = platform === 'darwin';
  const tr = (a, b) => (zh ? a : b);
  // Windows / Linux menus read "&" as the access-key marker: top-level menus get one, user text is escaped.
  const top = (zhLabel, enLabel, key) => (mac ? tr(zhLabel, enLabel) : zh ? `${zhLabel}(&${key})` : enLabel.replace(key, `&${key}`));
  const text = (s) => (mac ? s : s.replace(/&/g, '&&'));
  const cmd = (id, label, extra = {}) => ({ label, click: () => run(id), ...extra });
  const sep = { type: 'separator' };
  const hasRoom = !!state.currentRoomId;
  const multiRoom = state.rooms.length > 1;

  // Windows / Linux menus name the comma key "Comma" ("Ctrl+Comma"), so there the item shows no shortcut and the shell
  // handles Ctrl+, itself (isSettingsKey).
  const settings = cmd('settings', tr('设置…', 'Settings…'), mac ? { accelerator: 'Cmd+,' } : {});
  const usage = cmd('usage', tr('用量…', 'Usage…'));

  /** @type {Electron.MenuItemConstructorOptions[]} */
  const menu = [];
  if (mac) {
    menu.push({
      label: 'Harness Team',
      submenu: [
        { role: 'about', label: tr('关于 Harness Team', 'About Harness Team') },
        sep,
        settings,
        usage,
        sep,
        { role: 'services', label: tr('服务', 'Services') },
        sep,
        { role: 'hide', label: tr('隐藏 Harness Team', 'Hide Harness Team') },
        { role: 'hideOthers', label: tr('隐藏其他', 'Hide Others') },
        { role: 'unhide', label: tr('全部显示', 'Show All') },
        sep,
        { role: 'quit', label: tr('退出 Harness Team', 'Quit Harness Team') },
      ],
    });
  }

  menu.push({
    label: top('文件', 'File', 'F'),
    submenu: [
      cmd('new-chat', tr('新建群聊…', 'New Chat…'), { accelerator: 'CmdOrCtrl+N' }),
      cmd('add-member', tr('添加成员…', 'Add Member…'), { accelerator: 'CmdOrCtrl+Shift+N', enabled: hasRoom }),
      sep,
      cmd('open-folder', mac ? tr('在访达中打开项目文件夹', 'Open Project Folder in Finder') : tr('在资源管理器中打开项目文件夹', 'Open Project Folder in Explorer'), {
        enabled: hasRoom && !!state.folder,
      }),
      sep,
      ...(mac ? [{ role: 'close', label: tr('关闭窗口', 'Close Window') }] : [settings, usage, sep, cmd('quit', tr('退出', 'Exit'))]),
    ],
  });

  menu.push({
    label: top('编辑', 'Edit', 'E'),
    submenu: [
      { role: 'undo', label: tr('撤销', 'Undo') },
      { role: 'redo', label: tr('重做', 'Redo') },
      sep,
      { role: 'cut', label: tr('剪切', 'Cut') },
      { role: 'copy', label: tr('复制', 'Copy') },
      { role: 'paste', label: tr('粘贴', 'Paste') },
      ...(mac ? [{ role: 'pasteAndMatchStyle', label: tr('粘贴并匹配样式', 'Paste and Match Style') }] : []),
      sep,
      { role: 'selectAll', label: tr('全选', 'Select All') },
    ],
  });

  menu.push({
    label: top('视图', 'View', 'V'),
    submenu: [
      cmd('toggle-rooms', tr('显示或隐藏群聊列表', 'Show or Hide Chats'), { accelerator: 'CmdOrCtrl+B' }),
      cmd('toggle-members', tr('显示或隐藏成员', 'Show or Hide Members'), { accelerator: 'CmdOrCtrl+Alt+B', enabled: hasRoom }),
      sep,
      { role: 'resetZoom', label: tr('实际大小', 'Actual Size') },
      { role: 'zoomIn', label: tr('放大', 'Zoom In'), accelerator: 'CmdOrCtrl+=' },
      { role: 'zoomOut', label: tr('缩小', 'Zoom Out') },
      // Not on macOS: AppKit adds its own "Enter Full Screen" (to the Window menu when it does not recognise this one
      // as View). A togglefullscreen item there gets a hidden copy from AppKit that Electron's menu refresh shows,
      // so it was drawn twice.
      ...(mac ? [] : [sep, { role: 'togglefullscreen', label: tr('全屏', 'Full Screen') }]),
    ],
  });

  const listed = state.rooms.slice(0, MAX_LISTED_ROOMS);
  menu.push({
    label: top('群聊', 'Chat', 'C'),
    submenu: [
      cmd('next-approval', approvals > 0 ? tr(`下一个待审批（${approvals}）`, `Next Approval (${approvals})`) : tr('下一个待审批', 'Next Approval'), {
        accelerator: 'CmdOrCtrl+Shift+A',
        enabled: approvals > 0,
      }),
      sep,
      cmd('prev-room', tr('上一个群聊', 'Previous Chat'), { accelerator: mac ? 'Cmd+Shift+[' : 'Ctrl+Shift+Tab', enabled: multiRoom }),
      cmd('next-room', tr('下一个群聊', 'Next Chat'), { accelerator: mac ? 'Cmd+Shift+]' : 'Ctrl+Tab', enabled: multiRoom }),
      ...(listed.length ? [sep] : []),
      ...listed.map((r, i) => ({
        label: text(r.name),
        type: 'radio',
        checked: r.id === state.currentRoomId,
        accelerator: `CmdOrCtrl+${i + 1}`,
        click: () => run('room', r.id),
      })),
    ],
  });

  if (mac) menu.push({ role: 'windowMenu', label: tr('窗口', 'Window') });

  menu.push({
    ...(mac ? { role: 'help' } : {}),
    label: top('帮助', 'Help', 'H'),
    submenu: [
      ...(mac ? [] : [cmd('about', tr('关于 Harness Team', 'About Harness Team')), sep]),
      ...(updates ? [cmd('check-updates', tr('检查更新…', 'Check for Updates…'))] : []),
      cmd('releases', updates ? tr('版本发布页', 'Releases Page') : tr('查看新版本', 'Check for New Versions')),
      cmd('issues', tr('报告问题', 'Report an Issue')),
      sep,
      cmd('open-logs', tr('打开日志文件夹', 'Open Logs Folder')),
      cmd('open-data', tr('打开数据文件夹', 'Open Data Folder')),
      cmd('diagnostics', tr('复制诊断信息', 'Copy Diagnostic Info')),
      sep,
      { role: 'toggleDevTools', label: tr('开发者工具', 'Developer Tools') },
    ],
  });
  return menu;
}

/**
 * Plain-text summary for bug reports: versions and what each harness reported. No paths, logins or chat content.
 * @param {{ appVersion: string, packaged: boolean, os: string, versions: Record<string, string | undefined>, runtimes: any[] | null }} o
 */
function diagnosticsText({ appVersion, packaged, os, versions, runtimes, chatProviders = null }) {
  const lines = [
    `Harness Team ${appVersion}${packaged ? '' : ' (development)'}`,
    `${os}`,
    `Electron ${versions.electron ?? '?'}, Chromium ${versions.chrome ?? '?'}, Node ${versions.node ?? '?'}`,
    'Harnesses:',
  ];
  if (!Array.isArray(runtimes)) lines.push('- (not available: the local service did not answer)');
  else {
    for (const r of runtimes) {
      if (!r || r.isMock) continue;
      const problem = r.problem && typeof r.problem === 'object' ? r.problem.en : r.problem;
      const parts = [r.available ? 'available' : r.installed === false ? 'not installed' : 'not available'];
      if (r.version) parts.push(String(r.version));
      if (r.billing) parts.push(`billing: ${r.billing}`);
      // Chat members also need a model provider (Settings → Model providers) before one can be added.
      if (r.kind === 'chat' && r.available && typeof chatProviders === 'number')
        parts.push(chatProviders ? `model providers ready: ${chatProviders}` : 'no model provider set up yet, so no API member can be added');
      if (!r.available && problem) parts.push(String(problem));
      lines.push(`- ${r.label ?? r.kind}: ${parts.join(', ')}`);
    }
  }
  return lines.join('\n');
}

/**
 * Ctrl+, pressed in the window (Windows / Linux), which opens Settings.
 * @param {{ type: string, key: string, control: boolean, alt: boolean, shift: boolean, meta: boolean }} input
 */
function isSettingsKey(input) {
  return input.type === 'keyDown' && input.key === ',' && input.control && !input.alt && !input.shift && !input.meta;
}

/**
 * The system for About and the diagnostics. Windows 11 still reports version 10.0, with build 22000 or later.
 * @param {string} platform @param {string} version @param {string} arch
 */
function osLabel(platform, version, arch) {
  if (platform === 'win32') {
    const [major, , build] = version.split('.').map(Number);
    const name = major === 10 ? (build >= 22000 ? 'Windows 11' : 'Windows 10') : 'Windows';
    return `${name} (${version}) ${arch}`;
  }
  return `${platform === 'darwin' ? 'macOS' : 'Linux'} ${version} ${arch}`;
}

/**
 * What a second launch that asked for another data folder is told (the running window takes it over; only one Harness
 * Team window runs at a time). Null when it asked for the same folder or none: then focusing the window is enough.
 */
function secondLaunchNotice(lang, running, requested, sameFolder) {
  if (!requested || sameFolder(running, requested)) return null;
  return lang === 'zh'
    ? {
        message: 'Harness Team 已在运行',
        detail: `正在运行的实例使用数据目录 ${running}。\n另一个数据目录（${requested}）的启动没有打开：同一时间只能运行一个 Harness Team。请先退出它，再用那个数据目录启动。`,
      }
    : {
        message: 'Harness Team is already running',
        detail: `The running instance uses the data folder ${running}.\nThe launch with another data folder (${requested}) was not opened: only one Harness Team runs at a time. Quit it first, then start with that data folder.`,
      };
}

module.exports = { secondLaunchNotice, REPO_URL, PAGE_COMMANDS, MAX_LISTED_ROOMS, emptyMenuState, cleanMenuState, menuTemplate, diagnosticsText, isSettingsKey, osLabel };

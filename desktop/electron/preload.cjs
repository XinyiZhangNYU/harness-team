'use strict';
// Sandboxed preload for the Harness Team window. It exposes to the page: the native folder dialog (returns the chosen
// directory path or null); "open" / "show in folder" for an attached file, named by its ids (the main process rebuilds
// and checks the path); and the application menu: its commands arrive here, the page reports what the menu lists, and
// on Windows the page draws the title bar with the ☰ button that opens the menu, and the in-app update button.
// No Node access, no file reading.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('harnessDesktop', {
  /** @param {string | undefined} defaultPath */
  pickFolder: (defaultPath) => ipcRenderer.invoke('ht:pick-folder', typeof defaultPath === 'string' ? defaultPath : ''),
  /**
   * @param {'open' | 'reveal'} action
   * @param {{ roomId: string, id: string, name: string }} ref
   */
  attachment: (action, ref) =>
    ipcRenderer.invoke('ht:attachment', action === 'open' ? 'open' : 'reveal', {
      roomId: String(ref && ref.roomId),
      id: String(ref && ref.id),
      name: String(ref && ref.name),
    }),
  /**
   * A file a member cited in its reply, by absolute path (the main process checks it).
   * @param {'open' | 'reveal'} action
   * @param {string} filePath
   */
  localFile: (action, filePath) => ipcRenderer.invoke('ht:local-file', action === 'open' ? 'open' : 'reveal', String(filePath)),
  /** Height of the title bar the page draws (Windows; same value as main.cjs), 0 where the system draws it. */
  titleBarHeight: process.platform === 'win32' ? 36 : 0,
  /** @param {(id: string, arg: string | null) => void} listener @returns {() => void} */
  onCommand: (listener) => {
    const h = (_e, id, arg) => listener(String(id), arg == null ? null : String(arg));
    ipcRenderer.on('ht:command', h);
    return () => ipcRenderer.removeListener('ht:command', h);
  },
  /** @param {{ rooms: { id: string, name: string }[], currentRoomId: string | null, folder: string | null, lang: string }} state */
  setMenuState: (state) => ipcRenderer.send('ht:menu-state', state),
  /** Opens the application menu at (x, y) in page pixels. */
  showMenu: (x, y) => ipcRenderer.send('ht:show-menu', Number(x) || 0, Number(y) || 0),
  /** Colors of the window buttons drawn over the title bar, as #rrggbb. */
  setTitleBarColors: (color, symbolColor) => ipcRenderer.send('ht:title-bar-colors', String(color), String(symbolColor)),
  /** Settings → keep the computer awake while members work: the saved choice (off by default). */
  getKeepAwake: () => ipcRenderer.invoke('ht:keep-awake-get'),
  /** @param {boolean} on @returns {Promise<boolean | null>} the choice now in effect */
  setKeepAwake: (on) => ipcRenderer.invoke('ht:keep-awake-set', on === true),
  /** Settings → automatic updates: the saved choice (on by default; null where the shell does not update itself). */
  getAutoUpdate: () => ipcRenderer.invoke('ht:auto-update-get'),
  /** @param {boolean} on @returns {Promise<boolean | null>} the choice now in effect */
  setAutoUpdate: (on) => ipcRenderer.invoke('ht:auto-update-set', on === true),
  /** Settings → open at login, as the system has it (null where the shell does not offer it). */
  getOpenAtLogin: () => ipcRenderer.invoke('ht:open-at-login-get'),
  /** @param {boolean} on @returns {Promise<boolean | null>} the state now in effect */
  setOpenAtLogin: (on) => ipcRenderer.invoke('ht:open-at-login-set', on === true),
  /** In-app update state (null where the shell does not update itself). */
  getUpdate: () => ipcRenderer.invoke('ht:update-get'),
  /** @param {(state: object) => void} listener @returns {() => void} */
  onUpdate: (listener) => {
    const h = (_e, state) => listener(state);
    ipcRenderer.on('ht:update', h);
    return () => ipcRenderer.removeListener('ht:update', h);
  },
  /** @param {'download' | 'restart' | 'check'} action */
  updateAction: (action) => ipcRenderer.send('ht:update-action', action === 'restart' ? 'restart' : action === 'check' ? 'check' : 'download'),
});

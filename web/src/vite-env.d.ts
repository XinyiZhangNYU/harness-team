/// <reference types="vite/client" />

interface Window {
  /** Present only inside the Harness Team desktop shell (desktop/electron/preload.cjs). */
  harnessDesktop?: {
    /** Native folder dialog; resolves to the chosen directory, or null when cancelled. */
    pickFolder(defaultPath?: string): Promise<string | null>;
    /**
     * Opens an attached file with its default program, or shows it in its folder. Programs, scripts and pages are
     * only shown in the folder (`revealed: true`). Absent in shells built before attachments.
     */
    attachment?(
      action: 'open' | 'reveal',
      ref: { roomId: string; id: string; name: string },
    ): Promise<{ ok: true; revealed: boolean } | { ok: false; error: 'denied' | 'missing' }>;
    /** Same as `attachment`, for a file a member cited by absolute path (absent in shells built before 0.12.4). */
    localFile?(action: 'open' | 'reveal', path: string): Promise<{ ok: true; revealed: boolean } | { ok: false; error: 'denied' | 'missing' }>;
    /** The application menu (absent in shells built before it). Height of the title bar the page draws; 0 = none. */
    titleBarHeight?: number;
    /** Menu commands for the page (see desktop/electron/menu.cjs); returns the unsubscribe function. */
    onCommand?(listener: (id: string, arg: string | null) => void): () => void;
    /** What the menu lists: chats in sidebar order, the open one, its project folder, the UI language. */
    setMenuState?(state: { rooms: { id: string; name: string }[]; currentRoomId: string | null; folder: string | null; lang: string }): void;
    /** Opens the application menu at (x, y) in page pixels (the title bar's ☰). */
    showMenu?(x: number, y: number): void;
    /** Colors of the window buttons drawn over the title bar, as #rrggbb. */
    setTitleBarColors?(color: string, symbolColor: string): void;
    /** Settings → keep the computer awake while members work (absent in older shells). */
    getKeepAwake?(): Promise<boolean | null>;
    setKeepAwake?(on: boolean): Promise<boolean | null>;
    /** Settings → automatic updates (absent in older shells; null where the shell does not update itself). */
    getAutoUpdate?(): Promise<boolean | null>;
    setAutoUpdate?(on: boolean): Promise<boolean | null>;
    /** Settings → open at login (absent in older shells; null where the shell does not offer it). */
    getOpenAtLogin?(): Promise<boolean | null>;
    setOpenAtLogin?(on: boolean): Promise<boolean | null>;
    /** In-app updates (installed Windows app; absent in older shells, null state where it does not update itself). */
    getUpdate?(): Promise<DesktopUpdate | null>;
    onUpdate?(listener: (state: DesktopUpdate) => void): () => void;
    updateAction?(action: 'download' | 'restart' | 'check'): void;
  };
}

interface DesktopUpdate {
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error';
  version?: string;
  percent?: number;
  error?: string;
}

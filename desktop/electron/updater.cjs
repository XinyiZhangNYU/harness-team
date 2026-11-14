'use strict';
// In-app updates for the Windows desktop app. The latest release of the public repository is read from the GitHub
// API; its installer (Harness-Team-Setup-<version>.exe) is downloaded when the user asks or, with automatic updates on,
// when a scheduled check finds it; it is checked against the SHA-256 digest GitHub lists for that file, and run
// silently (it updates the existing installation and starts the app again) only when the user chooses to restart. Nothing is published, signed in to or sent anywhere.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPO = 'XinyiZhangNYU/harness-team';
const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`;
const MAX_INSTALLER_BYTES = 600 * 1024 * 1024;

/** "v1.2.3" / "1.2.3-beta.1" → comparable parts; null when it is not a version. */
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v || '').trim());
  return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || null } : null;
}

/** Negative when a is older than b, positive when newer, 0 when equal; null when either is not a version. */
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i];
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/**
 * The update a "latest release" answer offers over `current`, or null when it offers none. The installer must be the
 * release's own Setup file for that version, downloaded from this repository's releases, with a SHA-256 digest.
 * @returns {{ version: string, url: string, size: number, sha256: string, page: string } | null}
 */
function pickUpdate(release, current) {
  if (!release || release.draft || release.prerelease) return null;
  const version = String(release.tag_name || '').replace(/^v/, '');
  const newer = compareVersions(version, current);
  if (newer === null || newer <= 0) return null;
  const name = `Harness-Team-Setup-${version}.exe`;
  const asset = (Array.isArray(release.assets) ? release.assets : []).find((a) => a && a.name === name);
  if (!asset) return null;
  const url = String(asset.browser_download_url || '');
  const digest = /^sha256:([0-9a-f]{64})$/i.exec(String(asset.digest || ''));
  const size = Number(asset.size);
  if (!url.startsWith(DOWNLOAD_PREFIX) || !digest || !(size > 0 && size <= MAX_INSTALLER_BYTES)) return null;
  const page = String(release.html_url || '');
  return { version, url, size, sha256: digest[1].toLowerCase(), page: page.startsWith(`https://github.com/${REPO}/`) ? page : `https://github.com/${REPO}/releases` };
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * The update state machine of the shell. `fetch` is the shell's (Electron's net.fetch: system proxy settings apply).
 * States: idle → checking → idle | available → downloading → ready, or error (with the step that failed).
 */
function createUpdater({ currentVersion, dir, fetch, log, onState }) {
  /** @type {{ state: string, version?: string, percent?: number, error?: string, step?: string }} */
  let st = { state: 'idle' };
  /** @type {ReturnType<typeof pickUpdate>} */
  let offer = null;
  let file = null;
  let checking = null;
  let downloading = null;
  const set = (next) => {
    st = next;
    onState({ ...st });
  };

  async function check() {
    if (checking) return checking;
    if (st.state === 'downloading' || st.state === 'ready') return { update: offer };
    checking = (async () => {
      const before = st;
      set({ state: 'checking' });
      try {
        const res = await fetch(LATEST_URL, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Harness-Team-Updater' } });
        // No release published yet.
        if (res.status === 404) {
          offer = null;
          set({ state: 'idle' });
          return { update: null };
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        offer = pickUpdate(await res.json(), currentVersion);
        set(offer ? { state: 'available', version: offer.version } : { state: 'idle' });
        return { update: offer };
      } catch (e) {
        log(`[update] check failed: ${e && e.message}`);
        set(before.state === 'available' ? before : { state: 'idle' });
        return { update: offer, error: String((e && e.message) || e) };
      } finally {
        checking = null;
      }
    })();
    return checking;
  }

  async function download() {
    if (downloading) return downloading;
    if (!offer) return false;
    const o = offer;
    downloading = (async () => {
      const target = path.join(dir, `Harness-Team-Setup-${o.version}.exe`);
      const part = `${target}.part`;
      set({ state: 'downloading', version: o.version, percent: 0 });
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
        const res = await fetch(o.url, { headers: { 'User-Agent': 'Harness-Team-Updater' } });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const h = crypto.createHash('sha256');
        const out = fs.createWriteStream(part);
        // A write that fails (disk full, no access) ends the download, never the app: the stream closes itself.
        let writeError = null;
        out.on('error', (e) => {
          writeError = e;
        });
        const settled = (event) => new Promise((r) => {
          out.once(event, r);
          out.once('close', r);
        });
        let got = 0;
        let shown = 0;
        try {
          for await (const chunk of res.body) {
            if (writeError) throw writeError;
            got += chunk.length;
            if (got > o.size) throw new Error('larger than listed');
            h.update(chunk);
            if (!out.write(chunk)) await settled('drain');
            const pct = Math.floor((got / o.size) * 100);
            if (pct !== shown) {
              shown = pct;
              set({ state: 'downloading', version: o.version, percent: pct });
            }
          }
        } finally {
          if (!out.closed) {
            const closed = settled('close');
            out.end();
            await closed;
          }
        }
        if (writeError) throw writeError;
        if (got !== o.size) throw new Error('incomplete download');
        if (h.digest('hex') !== o.sha256) throw new Error('SHA-256 mismatch');
        fs.renameSync(part, target);
        file = target;
        log(`[update] ${o.version} downloaded and verified`);
        set({ state: 'ready', version: o.version });
        return true;
      } catch (e) {
        log(`[update] download failed: ${e && e.message}`);
        try {
          fs.rmSync(part, { force: true });
        } catch {
          // Left for the next download, which empties the folder first.
        }
        set({ state: 'error', step: 'download', version: o.version, error: String((e && e.message) || e) });
        return false;
      } finally {
        downloading = null;
      }
    })();
    return downloading;
  }

  /** The verified installer to run at quit, checked again now; null (state error) when it changed or is gone. */
  async function installer() {
    if (st.state !== 'ready' || !file || !offer) return null;
    try {
      if ((await sha256File(file)) === offer.sha256) return file;
      throw new Error('SHA-256 mismatch');
    } catch (e) {
      log(`[update] installer check failed: ${e && e.message}`);
      file = null;
      set({ state: 'error', step: 'download', version: offer.version, error: String((e && e.message) || e) });
      return null;
    }
  }

  return { check, download, installer, state: () => ({ ...st }), offer: () => offer };
}

/**
 * Runs the NSIS installer silently, detached, as the app exits: it replaces the installed app and starts it again
 * (the same arguments electron-builder's own updater passes).
 */
function launchInstaller(file) {
  const child = spawn(file, ['--updated', '/S', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

module.exports = { compareVersions, pickUpdate, createUpdater, launchInstaller, sha256File, LATEST_URL, DOWNLOAD_PREFIX };

'use strict';
// The desktop shell's own preferences (userData/prefs.json): settings that only the shell can carry out.

const fs = require('node:fs');

/**
 * keepAwake: hold off idle sleep while members work (off by default).
 * autoUpdate: check for updates on a schedule and download a found one (on by default); installing always waits for
 * the user's "Restart to update".
 * @typedef {{ keepAwake: boolean, autoUpdate: boolean }} Prefs
 */

/** @returns {Prefs} */
function defaultPrefs() {
  return { keepAwake: false, autoUpdate: true };
}

/** Saved preferences; anything missing, unreadable or of the wrong type is the default. */
function readPrefs(file) {
  const out = defaultPrefs();
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved && typeof saved === 'object') {
      if (saved.keepAwake === true) out.keepAwake = true;
      if (saved.autoUpdate === false) out.autoUpdate = false;
    }
  } catch {
    // never saved, or unreadable: the defaults
  }
  return out;
}

/** @param {string} file @param {Prefs} prefs @returns {boolean} whether it was saved */
function writePrefs(file, prefs) {
  try {
    fs.writeFileSync(file, JSON.stringify({ keepAwake: prefs.keepAwake === true, autoUpdate: prefs.autoUpdate !== false }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether to hold off idle sleep: only when the user turned it on and some member runs a turn that does not wait for
 * the user's approval (a member waiting for an answer can wait while the computer sleeps).
 * @param {Prefs} prefs
 * @param {{ busy?: unknown }} attention Core's /api/attention counts
 */
function keepAwakeWanted(prefs, attention) {
  return prefs.keepAwake === true && typeof attention?.busy === 'number' && attention.busy > 0;
}

module.exports = { defaultPrefs, readPrefs, writePrefs, keepAwakeWanted };

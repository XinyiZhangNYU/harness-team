'use strict';
// The desktop shell's own preferences (userData/prefs.json): settings that only the shell can carry out.

const fs = require('node:fs');

/** @typedef {{ keepAwake: boolean }} Prefs */

/** @returns {Prefs} */
function defaultPrefs() {
  return { keepAwake: false };
}

/** Saved preferences; anything missing, unreadable or of the wrong type is the default (keep-awake off). */
function readPrefs(file) {
  const out = defaultPrefs();
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved && typeof saved === 'object' && saved.keepAwake === true) out.keepAwake = true;
  } catch {
    // never saved, or unreadable: the defaults
  }
  return out;
}

/** @param {string} file @param {Prefs} prefs @returns {boolean} whether it was saved */
function writePrefs(file, prefs) {
  try {
    fs.writeFileSync(file, JSON.stringify({ keepAwake: prefs.keepAwake === true }));
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

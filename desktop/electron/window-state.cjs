'use strict';
// The main window's size and position, kept across restarts (userData/window-state.json).

const fs = require('node:fs');

const MIN_WIDTH = 480;
const MIN_HEIGHT = 360;
/** How much of the saved window must still be on a display (so its title bar can be reached). */
const MIN_VISIBLE = 80;

/**
 * The bounds to open the window with, from what was saved last time, or null for the default size and position. A
 * saved window that no display shows enough of any more (a monitor was unplugged, the resolution changed) is not
 * reused; one larger than its display is shrunk to fit.
 * @param {unknown} saved
 * @param {{ x: number, y: number, width: number, height: number }[]} workAreas
 */
function restoreBounds(saved, workAreas) {
  if (!saved || typeof saved !== 'object') return null;
  const s = /** @type {Record<string, unknown>} */ (saved);
  const nums = ['x', 'y', 'width', 'height'].map((k) => s[k]);
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  let [x, y, width, height] = /** @type {number[]} */ (nums).map(Math.round);
  if (width < MIN_WIDTH || height < MIN_HEIGHT) return null;
  const overlap = (a) => {
    const w = Math.min(x + width, a.x + a.width) - Math.max(x, a.x);
    const h = Math.min(y + height, a.y + a.height) - Math.max(y, a.y);
    return w > 0 && h > 0 ? w * h : 0;
  };
  const area = workAreas.reduce((best, a) => (overlap(a) > (best ? overlap(best) : 0) ? a : best), null);
  if (!area) return null;
  // The top edge (title bar) must be on that display, with enough of it to grab.
  const top = Math.min(x + width, area.x + area.width) - Math.max(x, area.x);
  if (y < area.y || y > area.y + area.height - MIN_VISIBLE / 2 || top < MIN_VISIBLE) return null;
  width = Math.min(width, area.width);
  height = Math.min(height, area.height);
  x = Math.min(Math.max(x, area.x), area.x + area.width - width);
  y = Math.min(y, area.y + area.height - height);
  return { x, y, width, height, maximized: s.maximized === true };
}

/** @param {string} file */
function readState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** @param {string} file @param {{ x: number, y: number, width: number, height: number }} bounds @param {boolean} maximized */
function writeState(file, bounds, maximized) {
  try {
    fs.writeFileSync(file, JSON.stringify({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, maximized }));
  } catch {
    // not remembered this time
  }
}

module.exports = { restoreBounds, readState, writeState };

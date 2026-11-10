'use strict';
// Where an attachment lives on disk, and whether the desktop shell may hand it straight to its default program.
// Used by main.cjs for the "Open" / "Show in folder" buttons on file cards. The page only names the attachment
// (room id, attachment id, file name, as the server reported them); the path is rebuilt here under the data
// directory and must point at an existing file inside `<dataDir>/attachments`.
const fs = require('node:fs');
const path = require('node:path');

const ID = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Programs, scripts, shortcuts and pages: never opened directly (one click would run them). They are shown in their
 * folder instead, where the user decides.
 */
const NO_DIRECT_OPEN = new Set(
  (
    'exe com scr pif bat cmd ps1 psm1 psd1 vbs vbe js jse mjs cjs wsf wsh wsc hta msi msp mst msix msixbundle appx ' +
    'appxbundle appinstaller application appref-ms lnk url website reg inf scf cpl dll sys ocx drv jar py pyw rb pl sh ' +
    'html htm xhtml mht mhtml svg shtml xml chm hlp msc gadget settingcontent-ms library-ms search-ms searchconnector-ms ' +
    'iso img vhd vhdx xll xla xlam ppam docm dotm xlsm xltm pptm potm sldm'
  ).split(' '),
);

/** @param {string} name */
function canOpenDirectly(name) {
  const m = /\.([^.\\/]+)$/.exec(name);
  // No extension: Windows would ask which program to use, harmless but useless; show it in the folder.
  return !!m && !NO_DIRECT_OPEN.has(m[1].toLowerCase());
}

/**
 * Absolute path of an attachment file, or null if the reference is malformed or the file is not there.
 * @param {string} dataDir
 * @param {{ roomId?: unknown, id?: unknown, name?: unknown }} ref
 */
function attachmentPath(dataDir, ref) {
  if (!ref || typeof ref !== 'object') return null;
  const { roomId, id, name } = ref;
  if (typeof roomId !== 'string' || typeof id !== 'string' || typeof name !== 'string') return null;
  if (!ID.test(roomId) || !ID.test(id)) return null;
  if (!name || name.length > 255 || /[\\/:\u0000]/.test(name) || name === '.' || name === '..') return null;
  const root = path.resolve(dataDir, 'attachments');
  const p = path.resolve(root, roomId, id, name);
  const rel = path.relative(root, p);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.split(/[\\/]/).length !== 3) return null;
  try {
    // A real file, not a link that leads elsewhere.
    const st = fs.lstatSync(p);
    if (!st.isFile()) return null;
  } catch {
    return null;
  }
  return p;
}

module.exports = { attachmentPath, canOpenDirectly };

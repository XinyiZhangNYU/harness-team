/** Edge length of the stored avatar: enough for the 32px avatar on 3x screens, small enough for localStorage. */
const SIZE = 128;
const MAX_INPUT_BYTES = 20 * 1024 * 1024;

export class AvatarError extends Error {
  readonly reason: 'tooBig' | 'unreadable';
  constructor(reason: 'tooBig' | 'unreadable') {
    super(reason);
    this.reason = reason;
  }
}

/**
 * Turns an image file into a small square data URL: the centre of the picture is cropped to a square and scaled to
 * SIZE px. Everything happens in the page; the file is not sent anywhere.
 */
export async function avatarFromFile(file: File): Promise<string> {
  if (file.size > MAX_INPUT_BYTES) throw new AvatarError('tooBig');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new AvatarError('unreadable');
  }
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    if (!side) throw new AvatarError('unreadable');
    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new AvatarError('unreadable');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, SIZE, SIZE);
    // WebP keeps transparency and stays small; fall back to PNG where the browser cannot encode WebP.
    const webp = canvas.toDataURL('image/webp', 0.9);
    return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/png');
  } finally {
    bitmap.close();
  }
}

/** First character of a name for a letter avatar (whole emoji / surrogate pairs, not half of one). */
export function initial(name: string): string {
  return (Array.from(name.trim())[0] ?? '?').toUpperCase();
}

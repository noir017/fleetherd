export const SHRINK_LIMIT = 300 * 1024;
export const SHRINK_PIXELS = 2048 * 1536;
export const SHRINK_EDGE = 4096;
export const SHRINK_EDGE_MIN = 1024;
// iOS refuses a canvas over 16,777,216 pixels and can answer with a blank one rather than an error.
export const CANVAS_MAX_PIXELS = 4096 * 4096;
export const SHRINK_QUALITY_MAX = 0.92;
export const SHRINK_QUALITY_MIN = 0.5;

const STILL_MIME = /^image\/(jpeg|jpg|png|webp|heic|heif|avif|bmp|x-ms-bmp)$/i;
const STILL_NAME = /\.(jpe?g|png|webp|heic|heif|avif|bmp)$/i;

export interface PhotoLike {
  readonly width: number;
  readonly height: number;
  close?: () => void;
}

export interface FileLike {
  readonly name?: string;
  readonly type?: string;
  readonly size?: number;
}

export function stillImage(file: FileLike): boolean {
  const mime = String(file.type || '').toLowerCase();
  if (mime) return STILL_MIME.test(mime);
  return STILL_NAME.test(String(file.name || ''));
}

export function willShrink(file: FileLike | null | undefined): boolean {
  return Boolean(file && file.size && file.size > SHRINK_LIMIT && stillImage(file));
}

export function withMime(name: string | undefined, mime: string): string {
  let base = String(name || 'image');
  if (STILL_NAME.test(base)) base = base.replace(/\.[^.]*$/, '');
  const sub = mime === 'image/jpeg' ? 'jpg' : String(mime || '').split('/')[1];
  return `${base || 'image'}.${(sub || 'jpg').toLowerCase()}`;
}

export function readBase64(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result);
      const comma = s.indexOf(',');
      resolve(comma < 0 ? '' : s.slice(comma + 1));
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

function decodeViaImg(file: File): Promise<HTMLImageElement> {
  return readBase64(file).then((b64) => {
    if (b64 === null) throw new Error('the file could not be read');
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('the browser cannot decode it'));
      img.src = `data:${file.type || ''};base64,${b64}`;
    });
  });
}

function decodePhoto(file: File): Promise<PhotoLike> {
  let attempt: Promise<ImageBitmap> | null = null;
  if (typeof createImageBitmap === 'function') {
    try {
      attempt = createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      attempt = null;
    }
  }
  if (attempt && typeof attempt.then === 'function') {
    return attempt.then(
      (bitmap) => bitmap,
      () => decodeViaImg(file),
    );
  }
  return decodeViaImg(file);
}

function closePhoto(photo: PhotoLike | null): void {
  if (photo && typeof photo.close === 'function') {
    try {
      photo.close();
    } catch {
      // Ignore bitmap close errors.
    }
  }
}

function paintCanvas(
  doc: Document,
  w: number,
  h: number,
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  const canvas = doc.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
  return { canvas, ctx };
}

function canvasAt(doc: Document, img: PhotoLike, scale: number): HTMLCanvasElement | null {
  const iw = img.width;
  const ih = img.height;
  if (!iw || !ih) return null;
  const w = Math.max(1, Math.round(iw * scale));
  const h = Math.max(1, Math.round(ih * scale));
  let from: CanvasImageSource = img as CanvasImageSource;
  let fw = iw;
  let fh = ih;

  if (fw * fh > CANVAS_MAX_PIXELS) {
    const fit = Math.sqrt(CANVAS_MAX_PIXELS / (fw * fh));
    const cw = Math.max(w, Math.floor(fw * fit));
    const ch = Math.max(h, Math.floor(fh * fit));
    const first = paintCanvas(doc, cw, ch);
    if (!first) return null;
    first.ctx.drawImage(from, 0, 0, cw, ch);
    from = first.canvas;
    fw = cw;
    fh = ch;
  }

  while (fw > w * 2 && fh > h * 2) {
    const mw = Math.max(w, Math.round(fw / 2));
    const mh = Math.max(h, Math.round(fh / 2));
    const mid = paintCanvas(doc, mw, mh);
    if (!mid) return null;
    mid.ctx.drawImage(from, 0, 0, mw, mh);
    from = mid.canvas;
    fw = mw;
    fh = mh;
  }

  const out = paintCanvas(doc, w, h);
  if (!out) return null;
  out.ctx.drawImage(from, 0, 0, w, h);
  return out.canvas;
}

function encodeAs(doc: Document, canvas: HTMLCanvasElement, mime: string, quality: number): Promise<Blob | null> {
  let target = canvas;
  if (mime === 'image/jpeg') {
    const flat = paintCanvas(doc, canvas.width, canvas.height);
    if (!flat) return Promise.resolve(null);
    flat.ctx.fillStyle = '#fff';
    flat.ctx.fillRect(0, 0, canvas.width, canvas.height);
    flat.ctx.drawImage(canvas, 0, 0);
    target = flat.canvas;
  }
  return new Promise((resolve) => {
    try {
      target.toBlob((blob) => resolve(blob && blob.type === mime ? blob : null), mime, quality);
    } catch {
      resolve(null);
    }
  });
}

let webpProbe: Promise<boolean> | null = null;

function canEncodeWebp(doc: Document): Promise<boolean> {
  if (webpProbe) return webpProbe;
  webpProbe = new Promise((resolve) => {
    try {
      const c = doc.createElement('canvas');
      c.width = 1;
      c.height = 1;
      c.toBlob((b) => resolve(Boolean(b && b.type === 'image/webp')), 'image/webp', 0.8);
    } catch {
      resolve(false);
    }
  });
  return webpProbe;
}

function findQuality(
  doc: Document,
  canvas: HTMLCanvasElement,
  mime: string,
  limit: number,
  lo: number,
  hi: number,
  best: Blob,
  rounds: number,
): Promise<Blob> {
  if (rounds <= 0 || hi - lo < 0.05) return Promise.resolve(best);
  const q = (lo + hi) / 2;
  return encodeAs(doc, canvas, mime, q).then((blob) => {
    if (!blob) return best;
    if (blob.size <= limit) return findQuality(doc, canvas, mime, limit, q, hi, blob, rounds - 1);
    return findQuality(doc, canvas, mime, limit, lo, q, best, rounds - 1);
  });
}

function encodeAtSize(
  doc: Document,
  canvas: HTMLCanvasElement,
  mime: string,
  limit: number,
): Promise<{ fits: boolean; blob: Blob | null }> {
  let smallest: Blob | null = null;
  const track = (blob: Blob | null): Blob | null => {
    if (blob && (!smallest || blob.size < smallest.size)) smallest = blob;
    return blob;
  };
  return encodeAs(doc, canvas, mime, SHRINK_QUALITY_MAX).then((top) => {
    track(top);
    if (top && top.size <= limit) return { fits: true, blob: top };
    return encodeAs(doc, canvas, mime, SHRINK_QUALITY_MIN).then((bottom) => {
      track(bottom);
      if (!bottom || bottom.size > limit) return { fits: false, blob: smallest };
      return findQuality(doc, canvas, mime, limit, SHRINK_QUALITY_MIN, SHRINK_QUALITY_MAX, bottom, 5).then((best) => {
        track(best);
        return { fits: true, blob: best || bottom };
      });
    });
  });
}

function attemptFormat(doc: Document, photo: PhotoLike, mime: string): Promise<{ blob: Blob | null; any: boolean }> {
  let smallest: Blob | null = null;
  let any = false;
  const w = photo.width;
  const h = photo.height;
  const long = Math.max(w, h) || 1;
  let scale = Math.min(1, Math.sqrt(SHRINK_PIXELS / (w * h)), SHRINK_EDGE / long);
  const floor = Math.min(1, SHRINK_EDGE_MIN / long);

  const step = (): Promise<{ blob: Blob | null; any: boolean }> => {
    const canvas = canvasAt(doc, photo, scale);
    if (!canvas) return Promise.resolve({ blob: smallest, any });
    return encodeAtSize(doc, canvas, mime, SHRINK_LIMIT).then((out) => {
      if (out.blob) {
        any = true;
        if (!smallest || out.blob.size < smallest.size) smallest = out.blob;
      }
      if (out.fits) return { blob: out.blob, any: true };
      if (!out.blob) return { blob: smallest, any };
      const next = scale * 0.72;
      if (!(next < scale) || next < floor) return { blob: smallest, any };
      scale = Math.max(floor, next);
      return step();
    });
  };

  return step();
}

export function shrinkPhoto(file: File, doc: Document = document): Promise<{ blob: Blob } | null> {
  if (!willShrink(file)) return Promise.resolve(null);
  let photo: PhotoLike | null = null;
  return decodePhoto(file)
    .then((img) => {
      photo = img;
      return canEncodeWebp(doc);
    })
    .then((webp) => {
      if (!photo) return null;
      const active = photo;
      if (!webp) return attemptFormat(doc, active, 'image/jpeg').then((r) => r.blob);
      return attemptFormat(doc, active, 'image/webp').then((r) => {
        if (r.any) return r.blob;
        return attemptFormat(doc, active, 'image/jpeg').then((j) => j.blob);
      });
    })
    .then(
      (blob) => {
        closePhoto(photo);
        return blob && blob.size < file.size ? { blob } : null;
      },
      (err) => {
        closePhoto(photo);
        console.warn(`fleetherd: could not shrink ${file.name || 'a picture'}; sending the original`, err);
        return null;
      },
    );
}

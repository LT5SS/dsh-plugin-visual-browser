import zlib from 'node:zlib';

export interface DecodedPngRgba {
  width: number;
  height: number;
  data: Uint8Array;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Pure-Node decoder for standard non-interlaced 8-bit PNG images (colorType 0/2/4/6).
 * Returns null gracefully on malformed buffers or unsupported PNG variants.
 */
export function decodePngRgba(buf: Buffer): DecodedPngRgba | null {
  if (!Buffer.isBuffer(buf) || buf.length < 33) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (buf[i] !== PNG_SIGNATURE[i]) return null;
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let hasIhdr = false;
  const idatChunks: Buffer[] = [];

  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const chunkType = buf.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crcEnd = dataEnd + 4;
    if (length > 0x7fffffff || crcEnd > buf.length) return null;

    if (chunkType === 'IHDR') {
      if (length < 13) return null;
      width = buf.readUInt32BE(dataStart);
      height = buf.readUInt32BE(dataStart + 4);
      bitDepth = buf[dataStart + 8];
      colorType = buf[dataStart + 9];
      const compression = buf[dataStart + 10];
      const filterMethod = buf[dataStart + 11];
      interlace = buf[dataStart + 12];
      if (compression !== 0 || filterMethod !== 0) return null;
      hasIhdr = true;
    } else if (chunkType === 'IDAT') {
      idatChunks.push(buf.subarray(dataStart, dataEnd));
    } else if (chunkType === 'IEND') {
      break;
    }

    offset = crcEnd;
  }

  if (!hasIhdr || width <= 0 || height <= 0 || idatChunks.length === 0) return null;
  if (bitDepth !== 8 || interlace !== 0) return null;

  let bpp: number;
  switch (colorType) {
    case 0:
      bpp = 1;
      break;
    case 2:
      bpp = 3;
      break;
    case 4:
      bpp = 2;
      break;
    case 6:
      bpp = 4;
      break;
    default:
      return null;
  }

  let raw: Buffer;
  try {
    raw = zlib.inflateSync(Buffer.concat(idatChunks));
  } catch {
    return null;
  }

  const stride = width * bpp;
  const expectedLen = (stride + 1) * height;
  if (raw.length < expectedLen) return null;

  const recon = new Uint8Array(height * stride);
  const rgba = new Uint8Array(width * height * 4);

  for (let y = 0; y < height; y++) {
    const rowInStart = y * (stride + 1);
    const filterType = raw[rowInStart];
    const scanStart = rowInStart + 1;
    const rowOutStart = y * stride;
    const prevRowStart = (y - 1) * stride;

    for (let x = 0; x < stride; x++) {
      const filt = raw[scanStart + x];
      const left = x >= bpp ? recon[rowOutStart + x - bpp] : 0;
      const up = y > 0 ? recon[prevRowStart + x] : 0;
      const upLeft = y > 0 && x >= bpp ? recon[prevRowStart + x - bpp] : 0;

      let val: number;
      switch (filterType) {
        case 0:
          val = filt;
          break;
        case 1:
          val = (filt + left) & 0xff;
          break;
        case 2:
          val = (filt + up) & 0xff;
          break;
        case 3:
          val = (filt + ((left + up) >> 1)) & 0xff;
          break;
        case 4:
          val = (filt + paethPredictor(left, up, upLeft)) & 0xff;
          break;
        default:
          return null;
      }
      recon[rowOutStart + x] = val;
    }

    for (let px = 0; px < width; px++) {
      const dst = (y * width + px) * 4;
      const src = rowOutStart + px * bpp;
      if (colorType === 6) {
        rgba[dst] = recon[src];
        rgba[dst + 1] = recon[src + 1];
        rgba[dst + 2] = recon[src + 2];
        rgba[dst + 3] = recon[src + 3];
      } else if (colorType === 2) {
        rgba[dst] = recon[src];
        rgba[dst + 1] = recon[src + 1];
        rgba[dst + 2] = recon[src + 2];
        rgba[dst + 3] = 255;
      } else if (colorType === 4) {
        const g = recon[src];
        rgba[dst] = g;
        rgba[dst + 1] = g;
        rgba[dst + 2] = g;
        rgba[dst + 3] = recon[src + 1];
      } else {
        const g = recon[src];
        rgba[dst] = g;
        rgba[dst + 1] = g;
        rgba[dst + 2] = g;
        rgba[dst + 3] = 255;
      }
    }
  }

  return { width, height, data: rgba };
}

/**
 * Computes mean absolute per-channel RGB difference across two PNG buffers,
 * rounded to 2 decimal places. Returns null if decoding fails or image is empty.
 */
export function computePatchMeanPixelDiff(beforeBuf: Buffer, afterBuf: Buffer): number | null {
  const a = decodePngRgba(beforeBuf);
  const b = decodePngRgba(afterBuf);
  if (!a || !b) return null;
  const minW = Math.min(a.width, b.width);
  const minH = Math.min(a.height, b.height);
  if (minW <= 0 || minH <= 0) return null;

  let sum = 0;
  for (let y = 0; y < minH; y++) {
    for (let x = 0; x < minW; x++) {
      const ia = (y * a.width + x) * 4;
      const ib = (y * b.width + x) * 4;
      sum +=
        Math.abs(a.data[ia] - b.data[ib]) +
        Math.abs(a.data[ia + 1] - b.data[ib + 1]) +
        Math.abs(a.data[ia + 2] - b.data[ib + 2]);
    }
  }

  const mean = sum / (minW * minH * 3);
  return Math.round(mean * 100) / 100;
}

/**
 * Samples a 32x32 uniform grid over the PNG (excluding top takeover bar / outer edges when wide enough),
 * quantizes opaque pixels into 4-bit/channel RGB buckets, and returns up to `topN` distinct dominant `#rrggbb` colors.
 */
export function extractVisualPaletteFromPng(pngBuf: Buffer, topN = 3): string[] {
  const img = decodePngRgba(pngBuf);
  if (!img || img.width <= 0 || img.height <= 0 || topN <= 0) return [];

  const W = img.width;
  const H = img.height;
  const x0 = W >= 64 ? Math.floor(0.04 * W) : 0;
  const x1 = W >= 64 ? Math.min(W - 1, Math.floor(0.96 * W)) : W - 1;
  const y0 = H >= 64 ? Math.floor(0.08 * H) : 0;
  const y1 = H >= 64 ? Math.min(H - 1, Math.floor(0.96 * H)) : H - 1;

  const spanX = Math.max(0, x1 - x0);
  const spanY = Math.max(0, y1 - y0);

  const buckets = new Map<
    number,
    { sumR: number; sumG: number; sumB: number; count: number }
  >();

  const grid = 32;
  for (let gy = 0; gy < grid; gy++) {
    const py = spanY === 0 ? y0 : Math.min(y1, y0 + Math.floor(((gy + 0.5) / grid) * spanY));
    for (let gx = 0; gx < grid; gx++) {
      const px = spanX === 0 ? x0 : Math.min(x1, x0 + Math.floor(((gx + 0.5) / grid) * spanX));
      const idx = (py * W + px) * 4;
      const alpha = img.data[idx + 3];
      if (alpha < 128) continue;
      const r = img.data[idx];
      const g = img.data[idx + 1];
      const b = img.data[idx + 2];
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const cur = buckets.get(key);
      if (cur) {
        cur.sumR += r;
        cur.sumG += g;
        cur.sumB += b;
        cur.count++;
      } else {
        buckets.set(key, { sumR: r, sumG: g, sumB: b, count: 1 });
      }
    }
  }

  if (buckets.size === 0) return [];

  const sorted = [...buckets.values()].sort((a, b) => b.count - a.count);
  const selected: Array<{ r: number; g: number; b: number; hex: string }> = [];

  for (const b of sorted) {
    if (selected.length >= topN) break;
    const r = Math.max(0, Math.min(255, Math.round(b.sumR / b.count)));
    const g = Math.max(0, Math.min(255, Math.round(b.sumG / b.count)));
    const bl = Math.max(0, Math.min(255, Math.round(b.sumB / b.count)));

    const tooClose = selected.some((s) => {
      const dr = r - s.r;
      const dg = g - s.g;
      const db = bl - s.b;
      return Math.sqrt(dr * dr + dg * dg + db * db) < 38;
    });
    if (tooClose) continue;

    const hex =
      '#' +
      r.toString(16).padStart(2, '0') +
      g.toString(16).padStart(2, '0') +
      bl.toString(16).padStart(2, '0');
    selected.push({ r, g, b: bl, hex });
  }

  return selected.map((s) => s.hex);
}

/**
 * Computes average RGB color across opaque pixels of a decoded PNG buffer, returning `#rrggbb` or null.
 */
export function computePngAvgColorHex(pngBuf: Buffer): string | null {
  const img = decodePngRgba(pngBuf);
  if (!img || img.width <= 0 || img.height <= 0) return null;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let count = 0;
  const total = img.width * img.height;
  for (let i = 0; i < total; i++) {
    const idx = i * 4;
    if (img.data[idx + 3] < 128) continue;
    sumR += img.data[idx];
    sumG += img.data[idx + 1];
    sumB += img.data[idx + 2];
    count++;
  }
  if (count === 0) return null;
  const r = Math.max(0, Math.min(255, Math.round(sumR / count)));
  const g = Math.max(0, Math.min(255, Math.round(sumG / count)));
  const b = Math.max(0, Math.min(255, Math.round(sumB / count)));
  return '#' + r.toString(16).padStart(2, '0') + g.toString(16).padStart(2, '0') + b.toString(16).padStart(2, '0');
}

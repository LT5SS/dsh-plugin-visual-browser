export interface DecodedPngRgba {
    width: number;
    height: number;
    data: Uint8Array;
}
/**
 * Pure-Node decoder for standard non-interlaced 8-bit PNG images (colorType 0/2/4/6).
 * Returns null gracefully on malformed buffers or unsupported PNG variants.
 */
export declare function decodePngRgba(buf: Buffer): DecodedPngRgba | null;
/**
 * Computes mean absolute per-channel RGB difference across two PNG buffers,
 * rounded to 2 decimal places. Returns null if decoding fails or image is empty.
 */
export declare function computePatchMeanPixelDiff(beforeBuf: Buffer, afterBuf: Buffer): number | null;
/**
 * Samples a 32x32 uniform grid over the PNG (excluding top takeover bar / outer edges when wide enough),
 * quantizes opaque pixels into 4-bit/channel RGB buckets, and returns up to `topN` distinct dominant `#rrggbb` colors.
 */
export declare function extractVisualPaletteFromPng(pngBuf: Buffer, topN?: number): string[];
/**
 * Computes average RGB color across opaque pixels of a decoded PNG buffer, returning `#rrggbb` or null.
 */
export declare function computePngAvgColorHex(pngBuf: Buffer): string | null;

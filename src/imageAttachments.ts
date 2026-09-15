import { imageSize } from 'image-size';
import type { PromptImage } from './types.ts';

// Conservative client limits, not a guarantee of acceptance by every provider.
export const IMAGE_LIMITS = {
  count: 4,
  bytes: 4 * 1024 * 1024,
  totalBytes: 12 * 1024 * 1024,
  dimension: 8000,
  pixels: 32_000_000,
} as const;

const MIME_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
};

export function isImagePath(name: string): boolean {
  // Recognize unsupported image extensions too, so they fail clearly instead
  // of silently becoming @path text. Actual format is always checked in bytes.
  return /\.(png|jpe?g|gif|webp|svg|bmp|tiff?|ico|avif|heic|heif)$/i.test(name);
}

export function inspectImage(bytes: Uint8Array): { mime: string; width: number; height: number } {
  if (!bytes.length || bytes.length > IMAGE_LIMITS.bytes) {
    throw new Error('Images must be non-empty and at most 4 MiB each. Resize the image and retry.');
  }
  let info;
  try { info = imageSize(bytes); } catch { throw new Error('Invalid image. Use PNG, JPEG, GIF or WebP.'); }
  const mime = info.type && MIME_TYPES[info.type];
  if (!mime) throw new Error('Unsupported image format. Use PNG, JPEG, GIF or WebP.');
  const { width, height } = info;
  if (!width || !height || width > IMAGE_LIMITS.dimension || height > IMAGE_LIMITS.dimension || width * height > IMAGE_LIMITS.pixels) {
    throw new Error('Image exceeds 8000 pixels per side or 32 megapixels. Resize it and retry.');
  }
  return { mime, width, height };
}

/** Treat all webview payloads as untrusted; never log their image data. */
export function validatePromptImages(value: unknown): PromptImage[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > IMAGE_LIMITS.count) {
    throw new Error('Attach at most 4 images per message.');
  }
  let totalBytes = 0;
  return value.map((image: any) => {
    if (!image || typeof image.data !== 'string' || typeof image.mime !== 'string' ||
        image.data.length > 4 * Math.ceil(IMAGE_LIMITS.bytes / 3) ||
        image.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) {
      throw new Error('Invalid image payload: expected raw base64 data.');
    }
    const bytes = Buffer.from(image.data, 'base64');
    if (bytes.toString('base64') !== image.data) throw new Error('Invalid image base64 encoding.');
    const { mime } = inspectImage(bytes);
    if (mime !== image.mime) throw new Error('Image MIME type does not match its contents.');
    totalBytes += bytes.length;
    if (totalBytes > IMAGE_LIMITS.totalBytes) throw new Error('Images must total at most 12 MiB per message.');
    return { data: image.data, mime, name: typeof image.name === 'string' ? image.name.slice(0, 255) : undefined };
  });
}

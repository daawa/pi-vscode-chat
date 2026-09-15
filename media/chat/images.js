// Keep aligned with ../../src/image-attachments.ts; the host revalidates all payloads.
export const IMAGE_LIMITS = { count: 4, bytes: 4 * 1024 * 1024, totalBytes: 12 * 1024 * 1024, dimension: 8000, pixels: 32000000 };
export const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function imagePreview(image, className) {
  const mime = image.mime || image.mimeType;
  if (!IMAGE_MIMES.has(mime) || typeof image.data !== 'string' || image.data.length > 4 * Math.ceil(IMAGE_LIMITS.bytes / 3)) return null;
  const img = document.createElement('img');
  img.className = className;
  img.alt = image.name || 'Attached image';
  img.title = img.alt;
  img.loading = 'lazy';
  img.src = `data:${mime};base64,${image.data}`;
  return img;
}

export function imageBytes(image) {
  return image.data.length * 3 / 4 - (image.data.endsWith('==') ? 2 : image.data.endsWith('=') ? 1 : 0);
}

export function readFile(file, asText = false) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read attachment.'));
    reader.onabort = () => reject(new Error('Attachment read cancelled.'));
    if (asText) reader.readAsText(file);
    else reader.readAsDataURL(file);
  });
}

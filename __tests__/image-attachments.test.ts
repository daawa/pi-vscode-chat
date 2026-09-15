import { describe, expect, test } from 'bun:test';
import { IMAGE_LIMITS, inspectImage, isImagePath, validatePromptImages } from '../src/imageAttachments.ts';
import { GIF, PNG } from './image-fixtures.ts';

const png = Buffer.from(PNG, 'base64');

describe('image validation', () => {
  test.each([{ data: PNG, mime: 'image/png' }, { data: GIF, mime: 'image/gif' }])('sniffs actual raster format: %j', image => {
    expect(inspectImage(Buffer.from(image.data, 'base64'))).toEqual({ mime: image.mime, width: 1, height: 1 });
    expect(validatePromptImages([image])).toEqual([image]);
  });

  test('undefined and empty lists remain valid text-only prompts', () => {
    expect(validatePromptImages(undefined)).toBeUndefined();
    expect(validatePromptImages([])).toEqual([]);
  });

  test.each([
    null, {}, [null], [{ data: PNG, mime: 'image/jpeg' }],
    [{ data: 'data:image/png;base64,' + PNG, mime: 'image/png' }],
    [{ data: PNG + '\n', mime: 'image/png' }], [{ data: '', mime: 'image/png' }],
    [{ data: 'a==b', mime: 'image/png' }], [{ data: 'not base64!', mime: 'image/png' }],
    [{ data: Buffer.from('Not an image').toString('base64'), mime: 'image/png' }],
  ])('rejects untrusted malformed payload %#', value => {
    expect(() => validatePromptImages(value)).toThrow();
  });

  test('rejects vectors even when declared as PNG', () => {
    const svg = Buffer.from('<svg width="1" height="1"></svg>');
    expect(() => inspectImage(svg)).toThrow('Unsupported');
  });

  test('limits dimensions and pixel count without decoding full image memory', () => {
    const wide = Buffer.from(png);
    wide.writeUInt32BE(IMAGE_LIMITS.dimension + 1, 16);
    expect(() => inspectImage(wide)).toThrow('8000');
    const manyPixels = Buffer.from(png);
    manyPixels.writeUInt32BE(6000, 16);
    manyPixels.writeUInt32BE(6000, 20);
    expect(() => inspectImage(manyPixels)).toThrow('megapixels');
  });

  test('bounds per-image bytes, count, and aggregate payload size', () => {
    expect(() => inspectImage(Buffer.alloc(IMAGE_LIMITS.bytes + 1))).toThrow('4 MiB');
    const image = { data: PNG, mime: 'image/png' };
    expect(() => validatePromptImages(Array(5).fill(image))).toThrow('4 images');
    const large = Buffer.alloc(IMAGE_LIMITS.bytes);
    png.copy(large);
    const largeImage = { data: large.toString('base64'), mime: 'image/png' };
    expect(validatePromptImages([largeImage])).toHaveLength(1);
    expect(() => validatePromptImages(Array(4).fill(largeImage))).toThrow('12 MiB');
  });

  test('recognizes supported and unsupported image paths without mistaking source files', () => {
    for (const name of ['a.PNG', 'a.jpeg', 'a.gif', 'a.webp', 'a.svg', 'a.heic', 'a.avif', 'a.bmp']) {
      expect(isImagePath(name)).toBe(true);
    }
    expect(isImagePath('png.ts')).toBe(false);
  });
});

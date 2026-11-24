import { describe, expect, it } from 'vitest';
import { SHRINK_LIMIT, stillImage, willShrink, withMime } from './image-shrink.js';

describe('composer/image-shrink', () => {
  it('identifies decodable still images and excludes GIF and SVG', () => {
    expect(stillImage({ type: 'image/jpeg', name: 'a.jpg' })).toBe(true);
    expect(stillImage({ type: 'image/png', name: 'a.png' })).toBe(true);
    expect(stillImage({ type: 'image/webp', name: 'a.webp' })).toBe(true);
    expect(stillImage({ type: '', name: 'IMG_0001.HEIC' })).toBe(true);
    expect(stillImage({ type: 'image/gif', name: 'anim.gif' })).toBe(false);
    expect(stillImage({ type: 'image/svg+xml', name: 'icon.svg' })).toBe(false);
    expect(stillImage({ type: 'application/pdf', name: 'doc.pdf' })).toBe(false);
  });

  it('only marks still images over SHRINK_LIMIT for compression', () => {
    expect(willShrink({ type: 'image/png', size: SHRINK_LIMIT })).toBe(false);
    expect(willShrink({ type: 'image/png', size: SHRINK_LIMIT + 1 })).toBe(true);
    expect(willShrink({ type: 'image/gif', size: SHRINK_LIMIT + 1000 })).toBe(false);
    expect(willShrink(null)).toBe(false);
  });

  it('rewrites known image extensions to match encoded MIME without stripping non-image dots', () => {
    expect(withMime('IMG_0001.HEIC', 'image/jpeg')).toBe('IMG_0001.jpg');
    expect(withMime('shot.png', 'image/webp')).toBe('shot.webp');
    expect(withMime('2026.11 photo', 'image/jpeg')).toBe('2026.11 photo.jpg');
    expect(withMime(undefined, 'image/webp')).toBe('image.webp');
  });
});

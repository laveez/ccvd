import { blankImage, type RgbaImage } from './png.ts';

export interface DiffResult {
  image: RgbaImage;
  changed: number;
  total: number;
}

const FADE = 0.25;
const RED = [255, 0, 0, 255] as const;
const faded = Uint8Array.from({ length: 256 }, (_, channel) => Math.round(255 - (255 - channel) * FADE));

export function diffImages(before: RgbaImage, after: RgbaImage): DiffResult {
  if (before.width === after.width && before.height === after.height) return diffSameSize(before, after);
  const width = Math.max(before.width, after.width);
  const height = Math.max(before.height, after.height);
  const image = blankImage(width, height);
  let changed = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const out = (y * width + x) * 4;
      const inBefore = x < before.width && y < before.height;
      const inAfter = x < after.width && y < after.height;
      const a = (y * before.width + x) * 4;
      const b = (y * after.width + x) * 4;
      if (inBefore && inAfter && samePixel(before.data, a, after.data, b)) {
        image.data[out] = faded[before.data[a]];
        image.data[out + 1] = faded[before.data[a + 1]];
        image.data[out + 2] = faded[before.data[a + 2]];
        image.data[out + 3] = 255;
      } else {
        image.data.set(RED, out);
        changed++;
      }
    }
  }
  return { image, changed, total: width * height };
}

function diffSameSize(before: RgbaImage, after: RgbaImage): DiffResult {
  const { width, height } = before;
  const image = blankImage(width, height);
  const a = before.data;
  const b = after.data;
  const out = image.data;
  let changed = 0;
  for (let i = 0; i < out.length; i += 4) {
    if (a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2] && a[i + 3] === b[i + 3]) {
      out[i] = faded[a[i]];
      out[i + 1] = faded[a[i + 1]];
      out[i + 2] = faded[a[i + 2]];
      out[i + 3] = 255;
    } else {
      out[i] = 255;
      out[i + 3] = 255;
      changed++;
    }
  }
  return { image, changed, total: width * height };
}

function samePixel(a: Uint8Array, i: number, b: Uint8Array, j: number): boolean {
  return a[i] === b[j] && a[i + 1] === b[j + 1] && a[i + 2] === b[j + 2] && a[i + 3] === b[j + 3];
}

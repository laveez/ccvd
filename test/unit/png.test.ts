import assert from 'node:assert/strict';
import { test } from 'node:test';
import zlib from 'node:zlib';
import { blankImage, blit, decodePng, encodePng, type RgbaImage } from '../../src/png.ts';

function pattern(width: number, height: number, alpha: (x: number, y: number) => number = () => 255): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = (x * 37 + y * 11) & 255;
      data[i + 1] = (x * 5 + y * 71) & 255;
      data[i + 2] = (x * y * 3) & 255;
      data[i + 3] = alpha(x, y);
    }
  }
  return { width, height, data };
}

function chunk(type: string, body: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

function header(width: number, height: number, bitDepth: number, colorType: number, interlace = 0): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[12] = interlace;
  return ihdr;
}

function png(ihdr: Buffer, raw: Uint8Array): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', new Uint8Array()),
  ]);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// Writes each row with filter `y % 5`, so one image exercises all five PNG filter types.
function encodeWithEveryFilter(image: RgbaImage): Buffer {
  const stride = image.width * 4;
  const raw = new Uint8Array((stride + 1) * image.height);
  for (let y = 0; y < image.height; y++) {
    const filter = y % 5;
    raw[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x++) {
      const value = image.data[y * stride + x];
      const a = x >= 4 ? image.data[y * stride + x - 4] : 0;
      const b = y > 0 ? image.data[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y > 0 ? image.data[(y - 1) * stride + x - 4] : 0;
      const predictor = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter];
      raw[y * (stride + 1) + 1 + x] = (value - predictor) & 255;
    }
  }
  return png(header(image.width, image.height, 8, 6), raw);
}

test('round trips an image with transparency', () => {
  const image = pattern(13, 7, (x, y) => (x + y) * 9);
  const decoded = decodePng(encodePng(image));
  assert.equal(decoded.width, 13);
  assert.equal(decoded.height, 7);
  assert.deepEqual(decoded.data, image.data);
});

test('writes an opaque image as RGB and reads it back as RGBA', () => {
  const image = pattern(9, 4);
  const bytes = encodePng(image);
  assert.equal(bytes[25], 2, 'IHDR colour type');
  assert.deepEqual(decodePng(bytes).data, image.data);
});

test('decodes rows written with every filter type', () => {
  const image = pattern(11, 10, (x, y) => 255 - x * y);
  assert.deepEqual(decodePng(encodeWithEveryFilter(image)).data, image.data);
});

test('rejects PNGs it cannot read', () => {
  assert.throws(() => decodePng(Buffer.from('not a png')), /Not a PNG file/);
  assert.throws(() => decodePng(png(header(1, 1, 16, 6), new Uint8Array(9))), /bit depth 16/);
  assert.throws(() => decodePng(png(header(1, 1, 8, 3), new Uint8Array(2))), /color type 3/);
  assert.throws(() => decodePng(png(header(1, 1, 8, 6, 1), new Uint8Array(5))), /interlace/);
  assert.throws(() => decodePng(png(header(2, 2, 8, 6), new Uint8Array(9))), /truncated/);
});

test('blit copies a source into a target and clips at the edges', () => {
  const target = blankImage(3, 3, [0, 0, 0, 255]);
  const source = blankImage(2, 2, [255, 0, 0, 255]);
  blit(target, source, 2, -1);
  const red = (x: number, y: number) => target.data[(y * 3 + x) * 4] === 255;
  assert.deepEqual(
    [0, 1, 2].map(y => [0, 1, 2].map(x => red(x, y))),
    [
      [false, false, true],
      [false, false, false],
      [false, false, false],
    ],
  );
});

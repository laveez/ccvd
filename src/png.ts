import zlib from 'node:zlib';

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export type Rgba = readonly [number, number, number, number];

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const COLOR_RGB = 2;
const COLOR_RGBA = 6;
const FILTER_UP = 2;

export function blankImage(width: number, height: number, fill: Rgba = [0, 0, 0, 0]): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  if (fill.some(channel => channel !== 0)) {
    for (let i = 0; i < data.length; i += 4) data.set(fill, i);
  }
  return { width, height, data };
}

export function blit(target: RgbaImage, source: RgbaImage, left: number, top: number): void {
  const x0 = Math.max(0, left);
  const x1 = Math.min(target.width, left + source.width);
  if (x1 <= x0) return;
  for (let y = Math.max(0, top); y < Math.min(target.height, top + source.height); y++) {
    const from = ((y - top) * source.width + (x0 - left)) * 4;
    target.data.set(source.data.subarray(from, from + (x1 - x0) * 4), (y * target.width + x0) * 4);
  }
}

export function decodePng(bytes: Uint8Array): RgbaImage {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('Not a PNG file');

  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  for (let offset = 8; offset + 8 <= buffer.length; ) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      ({ width, height, channels } = readHeader(body));
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (channels === 0) throw new Error('PNG has no IHDR chunk');

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error('PNG image data is truncated');
  const pixels = unfilter(raw, stride, height, channels);
  return { width, height, data: channels === 4 ? pixels : rgbToRgba(pixels) };
}

export function encodePng(image: RgbaImage, options: { level?: number } = {}): Buffer {
  const { width, height, data } = image;
  const channels = isOpaque(data) ? 3 : 4;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  const row = new Uint8Array(stride);
  const previous = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    readRow(data, y * width * 4, width, channels, row);
    const start = y * (stride + 1);
    raw[start] = FILTER_UP;
    for (let x = 0; x < stride; x++) raw[start + 1 + x] = row[x] - previous[x];
    previous.set(row);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? COLOR_RGBA : COLOR_RGB;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: options.level ?? 1 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function readHeader(body: Buffer): { width: number; height: number; channels: number } {
  const [bitDepth, colorType, , , interlace] = body.subarray(8, 13);
  if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth ${bitDepth}: only 8 is supported`);
  if (colorType !== COLOR_RGB && colorType !== COLOR_RGBA) {
    throw new Error(`Unsupported PNG color type ${colorType}: only RGB (2) and RGBA (6) are supported`);
  }
  if (interlace !== 0) throw new Error('Unsupported PNG interlace method: only non-interlaced images are supported');
  return { width: body.readUInt32BE(0), height: body.readUInt32BE(4), channels: colorType === COLOR_RGBA ? 4 : 3 };
}

function unfilter(raw: Uint8Array, stride: number, height: number, bpp: number): Uint8Array {
  const out = new Uint8Array(stride * height);
  const zeros = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const current = out.subarray(y * stride, (y + 1) * stride);
    const above = y > 0 ? out.subarray((y - 1) * stride, y * stride) : zeros;
    switch (filter) {
      case 0:
        current.set(line);
        break;
      case 1:
        for (let x = 0; x < stride; x++) current[x] = line[x] + (x >= bpp ? current[x - bpp] : 0);
        break;
      case 2:
        for (let x = 0; x < stride; x++) current[x] = line[x] + above[x];
        break;
      case 3:
        for (let x = 0; x < stride; x++) current[x] = line[x] + (((x >= bpp ? current[x - bpp] : 0) + above[x]) >> 1);
        break;
      case 4:
        for (let x = 0; x < stride; x++) {
          const left = x >= bpp ? current[x - bpp] : 0;
          const upperLeft = x >= bpp ? above[x - bpp] : 0;
          current[x] = line[x] + paeth(left, above[x], upperLeft);
        }
        break;
      default:
        throw new Error(`Invalid PNG filter type ${filter} in row ${y}`);
    }
  }
  return out;
}

function paeth(left: number, above: number, upperLeft: number): number {
  const estimate = left + above - upperLeft;
  const toLeft = Math.abs(estimate - left);
  const toAbove = Math.abs(estimate - above);
  const toUpperLeft = Math.abs(estimate - upperLeft);
  if (toLeft <= toAbove && toLeft <= toUpperLeft) return left;
  return toAbove <= toUpperLeft ? above : upperLeft;
}

function rgbToRgba(rgb: Uint8Array): Uint8Array {
  const rgba = new Uint8Array((rgb.length / 3) * 4);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    rgba[j] = rgb[i];
    rgba[j + 1] = rgb[i + 1];
    rgba[j + 2] = rgb[i + 2];
    rgba[j + 3] = 255;
  }
  return rgba;
}

function isOpaque(rgba: Uint8Array): boolean {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) return false;
  return true;
}

function readRow(rgba: Uint8Array, start: number, width: number, channels: number, row: Uint8Array): void {
  if (channels === 4) {
    row.set(rgba.subarray(start, start + width * 4));
    return;
  }
  for (let x = 0; x < width; x++) {
    row[x * 3] = rgba[start + x * 4];
    row[x * 3 + 1] = rgba[start + x * 4 + 1];
    row[x * 3 + 2] = rgba[start + x * 4 + 2];
  }
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body, zlib.crc32(head.subarray(4))), 0);
  return Buffer.concat([head, body, crc]);
}

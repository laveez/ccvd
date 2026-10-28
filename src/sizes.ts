export interface Size {
  width: number;
  height: number;
  dpr: 1 | 2;
}

export const PRESETS = [
  { id: 'desktop', label: 'Desktop', width: 1920, height: 1080 },
  { id: 'laptop', label: 'Laptop', width: 1440, height: 900 },
  { id: 'small', label: 'Small laptop', width: 1280, height: 800 },
  { id: 'tablet', label: 'Tablet', width: 768, height: 1024 },
  { id: 'phone', label: 'Phone', width: 440, height: 956 },
  { id: 'phone-small', label: 'Small phone', width: 390, height: 844 },
] as const;

export const MIN_SIDE = 100;
export const MAX_SIDE = 8000;

const SIZE = /^(?:(?<preset>[a-z-]+)|(?<width>\d+)x(?<height>\d+))(?:@(?<dpr>\d+)x?)?$/i;

export function parseSize(spec: string): Size {
  const match = SIZE.exec(spec.trim());
  if (!match?.groups) throw new Error(`Not a size: ${spec} (use a preset such as desktop, or WIDTHxHEIGHT)`);
  const { preset, width, height, dpr } = match.groups;
  const scale = dpr === undefined ? 1 : Number(dpr);
  if (scale !== 1 && scale !== 2) throw new Error(`Unsupported pixel ratio @${dpr}: use @1 or @2`);
  if (preset !== undefined) {
    const found = PRESETS.find(p => p.id === preset.toLowerCase());
    if (!found) throw new Error(`Unknown size preset: ${preset} (presets: ${PRESETS.map(p => p.id).join(', ')})`);
    return { width: found.width, height: found.height, dpr: scale };
  }
  return checked({ width: Number(width), height: Number(height), dpr: scale });
}

export function checked(size: Size): Size {
  for (const side of [size.width, size.height]) {
    if (!Number.isInteger(side) || side < MIN_SIDE || side > MAX_SIDE) {
      throw new Error(
        `Size ${size.width}x${size.height} is out of range: each side must be ${MIN_SIDE} to ${MAX_SIDE}`,
      );
    }
  }
  return size;
}

export function sizeLabel(size: Size): string {
  return `${size.width}x${size.height}${size.dpr === 2 ? '@2x' : ''}`;
}

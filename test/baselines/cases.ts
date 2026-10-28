// Calibration baselines: before and after pages with a known diff, shared by `npm run baselines`, which
// draws their reference images, and test/e2e/baselines.test.ts, which checks ccvd against them.
import type { ShotOptions } from '../../src/shot.ts';
import type { Size } from '../../src/sizes.ts';

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Baseline {
  name: string;
  title: string;
  // Exact changed pixels, the same on every machine. Cases where changed text sets the count leave it out,
  // since fonts draw differently from machine to machine.
  changed?: number;
  // Every changed pixel lies inside this region.
  within?: Region;
  // The first and last rows that hold a changed pixel.
  rows?: [number, number];
}

export const BASELINE_SIZE: Size = { width: 480, height: 300, dpr: 1 };

export const BASELINES: Baseline[] = [
  { name: 'identical', title: 'Nothing changes', changed: 0 },
  {
    name: 'one-pixel',
    title: 'One pixel turns one shade bluer',
    changed: 1,
    within: { x: 300, y: 260, width: 1, height: 1 },
  },
  {
    name: 'color-block',
    title: 'A 200×100 box changes colour',
    changed: 20_000,
    within: { x: 140, y: 140, width: 200, height: 100 },
  },
  {
    name: 'moved-block',
    title: 'The box moves 10 px to the right',
    changed: 2_000,
    within: { x: 140, y: 140, width: 210, height: 100 },
  },
  { name: 'text', title: 'One word changes', within: { x: 90, y: 56, width: 160, height: 32 } },
  { name: 'layout-shift', title: 'A banner pushes the content down', rows: [40, 339] },
  { name: 'taller', title: 'The after page is 60 px taller', changed: 28_800, rows: [300, 359] },
];

export function baselineShot(site: URL, baseline: Baseline, out: string): ShotOptions {
  return {
    before: new URL(`${baseline.name}/before.html`, site),
    after: new URL(`${baseline.name}/after.html`, site),
    paths: [''],
    sizes: [BASELINE_SIZE],
    fullPage: true,
    out,
    wait: 0,
    reducedMotion: true,
  };
}

export function expectation({ changed, within, rows }: Baseline): string {
  const parts = [
    changed === undefined
      ? 'some changed pixels'
      : `exactly ${changed.toLocaleString('en-US')} changed pixel${changed === 1 ? '' : 's'}`,
  ];
  if (within) parts.push(`all inside x ${span(within.x, within.width)}, y ${span(within.y, within.height)}`);
  if (rows) parts.push(`on rows ${rows[0]}–${rows[1]}`);
  return parts.join(', ');
}

function span(start: number, length: number): string {
  return length === 1 ? String(start) : `${start}–${start + length - 1}`;
}

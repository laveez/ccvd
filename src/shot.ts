import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Browser } from 'playwright-core';
import type { ShotCommand } from './cli.ts';
import { composeImage, diffDetail, type Panel } from './compose.ts';
import { diffImages } from './diff.ts';
import { decodePng, encodePng, type RgbaImage } from './png.ts';
import { Side } from './side.ts';
import { type Size, sizeLabel } from './sizes.ts';
import { displayPath, mapUrl, pathSlug, resolvePath } from './urls.ts';

export type ShotOptions = Omit<ShotCommand, 'kind' | 'json' | 'browser'>;

export interface PageResult {
  url: string;
  status: number | null;
  error: string | null;
}

export interface ShotResult {
  path: string;
  size: Size;
  before: PageResult;
  after: PageResult;
  changed: number;
  total: number;
  files: { before: string; after: string; diff: string; pair: string; triple: string };
}

export async function runShots(browser: Browser, options: ShotOptions): Promise<ShotResult[]> {
  await mkdir(options.out, { recursive: true });
  const results: ShotResult[] = [];
  const names = new Set<string>();
  for (const size of options.sizes) {
    const [before, after] = await Promise.all([
      Side.open(browser, 'before', options.before, size, options.reducedMotion),
      Side.open(browser, 'after', options.after, size, options.reducedMotion),
    ]);
    try {
      for (const pagePath of options.paths) {
        const beforeUrl = resolvePath(options.before, pagePath);
        const afterUrl = mapUrl(beforeUrl.href, options.before, options.after);
        await Promise.all([before.goto(beforeUrl.href), after.goto(afterUrl)]);
        await Promise.all([
          before.prepareForCapture(options.fullPage, options.wait),
          after.prepareForCapture(options.fullPage, options.wait),
        ]);
        const [beforeImage, afterImage] = await Promise.all([
          capture(before, options.fullPage),
          capture(after, options.fullPage),
        ]);
        const name = uniqueName(`${pathSlug(beforeUrl, options.before)}-${sizeLabel(size)}`, names);
        results.push(
          await save(browser, options.out, name, {
            path: displayPath(beforeUrl),
            size,
            before: [before, beforeImage],
            after: [after, afterImage],
          }),
        );
      }
    } finally {
      await Promise.all([before.close(), after.close()]);
    }
  }
  return results;
}

interface Captured {
  path: string;
  size: Size;
  before: [Side, RgbaImage];
  after: [Side, RgbaImage];
}

async function save(browser: Browser, out: string, name: string, captured: Captured): Promise<ShotResult> {
  const [beforeSide, beforeImage] = captured.before;
  const [afterSide, afterImage] = captured.after;
  const diff = diffImages(beforeImage, afterImage);
  const file = (kind: string) => path.resolve(out, `${name}-${kind}.png`);
  const panels: Record<'before' | 'diff' | 'after', Panel> = {
    before: { label: 'Before', detail: beforeSide.state.path, image: beforeImage },
    diff: {
      label: 'Diff',
      detail: diffDetail(diff.changed, diff.total),
      image: diff.image,
      tone: diff.changed > 0 ? 'changed' : 'unchanged',
    },
    after: { label: 'After', detail: afterSide.state.path, image: afterImage },
  };
  const files = {
    before: file('before'),
    after: file('after'),
    diff: file('diff'),
    pair: file('pair'),
    triple: file('triple'),
  };
  await Promise.all([
    writeFile(files.before, encodePng(beforeImage, { level: 6 })),
    writeFile(files.after, encodePng(afterImage, { level: 6 })),
    writeFile(files.diff, encodePng(diff.image, { level: 6 })),
  ]);
  await writeFile(files.pair, await composeImage(browser, [panels.before, panels.after], captured.size.dpr));
  await writeFile(
    files.triple,
    await composeImage(browser, [panels.before, panels.diff, panels.after], captured.size.dpr),
  );
  return {
    path: captured.path,
    size: captured.size,
    before: pageResult(beforeSide),
    after: pageResult(afterSide),
    changed: diff.changed,
    total: diff.total,
    files,
  };
}

async function capture(side: Side, fullPage: boolean): Promise<RgbaImage> {
  return fullPage ? side.captureFullPage() : decodePng(await side.capturePng());
}

function pageResult(side: Side): PageResult {
  return { url: side.state.url, status: side.state.status ?? null, error: side.state.error ?? null };
}

function uniqueName(name: string, taken: Set<string>): string {
  let candidate = name;
  for (let index = 2; taken.has(candidate); index++) candidate = `${name}-${index}`;
  taken.add(candidate);
  return candidate;
}

export function formatResults(results: ShotResult[], out: string): string {
  const rows = results.map(result => {
    const problems = [result.before, result.after]
      .map((page, index) => {
        const label = index === 0 ? 'before' : 'after';
        if (page.error) return `${label}: ${page.error}`;
        if (page.status !== null && page.status >= 400) return `${label}: HTTP ${page.status}`;
        return '';
      })
      .filter(Boolean);
    return [result.path || '/', sizeLabel(result.size), diffDetail(result.changed, result.total), problems.join('; ')];
  });
  const widths = [0, 1].map(column => Math.max(...rows.map(row => row[column].length)));
  const lines = rows.map(row =>
    `  ${row[0].padEnd(widths[0])}  ${row[1].padEnd(widths[1])}  ${row[2]}${row[3] ? `  (${row[3]})` : ''}`.trimEnd(),
  );
  return [
    `ccvd shot: ${results.length} comparison${results.length === 1 ? '' : 's'} saved to ${path.resolve(out)}`,
    ...lines,
    '',
    `Each comparison has -before, -after, -diff, -pair and -triple PNGs in ${path.resolve(out)}.`,
  ].join('\n');
}

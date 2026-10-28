import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Browser } from 'playwright-core';
import { launchBrowser } from '../../src/browser.ts';
import { MAX_FULL_PAGE_CSS_PX } from '../../src/page-script.ts';
import { decodePng } from '../../src/png.ts';
import { runShots, type ShotOptions } from '../../src/shot.ts';
import { type StaticServer, serveDirectory } from '../../src/static-server.ts';

const demo = new URL('../../examples/demo/', import.meta.url);
let browser: Browser;
let beforeSite: StaticServer;
let afterSite: StaticServer;
let tallSite: StaticServer;
let out: string;

before(async () => {
  browser = await launchBrowser();
  beforeSite = await serveDirectory(fileURLToPath(new URL('before', demo)));
  afterSite = await serveDirectory(fileURLToPath(new URL('after', demo)));
  out = await mkdtemp(path.join(os.tmpdir(), 'ccvd-shot-'));
  const tall = path.join(out, 'tall');
  await mkdir(tall);
  const bands = Array.from(
    { length: 90 },
    (_, i) => `<div style="height:200px;background:rgb(${i * 2},90,160)"></div>`,
  );
  await writeFile(path.join(tall, 'index.html'), `<!doctype html><body style="margin:0">${bands.join('')}</body>`);
  tallSite = await serveDirectory(tall);
});

after(async () => {
  await browser?.close();
  await Promise.all([beforeSite?.close(), afterSite?.close(), tallSite?.close()]);
  await rm(out, { recursive: true, force: true });
});

const options = (overrides: Partial<ShotOptions>): ShotOptions => ({
  before: beforeSite.url,
  after: afterSite.url,
  paths: [''],
  sizes: [{ width: 800, height: 600, dpr: 1 }],
  fullPage: true,
  out,
  wait: 0,
  reducedMotion: false,
  ...overrides,
});

test('saves full-page before, after, diff and composites for each path', { timeout: 60_000 }, async () => {
  const results = await runShots(browser, options({ paths: ['', 'pricing.html'] }));
  assert.equal(results.length, 2);
  for (const result of results) {
    assert.ok(result.changed > 0, `${result.path} should differ`);
    assert.equal(result.before.status, 200);
    assert.equal(result.after.status, 200);
    const beforeImage = decodePng(await readFile(result.files.before));
    assert.equal(beforeImage.width, 800);
    assert.ok(beforeImage.height > 600, 'full page is taller than the viewport');
    const triple = decodePng(await readFile(result.files.triple));
    assert.ok(triple.width > 3 * 800, 'triple holds three panels');
  }
  assert.deepEqual(
    results.map(result => path.basename(result.files.diff)),
    ['index-800x600-diff.png', 'pricing-800x600-diff.png'],
  );
});

test('a side compared with itself has no changed pixels', { timeout: 60_000 }, async () => {
  const [result] = await runShots(browser, options({ after: beforeSite.url, fullPage: false }));
  assert.equal(result.changed, 0);
  assert.equal(decodePng(await readFile(result.files.before)).height, 600);
});

test('tall pages are stitched from slices and stop at 16,384 px', { timeout: 60_000 }, async () => {
  const [result] = await runShots(
    browser,
    options({ before: tallSite.url, after: tallSite.url, sizes: [{ width: 300, height: 1000, dpr: 1 }] }),
  );
  const image = decodePng(await readFile(result.files.before));
  assert.equal(image.height, MAX_FULL_PAGE_CSS_PX);
  const pixel = (y: number) => Array.from(image.data.subarray(y * image.width * 4, y * image.width * 4 + 3));
  assert.deepEqual(pixel(40 * 200 + 100), [80, 90, 160], 'band 40, just past the first 8192 px slice');
  assert.deepEqual(pixel(81 * 200 + 100), [162, 90, 160], 'band 81, near the bottom of the capture');
  assert.equal(result.changed, 0);
});

test('a page that does not load is reported, not thrown', { timeout: 60_000 }, async () => {
  const [result] = await runShots(browser, options({ paths: ['missing.html'], fullPage: false }));
  assert.equal(result.before.status, 404);
  assert.equal(result.after.status, 404);
});

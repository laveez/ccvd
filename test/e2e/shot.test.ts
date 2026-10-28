import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { Browser } from 'playwright-core';
import { launchBrowser } from '../../src/browser.ts';
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
  beforeSite = await serveDirectory(new URL('before', demo).pathname);
  afterSite = await serveDirectory(new URL('after', demo).pathname);
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

test('pages taller than the capture limit are stitched without wrapping', { timeout: 60_000 }, async () => {
  const [result] = await runShots(
    browser,
    options({ before: tallSite.url, after: tallSite.url, sizes: [{ width: 300, height: 1000, dpr: 1 }] }),
  );
  const image = decodePng(await readFile(result.files.before));
  assert.equal(image.height, 90 * 200);
  const pixel = (y: number) => Array.from(image.data.subarray(y * image.width * 4, y * image.width * 4 + 3));
  assert.deepEqual(pixel(89 * 200 + 100), [178, 90, 160]);
  assert.equal(result.changed, 0);
});

test('a page that does not load is reported, not thrown', { timeout: 60_000 }, async () => {
  const [result] = await runShots(browser, options({ paths: ['missing.html'], fullPage: false }));
  assert.equal(result.before.status, 404);
  assert.equal(result.after.status, 404);
});

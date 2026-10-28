import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Browser } from 'playwright-core';
import { launchBrowser } from '../../src/browser.ts';
import { decodePng, type RgbaImage } from '../../src/png.ts';
import { runShots } from '../../src/shot.ts';
import { type StaticServer, serveDirectory } from '../../src/static-server.ts';
import { BASELINES, baselineShot } from '../baselines/cases.ts';

const root = new URL('../baselines/', import.meta.url);
let browser: Browser;
let site: StaticServer;
let out: string;

before(async () => {
  browser = await launchBrowser();
  site = await serveDirectory(fileURLToPath(root));
  out = await mkdtemp(path.join(os.tmpdir(), 'ccvd-baselines-'));
});

after(async () => {
  await browser?.close();
  await site?.close();
  await rm(out, { recursive: true, force: true });
});

// Changed pixels are pure red in a diff image, which no faded unchanged pixel can be. Indexes come in
// reading order, so the first and last give the first and last changed rows.
function redPixels(image: RgbaImage): number[] {
  const red: number[] = [];
  for (let i = 0; i < image.data.length; i += 4) {
    if (image.data[i] === 255 && image.data[i + 1] === 0 && image.data[i + 2] === 0) red.push(i / 4);
  }
  return red;
}

for (const baseline of BASELINES) {
  test(`baseline ${baseline.name}: ${baseline.title}`, { timeout: 60_000 }, async () => {
    const [result] = await runShots(browser, baselineShot(site.url, baseline, path.join(out, baseline.name)));
    const diff = decodePng(await readFile(result.files.diff));
    const red = redPixels(diff);
    assert.equal(red.length, result.changed, 'the diff image marks every changed pixel red');

    if (baseline.changed === undefined) {
      assert.ok(result.changed > 0, 'the pages differ');
    } else {
      assert.equal(result.changed, baseline.changed);
      const committed = decodePng(await readFile(new URL(`${baseline.name}/diff.png`, root)));
      const expected = redPixels(committed);
      const same =
        committed.width === diff.width &&
        committed.height === diff.height &&
        expected.length === red.length &&
        expected.every((index, i) => index === red[i]);
      assert.ok(same, `the red pixels match ${baseline.name}/diff.png (${red.length} here, ${expected.length} there)`);
    }

    const { within, rows } = baseline;
    if (within) {
      const outside = red.filter(index => {
        const x = index % diff.width;
        const y = Math.floor(index / diff.width);
        return x < within.x || x >= within.x + within.width || y < within.y || y >= within.y + within.height;
      });
      assert.equal(outside.length, 0, `${outside.length} changed pixels outside the expected region`);
    }
    if (rows) {
      const row = (index: number | undefined) => Math.floor((index ?? Number.NaN) / diff.width);
      assert.deepEqual([row(red[0]), row(red.at(-1))], rows);
    }
  });
}

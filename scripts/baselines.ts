#!/usr/bin/env node
// Redraws the calibration baselines' images and their README with ccvd shot's capture path: npm run baselines
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../src/browser.ts';
import { runShots } from '../src/shot.ts';
import { serveDirectory } from '../src/static-server.ts';
import { BASELINE_SIZE, BASELINES, baselineShot, expectation } from '../test/baselines/cases.ts';

const PLATFORMS: Record<string, string> = { linux: 'Linux', darwin: 'macOS', win32: 'Windows' };

const root = fileURLToPath(new URL('../test/baselines/', import.meta.url));
const browser = await launchBrowser();
const site = await serveDirectory(root);
const out = await mkdtemp(path.join(os.tmpdir(), 'ccvd-baselines-'));
try {
  const rows: string[] = [];
  for (const baseline of BASELINES) {
    const [result] = await runShots(browser, baselineShot(site.url, baseline, path.join(out, baseline.name)));
    for (const kind of ['before', 'after', 'diff'] as const) {
      await copyFile(result.files[kind], path.join(root, baseline.name, `${kind}.png`));
    }
    const image = (kind: string) => `![${baseline.title}, ${kind}](${baseline.name}/${kind}.png)`;
    rows.push(
      `| [${baseline.title}](${baseline.name}/) | ${expectation(baseline)} | ${image('before')} | ${image('diff')} | ${image('after')} |`,
    );
    console.log(`${baseline.name}: ${result.changed} changed pixels`);
  }
  await writeFile(path.join(root, 'README.md'), readme(rows, browser.version()));
  console.log('test/baselines/README.md');
} finally {
  await rm(out, { recursive: true, force: true });
  await site.close();
  await browser.close();
}

function readme(rows: string[], version: string): string {
  return `# Calibration baselines

Before and after pages with a known diff, from one changed pixel to a layout shift. Each folder holds the two pages and the before, diff and after images ccvd made of them, and \`test/e2e/baselines.test.ts\` checks every case on each test run.

Shapes draw the same on every machine, so their cases have exact counts, and the tests also check that the same pixels are red as in the diff here. Text draws a little differently from machine to machine (fonts, GPU or CPU drawing), so the case where text changes is checked by where its red is.

| Case | Expected | Before | Diff | After |
|---|---|---|---|---|
${rows.join('\n')}

Drawn by \`npm run baselines\` at ${BASELINE_SIZE.width}×${BASELINE_SIZE.height}, full page, with Chromium ${version} on ${PLATFORMS[process.platform] ?? process.platform}. Run it again after a change to capturing or to the diff image, and look at every image before committing them.
`;
}

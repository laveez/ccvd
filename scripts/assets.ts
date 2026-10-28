#!/usr/bin/env node
// Regenerates the README images and the plugin icon from the demo site: npm run assets
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { launchBrowser } from '../src/browser.ts';
import { startServer } from '../src/server.ts';
import { Session } from '../src/session.ts';
import { runShots } from '../src/shot.ts';
import { serveDirectory } from '../src/static-server.ts';

const root = new URL('../', import.meta.url);
const file = (relative: string) => new URL(relative, root).pathname;

const browser = await launchBrowser();
const sites = await Promise.all(['before', 'after'].map(side => serveDirectory(file(`examples/demo/${side}`))));
try {
  await captureView(browser);
  await captureTriple(browser);
  await renderIcon(browser);
} finally {
  await Promise.all(sites.map(site => site.close()));
  await browser.close();
}

async function captureView(browser: Browser): Promise<void> {
  const session = await Session.create(browser, {
    before: sites[0].url,
    after: sites[1].url,
    size: { width: 1280, height: 800, dpr: 1 },
    fit: true,
    reducedMotion: false,
  });
  const server = await startServer({ session, browser, port: 0 });
  const context = await browser.newContext({ viewport: { width: 1800, height: 960 }, colorScheme: 'dark' });
  try {
    const page = await context.newPage();
    await page.goto(server.url);
    await settled(page);
    await page.screenshot({ path: file('docs/live-view.png') });
    console.log('docs/live-view.png');
  } finally {
    await context.close();
    await server.close();
    await session.close();
  }
}

async function settled(page: Page): Promise<void> {
  await page.waitForTimeout(800);
  await page.waitForFunction(`(() => {
    const diff = document.querySelector('.pane.diff');
    return !!diff && !diff.classList.contains('stale') && /changed/.test(diff.querySelector('.detail')?.textContent ?? '');
  })()`);
}

async function captureTriple(browser: Browser): Promise<void> {
  const out = path.join(os.tmpdir(), `ccvd-assets-${process.pid}`);
  const [result] = await runShots(browser, {
    before: sites[0].url,
    after: sites[1].url,
    paths: ['pricing.html'],
    sizes: [{ width: 900, height: 640, dpr: 1 }],
    fullPage: false,
    out,
    wait: 0,
    reducedMotion: false,
  });
  await writeFile(file('docs/before-diff-after.png'), await readFile(result.files.triple));
  console.log('docs/before-diff-after.png');
}

async function renderIcon(browser: Browser): Promise<void> {
  const svg = await readFile(file('ui/favicon.svg'), 'utf8');
  const context = await browser.newContext({ viewport: { width: 512, height: 512 } });
  try {
    const page = await context.newPage();
    await page.setContent(
      `<style>html, body { margin: 0; background: transparent; } svg { display: block; width: 512px; height: 512px; }</style>${svg}`,
    );
    await page.screenshot({ path: file('plugins/ccvd/.claude-plugin/icon.png'), omitBackground: true });
    console.log('plugins/ccvd/.claude-plugin/icon.png');
  } finally {
    await context.close();
  }
}

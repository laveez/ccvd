import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { Browser } from 'playwright-core';
import WebSocket from 'ws';
import { launchBrowser } from '../../src/browser.ts';
import { decodePng } from '../../src/png.ts';
import type { FrameHeader } from '../../src/protocol.ts';
import { startServer } from '../../src/server.ts';
import { Session, type SessionOptions } from '../../src/session.ts';
import { runShots } from '../../src/shot.ts';
import { type StaticServer, serveDirectory } from '../../src/static-server.ts';

let browser: Browser;
let root: string;
const cleanups: (() => Promise<unknown>)[] = [];

before(async () => {
  browser = await launchBrowser();
  root = await mkdtemp(path.join(os.tmpdir(), 'ccvd-hardening-'));
});

after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup().catch(() => {});
  await browser?.close();
  await rm(root, { recursive: true, force: true });
});

let sites = 0;

async function site(files: Record<string, string>): Promise<StaticServer> {
  const dir = path.join(root, `site-${++sites}`);
  await mkdir(dir);
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(dir, name), content);
  const server = await serveDirectory(dir);
  cleanups.push(() => server.close());
  return server;
}

async function session(options: Partial<SessionOptions> & Pick<SessionOptions, 'before' | 'after'>): Promise<Session> {
  const created = await Session.create(browser, {
    size: { width: 600, height: 400, dpr: 1 },
    fit: false,
    reducedMotion: false,
    ...options,
  });
  cleanups.push(() => created.close());
  return created;
}

async function until<T>(check: () => T | Promise<T>, what: string, timeout = 10_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await pause(100);
  }
}

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const loaded = (compared: Session) =>
  until(
    () =>
      compared.before.state.url.startsWith('http') && !compared.before.state.loading && !compared.after.state.loading,
    'both sides loaded',
  );

test('a page or its iframes cannot run code in the other side through scroll reports', {
  timeout: 30_000,
}, async () => {
  const frames = await site({ 'frame.html': '<p>frame</p>' });
  const beforeSite = await site({
    'index.html': `<body style="height:5000px"><iframe src="${frames.url}frame.html"></iframe></body>`,
  });
  const afterSite = await site({ 'index.html': '<title>after</title><body style="height:5000px">after</body>' });
  const compared = await session({ before: beforeSite.url, after: afterSite.url });
  await loaded(compared);
  const lead = () => {
    compared.handle({
      type: 'mouse',
      side: 'before',
      action: 'move',
      x: 300,
      y: 300,
      button: 'none',
      buttons: 0,
      clickCount: 0,
      modifiers: 0,
    });
    compared.handle({ type: 'wheel', side: 'before', x: 300, y: 300, deltaX: 0, deltaY: 0, modifiers: 0 });
  };
  const afterY = async () => (await compared.after.scrollPosition())[1];

  lead();
  const frame = await until(
    () => compared.before.page.frames().find(item => item.url().endsWith('frame.html')),
    'the iframe',
  );
  await frame.evaluate('window.__ccvdScroll(0, 3000)');
  await compared.before.page.evaluate(`window.__ccvdScroll("0); document.title = 'pwned'; (0", 0)`);
  await pause(400);
  assert.notEqual(await afterY(), 3000, 'scroll reports from an iframe are ignored');
  assert.equal(await compared.after.page.title(), 'after', 'code in a report does not run');

  lead();
  await compared.before.page.evaluate('window.__ccvdScroll(0, 1234)');
  await until(async () => (await afterY()) === 1234, 'the after side to follow a real report');
});

test('scrolling either side keeps two identical pages pixel-identical', { timeout: 60_000 }, async () => {
  const bands = Array.from(
    { length: 40 },
    (_, i) => `<div style="height:120px;background:hsl(${i * 9} 60% 70%)">row ${i}</div>`,
  );
  const pages = await site({
    'index.html': `<body style="margin:0;font:20px sans-serif">${bands.join('')}<script>addEventListener('scroll', () => { document.body.dataset.y = scrollY; });</script></body>`,
  });
  const compared = await session({ before: pages.url, after: pages.url });
  compared.attach();
  try {
    await loaded(compared);
    const offsets = async () =>
      JSON.stringify(await Promise.all([compared.before.scrollPosition(), compared.after.scrollPosition()]));
    for (const [side, deltaY] of [
      ['before', 300],
      ['after', -120],
      ['diff', 700],
      ['after', 260],
    ] as const) {
      compared.handle({
        type: 'mouse',
        side,
        action: 'move',
        x: 300,
        y: 200,
        button: 'none',
        buttons: 0,
        clickCount: 0,
        modifiers: 0,
      });
      for (let step = 0; step < 3; step++) {
        compared.handle({ type: 'wheel', side, x: 300, y: 200, deltaX: 0, deltaY: deltaY / 3, modifiers: 0 });
        await pause(16);
      }
      await until(async () => {
        const [before, after] = JSON.parse(await offsets());
        return before[1] === after[1] && before[1] > 0;
      }, `equal offsets after scrolling ${side}`);
    }
    await pause(500);
    const capture = await compared.currentCapture();
    assert.equal(capture?.diff.changed, 0, `offsets ${await offsets()}`);
  } finally {
    compared.detach();
  }
});

test('each side keeps the address it was given', { timeout: 30_000 }, async () => {
  const pages = await site({ 'index.html': '<p>variants</p>' });
  const compared = await session({
    before: new URL('?variant=old', pages.url),
    after: new URL('?variant=new', pages.url),
  });
  await loaded(compared);
  await pause(500);
  assert.match(compared.before.state.url, /\?variant=old$/);
  assert.match(compared.after.state.url, /\?variant=new$/);
});

test('sides whose servers redirect differently settle after a followed link', { timeout: 30_000 }, async () => {
  const redirecting = async (from: string, to: string) => {
    const server = http.createServer((request, response) => {
      if (request.url === from) {
        response.writeHead(301, { location: to }).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' }).end(`<p>${request.url}</p>`);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise(resolve => server.close(resolve)));
    return new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
  };
  const compared = await session({ before: await redirecting('/a', '/a/'), after: await redirecting('/a/', '/a') });
  await loaded(compared);
  let navigations = 0;
  for (const side of [compared.before, compared.after]) side.on('navigated', () => navigations++);
  compared.handle({
    type: 'mouse',
    side: 'before',
    action: 'down',
    x: 5,
    y: 5,
    button: 'left',
    buttons: 1,
    clickCount: 1,
    modifiers: 0,
  });
  await compared.before.page.evaluate("location.href = '/a/'");
  await pause(3000);
  assert.ok(navigations <= 4, `${navigations} navigations in 3 s`);
  assert.match(compared.after.state.url, /\/a$/);
});

test('a page that asks before leaving can still be navigated away from', { timeout: 30_000 }, async () => {
  const guarded = await site({
    'index.html':
      '<script>addEventListener("beforeunload", event => { event.preventDefault(); event.returnValue = ""; });</script><input>',
    'next.html': '<p>next</p>',
  });
  const compared = await session({ before: guarded.url, after: guarded.url });
  await loaded(compared);
  compared.handle({
    type: 'mouse',
    side: 'before',
    action: 'down',
    x: 20,
    y: 15,
    button: 'left',
    buttons: 1,
    clickCount: 1,
    modifiers: 0,
  });
  compared.handle({
    type: 'mouse',
    side: 'before',
    action: 'up',
    x: 20,
    y: 15,
    button: 'left',
    buttons: 0,
    clickCount: 1,
    modifiers: 0,
  });
  compared.handle({ type: 'key', side: 'before', action: 'down', key: 'a', code: 'KeyA', modifiers: 0 });
  compared.handle({ type: 'key', side: 'before', action: 'up', key: 'a', code: 'KeyA', modifiers: 0 });
  await pause(300);
  compared.handle({ type: 'navigate', action: 'goto', path: 'next.html' });
  await until(
    () => compared.before.state.path.endsWith('/next.html') && compared.after.state.path.endsWith('/next.html'),
    'both sides on next.html',
  );
});

test('a one-pixel change too small to show in the stream still reaches the diff', { timeout: 30_000 }, async () => {
  const pages = await site({
    'index.html':
      '<body style="margin:0;background:#fff"><div id="dot" style="width:1px;height:1px;background:#fff"></div>' +
      '<script>if (location.search === "?change") setTimeout(() => { document.getElementById("dot").style.background = "#fefefe"; }, 1500);</script></body>',
  });
  const compared = await session({ before: new URL('?same', pages.url), after: new URL('?change', pages.url) });
  const diffs: FrameHeader[] = [];
  compared.on('frame', header => {
    if (header.channel === 'diff') diffs.push(header);
  });
  compared.attach();
  try {
    await until(() => diffs.some(diff => diff.changed === 0), 'a diff with no changes');
    await until(() => diffs.some(diff => diff.changed === 1), 'the one changed pixel');
  } finally {
    compared.detach();
  }
});

test('broken requests and oversized messages do not stop the server', { timeout: 30_000 }, async () => {
  const pages = await site({ 'index.html': '<p>ok</p>' });
  assert.equal((await fetch(new URL('/%', pages.url))).status, 400);
  assert.equal((await fetch(pages.url)).status, 200);

  const compared = await session({ before: pages.url, after: pages.url });
  const server = await startServer({ session: compared, browser, port: 0 });
  cleanups.push(() => server.close());
  const token = new URL(server.url).searchParams.get('t');
  const open = () => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws?t=${token}`, {
      origin: `http://127.0.0.1:${server.port}`,
    });
    return new Promise<WebSocket>((resolve, reject) => {
      socket.once('open', () => resolve(socket));
      socket.once('error', reject);
    });
  };
  const first = await open();
  const closed = new Promise(resolve => first.once('close', resolve));
  first.send('x'.repeat(2 * 1024 * 1024));
  await closed;
  const second = await open();
  second.close();
  const raw = await new Promise<string>(resolve => {
    const request = http.request({
      host: '127.0.0.1',
      port: server.port,
      path: '//a:99999/ws',
      headers: { connection: 'upgrade', upgrade: 'websocket' },
    });
    request.on('response', response => resolve(String(response.statusCode)));
    request.on('upgrade', () => resolve('upgraded'));
    request.on('error', error => resolve(error.message));
    request.end();
  });
  assert.notEqual(raw, 'upgraded');
  assert.equal((await fetch(server.url)).status, 200, 'the server still answers');
});

test('shot compares each address as given, query included', { timeout: 60_000 }, async () => {
  const pages = await site({
    'index.html':
      '<p id="v" style="font-size:40px"></p><script>document.getElementById("v").textContent = location.search</script>',
  });
  const [result] = await runShots(browser, {
    before: new URL('?variant=old', pages.url),
    after: new URL('?variant=new', pages.url),
    paths: [''],
    sizes: [{ width: 400, height: 300, dpr: 1 }],
    fullPage: false,
    out: path.join(root, 'shots-variant'),
    wait: 0,
    reducedMotion: false,
  });
  assert.match(result.before.url, /\?variant=old$/);
  assert.match(result.after.url, /\?variant=new$/);
  assert.ok(result.changed > 0);
});

test('shot finishes on a page that keeps growing as it scrolls', { timeout: 90_000 }, async () => {
  const feed = await site({
    'index.html':
      '<body style="margin:0"><div id="feed"></div><script>const feed = document.getElementById("feed");' +
      'const add = () => { for (let i = 0; i < 20; i++) { const item = document.createElement("div"); item.style.height = "200px"; item.style.background = i % 2 ? "#eee" : "#ccc"; feed.append(item); } };' +
      'add(); addEventListener("scroll", () => { if (innerHeight + scrollY > document.body.scrollHeight - 400) add(); });</script></body>',
  });
  const [result] = await runShots(browser, {
    before: feed.url,
    after: feed.url,
    paths: [''],
    sizes: [{ width: 400, height: 800, dpr: 1 }],
    fullPage: true,
    out: path.join(root, 'shots-feed'),
    wait: 0,
    reducedMotion: false,
  });
  const image = decodePng(await readFile(result.files.before));
  assert.ok(image.height <= 16_384, `captured ${image.height} px`);
});

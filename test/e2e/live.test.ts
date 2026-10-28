import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Browser } from 'playwright-core';
import WebSocket from 'ws';
import { launchBrowser } from '../../src/browser.ts';
import { decodePng } from '../../src/png.ts';
import type { ClientMessage, FrameHeader, StateMessage } from '../../src/protocol.ts';
import { type RunningServer, startServer } from '../../src/server.ts';
import { Session } from '../../src/session.ts';
import type { Side } from '../../src/side.ts';
import { type StaticServer, serveDirectory } from '../../src/static-server.ts';

const demo = new URL('../../examples/demo/', import.meta.url);
let browser: Browser;
let beforeSite: StaticServer;
let afterSite: StaticServer;
let session: Session;
let server: RunningServer;

before(async () => {
  browser = await launchBrowser();
  beforeSite = await serveDirectory(fileURLToPath(new URL('before', demo)));
  afterSite = await serveDirectory(fileURLToPath(new URL('after', demo)));
  session = await Session.create(browser, {
    before: beforeSite.url,
    after: afterSite.url,
    size: { width: 800, height: 600, dpr: 1 },
    fit: false,
    reducedMotion: false,
  });
  server = await startServer({ session, browser, port: 0 });
});

after(async () => {
  await server?.close();
  await session?.close();
  await browser?.close();
  await Promise.all([beforeSite?.close(), afterSite?.close()]);
});

const token = () => new URL(server.url).searchParams.get('t') ?? '';
const origin = () => `http://127.0.0.1:${server.port}`;

class Viewer {
  readonly socket: WebSocket;
  state: StateMessage | undefined;
  readonly frames: { header: FrameHeader; bytes: Buffer }[] = [];

  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) {
        const message = JSON.parse(data.toString());
        if (message.type === 'state') this.state = message;
        return;
      }
      const length = data.readUInt32BE(0);
      this.frames.push({
        header: JSON.parse(data.subarray(4, 4 + length).toString()),
        bytes: data.subarray(4 + length),
      });
    });
  }

  send(message: ClientMessage): void {
    this.socket.send(JSON.stringify(message));
  }

  close(): void {
    this.socket.close();
  }
}

function connect(options: { token?: string; origin?: string } = {}): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${server.port}/ws?t=${options.token ?? token()}`, {
    origin: options.origin ?? origin(),
  });
}

function opened(socket: WebSocket): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

const open = (options: { token?: string; origin?: string } = {}) => opened(connect(options));

// The server sends its state as soon as the socket opens, and ws can deliver that message before a
// promise waiting for 'open' resumes, so the viewer listens from the moment the socket exists.
async function viewer(): Promise<Viewer> {
  const socket = connect();
  const client = new Viewer(socket);
  await opened(socket);
  return client;
}

async function until<T>(check: () => T | Promise<T>, what: string, timeout = 15_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function center(side: Side, selector: string): Promise<{ x: number; y: number }> {
  return side.page.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    element.scrollIntoView({ block: 'center', behavior: 'instant' });
    const box = element.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  })()`);
}

function click(target: Viewer, point: { x: number; y: number }): void {
  for (const action of ['down', 'up'] as const) {
    target.send({
      type: 'mouse',
      side: 'before',
      action,
      ...point,
      button: 'left',
      buttons: action === 'down' ? 1 : 0,
      clickCount: 1,
      modifiers: 0,
    });
  }
}

let visits = 0;

// A fresh query string per visit, so waiting for the path also waits for a page that was already there to reload.
async function goto(target: Viewer, page: string): Promise<void> {
  const path = `${page}?visit=${++visits}`;
  target.send({ type: 'navigate', action: 'goto', path });
  await until(
    () =>
      session.before.state.path.endsWith(path) &&
      session.after.state.path.endsWith(path) &&
      !session.before.state.loading &&
      !session.after.state.loading,
    `both sides at ${path}`,
  );
}

test('refuses a wrong token, a foreign origin and a foreign Host', async () => {
  await assert.rejects(open({ token: 'wrong' }), /403/);
  await assert.rejects(open({ origin: 'https://evil.example' }), /403/);
  const status = await new Promise<number | undefined>((resolve, reject) => {
    http
      .get(
        { host: '127.0.0.1', port: server.port, path: '/', headers: { host: `evil.example:${server.port}` } },
        response => {
          response.resume();
          resolve(response.statusCode);
        },
      )
      .on('error', reject);
  });
  assert.equal(status, 403);
});

test('streams both sides and an exact diff', { timeout: 30_000 }, async () => {
  const client = await viewer();
  try {
    const diff = await until(
      () => client.frames.find(frame => frame.header.channel === 'diff' && frame.header.exact),
      'an exact diff',
    );
    assert.ok((diff.header.changed ?? 0) > 0, 'the demo sides differ');
    const exactBefore = client.frames.find(frame => frame.header.channel === 'before' && frame.header.exact);
    const image = decodePng(exactBefore?.bytes ?? Buffer.alloc(0));
    assert.deepEqual([image.width, image.height], [800, 600]);
    assert.equal(client.state?.size.width, 800);
  } finally {
    client.close();
  }
});

test('scrolling one side scrolls the other to the same offset', { timeout: 30_000 }, async () => {
  const client = await viewer();
  try {
    await goto(client, 'index.html');
    client.send({
      type: 'mouse',
      side: 'before',
      action: 'move',
      x: 400,
      y: 300,
      button: 'none',
      buttons: 0,
      clickCount: 0,
      modifiers: 0,
    });
    client.send({ type: 'wheel', side: 'before', x: 400, y: 300, deltaX: 0, deltaY: 500, modifiers: 0 });
    await until(async () => {
      const [, beforeY] = await session.before.scrollPosition();
      const [, afterY] = await session.after.scrollPosition();
      return beforeY > 0 && beforeY === afterY;
    }, 'equal scroll offsets');
  } finally {
    client.close();
  }
});

test('links follow on both sides while linked, and only one side when unlinked', { timeout: 30_000 }, async () => {
  const client = await viewer();
  try {
    await goto(client, 'index.html');
    client.send({ type: 'linked', value: true });
    click(client, await center(session.before, 'nav a[href="pricing.html"]'));
    await until(
      () => session.before.state.path.endsWith('/pricing.html') && session.after.state.path.endsWith('/pricing.html'),
      'both on pricing',
    );

    client.send({ type: 'linked', value: false });
    await until(() => client.state?.linked === false, 'unlinked state');
    click(client, await center(session.before, 'nav a[href="index.html"]'));
    await until(() => session.before.state.path.endsWith('/index.html'), 'before on index');
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.ok(session.after.state.path.endsWith('/pricing.html'), 'after stays on pricing');
  } finally {
    client.send({ type: 'linked', value: true });
    client.close();
  }
});

test('typing reaches both pages, including keys outside the US layout', { timeout: 30_000 }, async () => {
  const client = await viewer();
  try {
    await goto(client, 'index.html');
    await Promise.all([session.before.page.focus('input'), session.after.page.focus('input')]);
    for (const key of ['a', 'ä', 'Shift', 'B']) {
      client.send({ type: 'key', side: 'before', action: 'down', key, code: '', modifiers: 0 });
      if (key !== 'Shift') client.send({ type: 'key', side: 'before', action: 'up', key, code: '', modifiers: 0 });
    }
    client.send({ type: 'key', side: 'before', action: 'up', key: 'Shift', code: '', modifiers: 0 });
    await until(async () => {
      const values = await Promise.all([session.before, session.after].map(side => side.page.inputValue('input')));
      return values.every(value => value === 'aäB');
    }, 'aäB typed on both sides');
  } finally {
    client.close();
  }
});

test('exports a labelled pair and triple', { timeout: 30_000 }, async () => {
  const client = await viewer();
  try {
    await until(() => session.latest, 'a capture');
    const triple = await fetch(`${origin()}/export.png?layout=triple&t=${token()}`);
    assert.equal(triple.status, 200);
    assert.equal(triple.headers.get('content-type'), 'image/png');
    const image = decodePng(new Uint8Array(await triple.arrayBuffer()));
    assert.ok(image.width > 3 * 800, `triple is ${image.width} wide`);
    assert.ok(image.height > 600);
    const pair = await fetch(`${origin()}/export.png?layout=pair&download=1&t=${token()}`);
    assert.match(pair.headers.get('content-disposition') ?? '', /^attachment; filename="ccvd-.+-800x600-pair\.png"$/);
    const refused = await fetch(`${origin()}/export.png?layout=pair&t=wrong`);
    assert.equal(refused.status, 403);
  } finally {
    client.close();
  }
});

test('uses the next port when the chosen one is taken', async () => {
  const second = await startServer({ session, browser, port: server.port });
  try {
    assert.notEqual(second.port, server.port);
    assert.ok(second.port > server.port && second.port < server.port + 20);
  } finally {
    await second.close();
  }
});

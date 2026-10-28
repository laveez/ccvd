import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Browser } from 'playwright-core';
import { type WebSocket, WebSocketServer } from 'ws';
import { composeImage, diffDetail, type Panel } from './compose.ts';
import type { ClientMessage, FrameHeader } from './protocol.ts';
import type { Session } from './session.ts';
import { sizeLabel } from './sizes.ts';
import { pathSlug } from './urls.ts';

export interface ServerOptions {
  session: Session;
  browser: Browser;
  port: number;
}

export interface RunningServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

const PORT_ATTEMPTS = 20;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

// Running from the TypeScript sources (tests, development) serves the UI build from dist.
const APP_JS = import.meta.url.endsWith('.ts') ? '../dist/ui/app.js' : './ui/app.js';

const ASSETS: Record<string, { file: URL; type: string }> = {
  '/': { file: new URL('../ui/index.html', import.meta.url), type: 'text/html; charset=utf-8' },
  '/styles.css': { file: new URL('../ui/styles.css', import.meta.url), type: 'text/css; charset=utf-8' },
  '/favicon.svg': { file: new URL('../ui/favicon.svg', import.meta.url), type: 'image/svg+xml' },
  '/app.js': { file: new URL(APP_JS, import.meta.url), type: 'text/javascript; charset=utf-8' },
};

export async function startServer({ session, browser, port }: ServerOptions): Promise<RunningServer> {
  const token = randomBytes(16).toString('hex');
  const clients = new Set<WebSocket>();
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const server = http.createServer();
  const listening = await listen(server, port);
  const allowedHosts = new Set([`127.0.0.1:${listening}`, `localhost:${listening}`]);
  const allowedOrigins = new Set([...allowedHosts].map(host => `http://${host}`));
  const policy = [
    "default-src 'self'",
    "img-src 'self' blob: data:",
    `connect-src 'self' ${[...allowedHosts].map(host => `ws://${host}`).join(' ')}`,
    "style-src 'self'",
    "script-src 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  const hasToken = (url: URL) => {
    const given = Buffer.from(url.searchParams.get('t') ?? '');
    const expected = Buffer.from(token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  server.on('request', (request, response) => {
    void serve(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });

  async function serve(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (!allowedHosts.has(request.headers.host ?? '')) return refuse(response, 403, 'Unexpected Host header');
    if (request.method !== 'GET' && request.method !== 'HEAD') return refuse(response, 405, 'Method not allowed');
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    if (url.pathname === '/export.png') {
      if (!hasToken(url)) return refuse(response, 403, 'Missing or wrong token');
      return sendExport(url, response);
    }
    const asset = ASSETS[url.pathname];
    if (!asset) return refuse(response, 404, 'Not found');
    const body = await readFile(asset.file);
    response.writeHead(200, {
      'content-type': asset.type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': policy,
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  }

  async function sendExport(url: URL, response: http.ServerResponse): Promise<void> {
    const capture = session.latest;
    if (!capture) return refuse(response, 503, 'Nothing captured yet');
    const layout = url.searchParams.get('layout') === 'pair' ? 'pair' : 'triple';
    const before: Panel = { label: 'Before', detail: session.before.state.path, image: capture.before };
    const after: Panel = { label: 'After', detail: session.after.state.path, image: capture.after };
    const diff: Panel = {
      label: 'Diff',
      detail: diffDetail(capture.diff.changed, capture.diff.total),
      image: capture.diff.image,
      tone: capture.diff.changed > 0 ? 'changed' : 'unchanged',
    };
    const png = await composeImage(
      browser,
      layout === 'pair' ? [before, after] : [before, diff, after],
      capture.size.dpr,
    );
    const name = `ccvd-${pathSlug(new URL(session.before.state.url), session.before.base)}-${sizeLabel(capture.size)}-${layout}.png`;
    const disposition = url.searchParams.has('download') ? 'attachment' : 'inline';
    response.writeHead(200, {
      'content-type': 'image/png',
      'content-length': png.length,
      'content-disposition': `${disposition}; filename="${name}"`,
      'cache-control': 'no-store',
    });
    response.end(png);
  }

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const allowed =
      url.pathname === '/ws' &&
      allowedHosts.has(request.headers.host ?? '') &&
      allowedOrigins.has(request.headers.origin ?? '') &&
      hasToken(url);
    if (!allowed) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    sockets.handleUpgrade(request, socket, head, client => connect(client));
  });

  function connect(client: WebSocket): void {
    clients.add(client);
    session.attach();
    client.send(JSON.stringify(session.state()));
    for (const [header, bytes] of session.exactFrames.values()) client.send(encodeFrame(header, bytes));
    client.on('message', (data, isBinary) => {
      if (isBinary) return;
      const message = parseClientMessage(data.toString());
      if (message) session.handle(message);
    });
    client.on('close', () => {
      clients.delete(client);
      session.detach();
    });
  }

  const onFrame = (header: FrameHeader, bytes: Buffer) => {
    const frame = encodeFrame(header, bytes);
    for (const client of clients) {
      if (!header.exact && client.bufferedAmount > MAX_BUFFERED_BYTES) continue;
      client.send(frame);
    }
  };
  const onMessage = (message: unknown) => {
    const text = JSON.stringify(message);
    for (const client of clients) client.send(text);
  };
  session.on('frame', onFrame);
  session.on('message', onMessage);

  return {
    url: `http://127.0.0.1:${listening}/?t=${token}`,
    port: listening,
    async close() {
      session.off('frame', onFrame);
      session.off('message', onMessage);
      for (const client of clients) client.terminate();
      sockets.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

export function encodeFrame(header: FrameHeader, bytes: Buffer): Buffer {
  const json = Buffer.from(JSON.stringify(header));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(json.length, 0);
  return Buffer.concat([length, json, bytes]);
}

async function listen(server: http.Server, port: number): Promise<number> {
  for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port + attempt, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      return (server.address() as AddressInfo).port;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || port === 0) throw error;
    }
  }
  throw new Error(`Ports ${port} to ${port + PORT_ATTEMPTS - 1} are all in use; pick another with --port`);
}

function refuse(response: http.ServerResponse, status: number, message: string): void {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  response.end(`${message}\n`);
}

const CHANNELS = new Set(['before', 'after', 'diff']);
const BUTTONS = new Set(['none', 'left', 'middle', 'right']);
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isString = (value: unknown, max = 2048): value is string => typeof value === 'string' && value.length <= max;

export function parseClientMessage(text: string): ClientMessage | undefined {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const pointer = CHANNELS.has(value.side as string) && isNumber(value.x) && isNumber(value.y);
  switch (value.type) {
    case 'mouse':
      return pointer &&
        ['move', 'down', 'up'].includes(value.action as string) &&
        BUTTONS.has(value.button as string) &&
        isNumber(value.buttons) &&
        isNumber(value.clickCount) &&
        isNumber(value.modifiers)
        ? (value as unknown as ClientMessage)
        : undefined;
    case 'wheel':
      return pointer && isNumber(value.deltaX) && isNumber(value.deltaY) && isNumber(value.modifiers)
        ? (value as unknown as ClientMessage)
        : undefined;
    case 'key':
      return CHANNELS.has(value.side as string) &&
        (value.action === 'down' || value.action === 'up') &&
        isString(value.key, 32) &&
        isString(value.code, 32) &&
        isNumber(value.modifiers)
        ? (value as unknown as ClientMessage)
        : undefined;
    case 'navigate':
      if (['back', 'forward', 'reload'].includes(value.action as string)) return value as unknown as ClientMessage;
      return value.action === 'goto' && isString(value.path) ? (value as unknown as ClientMessage) : undefined;
    case 'size':
      return isNumber(value.width) &&
        isNumber(value.height) &&
        (value.dpr === 1 || value.dpr === 2) &&
        typeof value.fit === 'boolean'
        ? (value as unknown as ClientMessage)
        : undefined;
    case 'linked':
    case 'reducedMotion':
      return typeof value.value === 'boolean' ? (value as unknown as ClientMessage) : undefined;
    default:
      return undefined;
  }
}

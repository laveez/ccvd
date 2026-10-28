import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

export interface StaticServer {
  url: URL;
  close(): Promise<void>;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

export async function serveDirectory(root: string): Promise<StaticServer> {
  const base = path.resolve(root);
  const server = http.createServer((request, response) => {
    void respond(base, request, response);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: new URL(`http://127.0.0.1:${port}/`),
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

async function respond(base: string, request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
  } catch {
    response.writeHead(400).end();
    return;
  }
  let file = path.join(base, pathname);
  if (file !== base && !file.startsWith(`${base}${path.sep}`)) {
    response.writeHead(403).end();
    return;
  }
  try {
    if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
    await stat(file);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found\n');
    return;
  }
  response.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(response);
}

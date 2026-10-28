import { spawn } from 'node:child_process';
import { launchBrowser } from './browser.ts';
import type { LiveCommand } from './cli.ts';
import { type RunningServer, startServer } from './server.ts';
import { Session } from './session.ts';
import { VERSION } from './version.ts';

const FIT_START = { width: 1280, height: 800, dpr: 1 } as const;
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

export async function runLive(command: LiveCommand): Promise<void> {
  const browser = await launchBrowser(command.browser, { handleSignals: false });
  let session: Session | undefined;
  let server: RunningServer | undefined;
  try {
    session = await Session.create(browser, {
      before: command.before,
      after: command.after,
      size: command.size === 'fit' ? FIT_START : command.size,
      fit: command.size === 'fit',
      reducedMotion: command.reducedMotion,
    });
    server = await startServer({ session, browser, port: command.port });
    console.log(
      [
        `ccvd ${VERSION}`,
        `  Before  ${command.before.href}`,
        `  After   ${command.after.href}`,
        '',
        `  Open    ${server.url}`,
        '',
        'Press Ctrl+C to stop.',
      ].join('\n'),
    );
    if (command.open) openInBrowser(server.url);
    const reason = await stopped(browser);
    if (reason) console.log(reason);
  } finally {
    await server?.close();
    await session?.close();
    await browser.close();
  }
}

function stopped(browser: { once(event: 'disconnected', listener: () => void): unknown }): Promise<string> {
  return new Promise(resolve => {
    for (const signal of SIGNALS) process.once(signal, () => resolve(''));
    browser.once('disconnected', () => resolve('The browser closed, so ccvd stopped.'));
  });
}

function openInBrowser(url: string): void {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url]]
        : ['xdg-open', [url]];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => console.log('Could not open a browser; open the address above yourself.'));
  child.unref();
}

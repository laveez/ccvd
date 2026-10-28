import { type Browser, chromium, type LaunchOptions } from 'playwright-core';
import { HAS_WEBGL } from './page-script.ts';

interface Candidate {
  label: string;
  options: LaunchOptions;
}

export interface LaunchSettings {
  // The live view closes the browser itself on signals, after its server and pages.
  handleSignals?: boolean;
}

const BUNDLED: Candidate = { label: 'Playwright Chromium', options: {} };
const CHROME: Candidate = { label: 'Google Chrome', options: { channel: 'chrome' } };
const EDGE: Candidate = { label: 'Microsoft Edge', options: { channel: 'msedge' } };

// Smooth and threaded scrolling move the picture on the compositor ahead of what the page's main
// thread reports, so a capture could catch one side mid-scroll while both offsets look equal.
const SCROLLING = ['--disable-smooth-scrolling', '--disable-threaded-scrolling'];
// Headless Chromium draws in software unless told to use the GPU, and pages with blurs and
// animations then scroll at a few frames a second.
const GPU = '--enable-gpu';

export async function launchBrowser(choice?: string, settings: LaunchSettings = {}): Promise<Browser> {
  const candidates = choice ? [chosen(choice)] : [BUNDLED, CHROME, EDGE];
  const signals = settings.handleSignals ?? true;
  const base: LaunchOptions = {
    headless: true,
    handleSIGINT: signals,
    handleSIGTERM: signals,
    handleSIGHUP: signals,
  };
  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      return await start({ ...base, ...candidate.options, chromiumSandbox: true });
    } catch (sandboxed) {
      // Some Linux setups (Ubuntu 24.04's user namespace restriction, containers) cannot start
      // Chromium's sandbox; running without it beats not running, as long as the user knows.
      try {
        const browser = await start({ ...base, ...candidate.options, chromiumSandbox: false });
        console.error(
          `ccvd: ${candidate.label} could not start with its sandbox (${firstLine(sandboxed)}), so the compared pages run without it. Compare only sites you trust.`,
        );
        return browser;
      } catch (error) {
        failures.push(`  ${candidate.label}: ${firstLine(error)}`);
      }
    }
  }
  throw new Error(
    `Could not start a Chromium-based browser:\n${failures.join('\n')}\n` +
      'Install Google Chrome, or the Chromium build ccvd is tested with: npx playwright-core install chromium',
  );
}

// A GPU that cannot start takes WebGL down with it (Playwright's headless shell, some drivers), which
// is worse than drawing in software, so such a browser starts again without the GPU.
async function start(options: LaunchOptions): Promise<Browser> {
  const browser = await chromium.launch({ ...options, args: [...SCROLLING, GPU] });
  if (await hasWebGl(browser)) return browser;
  await browser.close();
  return chromium.launch({ ...options, args: SCROLLING });
}

async function hasWebGl(browser: Browser): Promise<boolean> {
  try {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      return (await page.evaluate(HAS_WEBGL)) === true;
    } finally {
      await context.close().catch(() => {});
    }
  } catch {
    return false;
  }
}

function chosen(choice: string): Candidate {
  switch (choice) {
    case 'chromium':
      return BUNDLED;
    case 'chrome':
      return CHROME;
    case 'msedge':
    case 'edge':
      return EDGE;
    default:
      return { label: choice, options: { executablePath: choice } };
  }
}

export function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n').find(line => line.trim() !== '') ?? message;
}

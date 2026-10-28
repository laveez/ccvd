import { type Browser, chromium, type LaunchOptions } from 'playwright-core';

interface Candidate {
  label: string;
  options: LaunchOptions;
}

const BUNDLED: Candidate = { label: 'Playwright Chromium', options: {} };
const CHROME: Candidate = { label: 'Google Chrome', options: { channel: 'chrome' } };
const EDGE: Candidate = { label: 'Microsoft Edge', options: { channel: 'msedge' } };

export async function launchBrowser(choice?: string): Promise<Browser> {
  const candidates = choice ? [chosen(choice)] : [BUNDLED, CHROME, EDGE];
  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      return await chromium.launch({ headless: true, ...candidate.options });
    } catch (error) {
      failures.push(`  ${candidate.label}: ${firstLine(error)}`);
    }
  }
  throw new Error(
    `Could not start a Chromium-based browser:\n${failures.join('\n')}\n` +
      'Install Google Chrome, or the Chromium build ccvd is tested with: npx playwright-core install chromium',
  );
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

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n').find(line => line.trim() !== '') ?? message;
}

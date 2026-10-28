#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../browser.ts';
import { CliError, type Command, type DemoCommand, parseCli, type ShotCommand, USAGE } from '../cli.ts';
import { runLive } from '../live.ts';
import { formatResults, runShots } from '../shot.ts';
import { serveDirectory } from '../static-server.ts';
import { VERSION } from '../version.ts';

try {
  await run(parseCli(process.argv.slice(2)));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = error instanceof CliError ? 2 : 1;
}

async function run(command: Command): Promise<void> {
  switch (command.kind) {
    case 'help':
      console.log(USAGE);
      return;
    case 'version':
      console.log(VERSION);
      return;
    case 'live':
      await runLive(command);
      return;
    case 'shot':
      await shot(command);
      return;
    case 'demo':
      await demo(command);
      return;
  }
}

async function shot(command: ShotCommand): Promise<void> {
  const browser = await launchBrowser(command.browser);
  try {
    const results = await runShots(browser, command);
    console.log(command.json ? JSON.stringify(results, null, 2) : formatResults(results, command.out));
  } finally {
    await browser.close();
  }
}

async function demo(command: DemoCommand): Promise<void> {
  const sites = await Promise.all(
    ['before', 'after'].map(side =>
      serveDirectory(fileURLToPath(new URL(`../../examples/demo/${side}`, import.meta.url))),
    ),
  );
  try {
    await runLive({ ...command, kind: 'live', before: sites[0].url, after: sites[1].url });
  } finally {
    await Promise.all(sites.map(site => site.close()));
  }
}

#!/usr/bin/env node
import { CliError, type Command, parseCli, USAGE } from '../cli.ts';
import { runLive } from '../live.ts';
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
      throw new CliError('ccvd shot is not available yet.');
  }
}


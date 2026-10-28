import { parseArgs } from 'node:util';
import { PRESETS, parseSize, type Size } from './sizes.ts';
import { parseBase } from './urls.ts';

export const DEFAULT_PORT = 2283;

interface Common {
  before: URL;
  after: URL;
  browser?: string;
  reducedMotion: boolean;
}

export interface LiveCommand extends Common {
  kind: 'live';
  size: Size | 'fit';
  port: number;
  open: boolean;
}

export interface ShotCommand extends Common {
  kind: 'shot';
  paths: string[];
  sizes: Size[];
  fullPage: boolean;
  out: string;
  wait: number;
  json: boolean;
}

export interface DemoCommand extends Omit<LiveCommand, 'kind' | 'before' | 'after'> {
  kind: 'demo';
}

export type Command = LiveCommand | ShotCommand | DemoCommand | { kind: 'help' } | { kind: 'version' };

export class CliError extends Error {}

export const USAGE = `ccvd: Claude Code Visual Diff

Compare two versions of a site side by side, with an exact pixel diff between them.

Usage:
  ccvd <before> <after> [options]        Open the live compare view
  ccvd shot <before> <after> [options]   Save before, after and diff images
  ccvd demo [options]                    Try the live view on a bundled demo site

<before> and <after> are http(s) addresses; host:port means http://host:port.

Live view and demo:
  --size <size>       Page size: fit (default: follows the pane), a preset or WIDTHxHEIGHT[@2]
  --port <port>       Port to serve the view on (default ${DEFAULT_PORT}; the next free one if taken)
  --no-open           Print the view's address instead of opening it in your browser

Shot:
  --path <path>       Page to capture, resolved against each address like a link (repeatable;
                      default: both addresses as given)
  --size <size>       Preset or WIDTHxHEIGHT[@2] (repeatable; default: desktop)
  --viewport          Capture only the viewport instead of the full page
  --out <dir>         Folder for the images (default: ccvd-shots)
  --wait <ms>         Extra wait after the pages settle (default: 300)
  --json              Print the results as JSON

Both:
  --browser <name>    chromium, chrome, msedge or the path to a Chromium-based browser
  --no-reduced-motion Let pages animate; by default they render with prefers-reduced-motion: reduce
  -h, --help          Show this help
  -v, --version       Show the version

Size presets: ${PRESETS.map(p => `${p.id} ${p.width}x${p.height}`).join(', ')}
`;

const OPTIONS = {
  size: { type: 'string', multiple: true },
  port: { type: 'string' },
  open: { type: 'boolean', default: true },
  path: { type: 'string', multiple: true },
  viewport: { type: 'boolean', default: false },
  out: { type: 'string' },
  wait: { type: 'string' },
  json: { type: 'boolean', default: false },
  browser: { type: 'string' },
  'reduced-motion': { type: 'boolean', default: true },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'v', default: false },
} as const;

const LIVE_ONLY = ['port', 'open'] as const;
const SHOT_ONLY = ['path', 'viewport', 'out', 'wait', 'json'] as const;

export function parseCli(argv: string[]): Command {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    throw new CliError(`${(error as Error).message}\nRun ccvd --help for usage.`);
  }
  const { values, positionals, tokens } = parsed;
  if (values.help) return { kind: 'help' };
  if (values.version) return { kind: 'version' };

  const shot = positionals[0] === 'shot';
  const given = new Set(tokens.filter(token => token.kind === 'option').map(token => token.name));
  for (const name of shot ? LIVE_ONLY : SHOT_ONLY) {
    if (given.has(name)) {
      throw new CliError(
        `--${name === 'open' ? 'no-open' : name} applies only to ${shot ? 'the live view' : 'ccvd shot'}.`,
      );
    }
  }
  if (positionals[0] === 'demo') {
    if (positionals.length > 1) throw new CliError('ccvd demo takes no addresses: it serves its own demo site.');
    return { kind: 'demo', ...liveOptions(values), browser: values.browser, reducedMotion: values['reduced-motion'] };
  }

  const addresses = shot ? positionals.slice(1) : positionals;
  if (addresses.length !== 2) {
    throw new CliError(
      `Expected two addresses, before and after, but got ${addresses.length}.\nRun ccvd --help for usage.`,
    );
  }

  const common: Common = {
    before: wrap(() => parseBase(addresses[0])),
    after: wrap(() => parseBase(addresses[1])),
    browser: values.browser,
    reducedMotion: values['reduced-motion'],
  };
  if (shot) {
    return {
      kind: 'shot',
      ...common,
      paths: values.path ?? [''],
      sizes: wrap(() => (values.size ?? ['desktop']).map(parseSize)),
      fullPage: !values.viewport,
      out: values.out ?? 'ccvd-shots',
      wait: integer('wait', values.wait ?? '300', 0, 60_000),
      json: values.json,
    };
  }
  return { kind: 'live', ...common, ...liveOptions(values) };
}

function liveOptions(values: ReturnType<typeof parse>['values']): Pick<LiveCommand, 'size' | 'port' | 'open'> {
  if ((values.size?.length ?? 0) > 1) throw new CliError('The live view takes one --size.');
  const size = values.size?.[0] ?? 'fit';
  return {
    size: size === 'fit' ? 'fit' : wrap(() => parseSize(size)),
    port: integer('port', values.port ?? String(DEFAULT_PORT), 1, 65_535),
    open: values.open,
  };
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    options: OPTIONS,
    allowPositionals: true,
    allowNegative: true,
    strict: true,
    tokens: true,
  });
}

function wrap<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    throw new CliError((error as Error).message);
  }
}

function integer(name: string, value: string, min: number, max: number): number {
  const number = Number(value);
  if (!/^\d+$/.test(value) || number < min || number > max) {
    throw new CliError(`--${name} must be a whole number from ${min} to ${max}, got ${value}.`);
  }
  return number;
}

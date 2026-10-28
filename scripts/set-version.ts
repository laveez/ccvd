#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const { positionals } = parseArgs({ allowPositionals: true });
const version = positionals[0] ?? '';
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('Usage: npm run set-version -- <major.minor.patch>');
  process.exit(1);
}

const root = new URL('../', import.meta.url);
execFileSync('npm', ['version', version, '--no-git-tag-version', '--allow-same-version'], {
  cwd: root,
  stdio: 'inherit',
});

async function update(path: string, change: (text: string) => string): Promise<void> {
  const file = new URL(path, root);
  await writeFile(file, change(await readFile(file, 'utf8')));
}

const setJsonVersion = (text: string) => text.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`);
await update('plugins/ccvd/.claude-plugin/plugin.json', setJsonVersion);
await update('.claude-plugin/marketplace.json', setJsonVersion);
await update('plugins/ccvd/skills/ccvd/SKILL.md', text =>
  text.replace(/@laveez\/ccvd@\d+\.\d+\.\d+/g, `@laveez/ccvd@${version}`),
);
console.log(`Set ${version} in package.json, the plugin, the marketplace and the skill.`);

#!/usr/bin/env node
// The plugin's skill runs npx -y ccvd@<version>, so a release must move the npm package, the plugin
// manifest, the marketplace entry and every pinned version in the skill together.
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = (path: string) => readFile(new URL(path, root), 'utf8');

const expected: string = JSON.parse(await read('package.json')).version;
const marketplace = JSON.parse(await read('.claude-plugin/marketplace.json'));
const skill = await read('plugins/ccvd/skills/ccvd/SKILL.md');
const pins = [...skill.matchAll(/ccvd@(\S+?)(?=[\s`)]|$)/gm)].map(match => match[1]);

const found: [string, string | undefined][] = [
  [
    'plugins/ccvd/.claude-plugin/plugin.json',
    JSON.parse(await read('plugins/ccvd/.claude-plugin/plugin.json')).version,
  ],
  [
    '.claude-plugin/marketplace.json',
    marketplace.plugins.find((plugin: { name: string }) => plugin.name === 'ccvd')?.version,
  ],
  ...pins.map((pin, index): [string, string] => [`plugins/ccvd/skills/ccvd/SKILL.md, pin ${index + 1}`, pin]),
];
const wrong = found.filter(([, version]) => version !== expected);

if (pins.length === 0) {
  console.error('plugins/ccvd/skills/ccvd/SKILL.md pins no ccvd@<version>.');
  process.exit(1);
}
if (wrong.length > 0) {
  console.error(`package.json is at ${expected}, but:`);
  for (const [file, version] of wrong) console.error(`  ${file}: ${version ?? 'missing'}`);
  console.error('Run npm run set-version -- <version> to move them together.');
  process.exit(1);
}
console.log(`All ${found.length + 1} versions are ${expected}.`);

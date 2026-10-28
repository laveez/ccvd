import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CliError, DEFAULT_PORT, parseCli } from '../../src/cli.ts';
import { parseSize } from '../../src/sizes.ts';

test('two addresses open the live view with defaults', () => {
  const command = parseCli(['localhost:8101', 'localhost:8102']);
  assert.equal(command.kind, 'live');
  if (command.kind !== 'live') return;
  assert.equal(command.before.href, 'http://localhost:8101/');
  assert.equal(command.after.href, 'http://localhost:8102/');
  assert.equal(command.size, 'fit');
  assert.equal(command.port, DEFAULT_PORT);
  assert.equal(command.open, true);
  assert.equal(command.reducedMotion, false);
});

test('live view options', () => {
  const command = parseCli(['a:1', 'b:2', '--size', 'phone@2', '--port', '9000', '--no-open', '--reduced-motion']);
  assert.deepEqual(command.kind === 'live' && [command.size, command.port, command.open, command.reducedMotion], [
    { width: 440, height: 956, dpr: 2 },
    9000,
    false,
    true,
  ]);
});

test('shot collects repeated paths and sizes', () => {
  const command = parseCli([
    'shot',
    'a:1',
    'b:2',
    '--path',
    '/',
    '--path',
    'about',
    '--size',
    'phone',
    '--size',
    '1280x800@2',
    '--json',
  ]);
  assert.equal(command.kind, 'shot');
  if (command.kind !== 'shot') return;
  assert.deepEqual(command.paths, ['/', 'about']);
  assert.deepEqual(command.sizes, [
    { width: 440, height: 956, dpr: 1 },
    { width: 1280, height: 800, dpr: 2 },
  ]);
  assert.equal(command.json, true);
  assert.equal(command.fullPage, true);
  assert.equal(command.out, 'ccvd-shots');
  assert.equal(command.wait, 300);
});

test('shot defaults to the before address at desktop size, full page', () => {
  const command = parseCli(['shot', 'a:1', 'b:2', '--viewport']);
  assert.deepEqual(command.kind === 'shot' && [command.paths, command.sizes, command.fullPage], [
    [''],
    [{ width: 1920, height: 1080, dpr: 1 }],
    false,
  ]);
});

test('help and version', () => {
  assert.deepEqual(parseCli(['-h']), { kind: 'help' });
  assert.deepEqual(parseCli(['--version']), { kind: 'version' });
});

test('mistakes raise a CliError that says what is wrong', () => {
  assert.throws(() => parseCli(['a:1']), CliError);
  assert.throws(() => parseCli(['a:1', 'b:2', '--bogus']), /Unknown option '--bogus'/);
  assert.throws(() => parseCli(['shot', 'a:1', 'b:2', '--port', '1']), /--port applies only to the live view/);
  assert.throws(() => parseCli(['a:1', 'b:2', '--json']), /--json applies only to ccvd shot/);
  assert.throws(() => parseCli(['a:1', 'b:2', '--port', '0']), /--port must be a whole number from 1 to 65535/);
  assert.throws(() => parseCli(['a:1', 'file:///x']), /Only http and https/);
  assert.throws(() => parseCli(['a:1', 'b:2', '--size', 'huge']), /Unknown size preset: huge/);
});

test('parseSize reads presets, sizes and pixel ratios', () => {
  assert.deepEqual(parseSize('1920x1080'), { width: 1920, height: 1080, dpr: 1 });
  assert.deepEqual(parseSize('440x956@2'), { width: 440, height: 956, dpr: 2 });
  assert.deepEqual(parseSize('tablet@2x'), { width: 768, height: 1024, dpr: 2 });
  assert.throws(() => parseSize('10x10'), /out of range/);
  assert.throws(() => parseSize('800x600@3'), /Unsupported pixel ratio/);
});

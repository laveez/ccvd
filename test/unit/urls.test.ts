import assert from 'node:assert/strict';
import { test } from 'node:test';
import { displayPath, mapUrl, parseBase, pathSlug, resolvePath } from '../../src/urls.ts';

test('parseBase reads host:port as http and keeps full URLs', () => {
  assert.equal(parseBase('localhost:8101').href, 'http://localhost:8101/');
  assert.equal(parseBase('127.0.0.1:8102/2027/').href, 'http://127.0.0.1:8102/2027/');
  assert.equal(parseBase('example.com').href, 'http://example.com/');
  assert.equal(parseBase('https://example.com/a?b#c').href, 'https://example.com/a?b#c');
});

test('parseBase and resolvePath refuse anything but http and https', () => {
  assert.throws(() => parseBase('file:///etc/passwd'), /Only http and https/);
  assert.throws(() => parseBase('javascript:alert(1)'), /Only http and https/);
  assert.throws(() => resolvePath(parseBase('localhost:1'), 'file:///etc/passwd'), /Only http and https/);
  assert.throws(() => parseBase('http://'), /Not a valid address/);
});

test('resolvePath resolves like a link on the base page', () => {
  const base = parseBase('localhost:1/2027/tickets');
  assert.equal(resolvePath(base, 'about').href, 'http://localhost:1/2027/about');
  assert.equal(resolvePath(base, '/2026/').href, 'http://localhost:1/2026/');
  assert.equal(resolvePath(base, '').href, 'http://localhost:1/2027/tickets');
});

test('mapUrl moves a URL to the other side and keeps query and hash', () => {
  const before = parseBase('http://a:1/2027/');
  const after = parseBase('http://b:2/2027/');
  assert.equal(mapUrl('http://a:1/2027/x?q=1#h', before, after), 'http://b:2/2027/x?q=1#h');
  assert.equal(mapUrl('http://a:1/2026/', before, after), 'http://b:2/2026/');
});

test('mapUrl swaps base folders that differ between the sides', () => {
  const before = parseBase('https://example.com/2027/tickets');
  const after = parseBase('http://localhost:8102/');
  assert.equal(mapUrl('https://example.com/2027/about', before, after), 'http://localhost:8102/about');
  assert.equal(mapUrl('https://example.com/2026/', before, after), 'http://localhost:8102/2026/');
});

test('mapUrl leaves other sites alone', () => {
  const before = parseBase('http://a:1/');
  const after = parseBase('http://b:2/');
  assert.equal(mapUrl('https://elsewhere.example/x', before, after), 'https://elsewhere.example/x');
});

test('pathSlug names pages for files', () => {
  const base = parseBase('http://a:1/2027/');
  assert.equal(pathSlug(base, base), 'index');
  assert.equal(pathSlug(resolvePath(base, 'tickets'), base), 'tickets');
  assert.equal(pathSlug(resolvePath(base, 'Hacker Puzzle/?page=2'), base), 'hacker-puzzle-page-2');
  assert.equal(pathSlug(resolvePath(base, '/2026/about'), base), '2026-about');
  assert.equal(pathSlug(resolvePath(base, 'pricing.html'), base), 'pricing');
  assert.equal(pathSlug(resolvePath(base, 'index.php'), base), 'index');
  assert.equal(displayPath(resolvePath(base, 'x?y#z')), '/2027/x?y#z');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffImages } from '../../src/diff.ts';
import { blankImage } from '../../src/png.ts';

const pixel = (image: { width: number; data: Uint8Array }, x: number, y: number) =>
  Array.from(image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4));

test('equal images have no changed pixels and show the before image faded', () => {
  const image = blankImage(2, 1, [200, 100, 0, 255]);
  const result = diffImages(image, blankImage(2, 1, [200, 100, 0, 255]));
  assert.equal(result.changed, 0);
  assert.equal(result.total, 2);
  assert.deepEqual(pixel(result.image, 0, 0), [241, 216, 191, 255]);
});

test('any byte that differs marks its pixel red', () => {
  const before = blankImage(3, 2, [10, 20, 30, 255]);
  const after = blankImage(3, 2, [10, 20, 30, 255]);
  after.data[(1 * 3 + 2) * 4 + 2] = 31;
  const result = diffImages(before, after);
  assert.equal(result.changed, 1);
  assert.deepEqual(pixel(result.image, 2, 1), [255, 0, 0, 255]);
  assert.notDeepEqual(pixel(result.image, 1, 1), [255, 0, 0, 255]);
});

test('a difference in alpha alone counts as a change', () => {
  const result = diffImages(blankImage(1, 1, [9, 9, 9, 255]), blankImage(1, 1, [9, 9, 9, 254]));
  assert.equal(result.changed, 1);
});

test('area that only one image covers counts as changed', () => {
  const result = diffImages(blankImage(2, 2, [0, 0, 0, 255]), blankImage(2, 3, [0, 0, 0, 255]));
  assert.equal(result.image.width, 2);
  assert.equal(result.image.height, 3);
  assert.equal(result.total, 6);
  assert.equal(result.changed, 2);
  assert.deepEqual(pixel(result.image, 1, 2), [255, 0, 0, 255]);
});

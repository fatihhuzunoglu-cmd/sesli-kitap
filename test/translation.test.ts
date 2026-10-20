import { test } from 'node:test';
import assert from 'node:assert/strict';
import { batches, nextIndex } from '../src/lib/translation.ts';

test('translation starts at the page being read, then fills in earlier pages', () => {
  const done = new Set([0, 5, 6]);
  assert.equal(nextIndex(8, done, 5), 7);
  assert.equal(nextIndex(8, new Set([0, 5, 6, 7]), 5), 1);
  assert.equal(nextIndex(3, new Set([0, 1, 2]), 0), null);
  assert.equal(nextIndex(4, new Set(), 9), 0);
});

test('paragraphs are grouped into batches without splitting any paragraph', () => {
  const paras = ['a'.repeat(1200), 'b'.repeat(1200), 'c'.repeat(1200), 'd'.repeat(5000), 'e'];
  const out = batches(paras, 3000);
  assert.deepEqual(out.map((b) => b.length), [2, 1, 1, 1]);
  assert.deepEqual(out.flat(), paras);
});

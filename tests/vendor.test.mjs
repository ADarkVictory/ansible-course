import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marked } from '../vendor/marked.esm.js';

test('marked renders markdown', () => {
  assert.match(marked.parse('# x'), /<h1/);
});

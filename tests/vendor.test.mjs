import { test } from 'node:test';
import assert from 'node:assert/strict';
import yaml from '../vendor/js-yaml.mjs';
import { marked } from '../vendor/marked.esm.js';

test('js-yaml loads YAML', () => {
  assert.equal(yaml.load('a: 1').a, 1);
});

test('marked renders markdown', () => {
  assert.match(marked.parse('# x'), /<h1/);
});

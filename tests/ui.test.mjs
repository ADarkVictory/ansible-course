import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRoute, applyKey, loadProgress, saveProgress, isBanner } from '../ui.js';

test('parseRoute reads #/<module-dir>/<lesson-file>', () => {
  assert.deepEqual(parseRoute('#/01-foundations/02-inventories'), { module: '01-foundations', lesson: '02-inventories' });
});

test('parseRoute gives null for no route or a malformed one', () => {
  for (const h of ['', '#', '#/', '#/01-foundations', '#/a/b/c', '#01-foundations/02-inventories']) assert.equal(parseRoute(h), null, h);
});

test('indent adds two spaces at the start of the line and moves the cursor with it', () => {
  assert.deepEqual(applyKey('a: 1\nb: 2', 7, 7, 'indent'), { text: 'a: 1\n  b: 2', cursor: 9 });
});

test('indent at the very start of the text indents the first line, even when it is empty', () => {
  assert.deepEqual(applyKey('\nb', 0, 0, 'indent'), { text: '  \nb', cursor: 2 });
});

test('indent indents every line of a multi-line selection', () => {
  assert.deepEqual(applyKey('a\nb\nc\nd', 2, 5, 'indent'), { text: 'a\n  b\n  c\nd', cursor: 9 });
});

test('outdent removes up to two leading spaces, never past the line start', () => {
  assert.deepEqual(applyKey('a\n    b', 7, 7, 'outdent'), { text: 'a\n  b', cursor: 5 });
  assert.deepEqual(applyKey('a\n b', 3, 3, 'outdent'), { text: 'a\nb', cursor: 2 });
  assert.deepEqual(applyKey('    b', 1, 1, 'outdent'), { text: '  b', cursor: 0 });
  assert.deepEqual(applyKey('b', 1, 1, 'outdent'), { text: 'b', cursor: 1 });
});

test('outdent works on every line of a multi-line selection', () => {
  assert.deepEqual(applyKey('  a\n    b\nc', 0, 10, 'outdent'), { text: 'a\n  b\nc', cursor: 6 });
});

test('-, : and " insert their character in place of the selection', () => {
  assert.deepEqual(applyKey('ab', 1, 1, '-'), { text: 'a-b', cursor: 2 });
  assert.deepEqual(applyKey('name', 4, 4, ':'), { text: 'name:', cursor: 5 });
  assert.deepEqual(applyKey('xyz', 1, 2, '"'), { text: 'x"z', cursor: 2 });
});

test('{{ }} puts the cursor between the braces with a space each side', () => {
  const r = applyKey('msg: ', 5, 5, '{{ }}');
  assert.equal(r.text, 'msg: {{  }}');
  assert.equal(r.cursor, 8);
  assert.equal(r.text.slice(0, r.cursor), 'msg: {{ ');
  assert.equal(r.text.slice(r.cursor), ' }}');
});

test('loadProgress returns {} when storage throws, is missing, or holds junk', () => {
  const throwing = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); } };
  assert.deepEqual(loadProgress(throwing), {});
  assert.deepEqual(loadProgress(undefined), {});
  assert.deepEqual(loadProgress({ getItem: () => 'not json' }), {});
  assert.deepEqual(loadProgress({ getItem: () => '5' }), {});
  assert.deepEqual(loadProgress({ getItem: () => null }), {});
});

test('saveProgress is a no-op when storage throws, and round-trips through a working storage', () => {
  const throwing = { setItem() { throw new Error('QuotaExceededError'); } };
  assert.doesNotThrow(() => saveProgress(throwing, { a: 1 }));
  assert.doesNotThrow(() => saveProgress(undefined, { a: 1 }));
  const map = new Map();
  const storage = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)) };
  const data = { ex: { 'what-is-ansible-1': { done: true, solutionShown: true } } };
  saveProgress(storage, data);
  assert.deepEqual(loadProgress(storage), data);
});

test('isBanner: text, a space, then a run of * to the end of the line (ansible-core Display.banner)', () => {
  const stars = (n) => '*'.repeat(n);
  for (const line of [
    `PLAY [web] ${stars(69)}`,
    `TASK [Gathering Facts] ${stars(57)}`,
    `RUNNING HANDLER [Restart nginx] ${stars(48)}`,
    `PLAY RECAP ${stars(69)}`,
    // a long task name gets Ansible's minimum of three stars and runs past 80 columns
    `TASK [Install nginx, then configure it, then make sure it is enabled and running on every web host] ${stars(3)}`,
  ]) assert.equal(isBanner(line), true, line);
});

test('isBanner: every other line is not a banner', () => {
  for (const line of ['', 'ok: [web1]', 'changed: [web2]', '***', ' ***', 'TASK [x] *** trailing', 'a * b', 'fatal: [web1]: FAILED! => {"msg": "x ***"}x',
    '        ^ column 7', 'PLAY [web]', 'web1                       : ok=2    changed=1']) assert.equal(isBanner(line), false, JSON.stringify(line));
});

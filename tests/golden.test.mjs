import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as yaml from '../vendor/js-yaml.mjs';

const names = ['yaml-indent', 'yaml-tab', 'empty', 'not-a-list', 'unknown-module', 'unsupported-param',
  'unknown-play-keyword', 'task-keyword-typo', 'yaml-colon', 'yaml-unclosed-quote', 'yaml-dedent', 'yaml-mapping-values',
  'no-action', 'task-not-a-dict', 'hosts-missing', 'run-sample', 'run-sample-second', 'run-no-facts', 'adhoc-ping'];
const golden = (n) => readFileSync(new URL(`./golden/${n}.txt`, import.meta.url), 'utf8');

for (const n of names) test(`golden ${n} exists and is non-empty`, () => assert.ok(golden(n).length > 0));

test('run-sample-second runs no handler', () => assert.doesNotMatch(golden('run-sample-second'), /RUNNING HANDLER/));

test('modules.yaml file.supported appears verbatim in the unsupported-param golden', () => {
  const { supported } = yaml.load(readFileSync(new URL('../modules.yaml', import.meta.url), 'utf8'))['ansible.builtin.file'];
  assert.ok(supported.length > 0);
  assert.ok(golden('unsupported-param').includes(`Supported parameters include: ${supported}`));
});

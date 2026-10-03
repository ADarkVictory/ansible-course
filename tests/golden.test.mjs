import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const names = ['yaml-indent', 'yaml-tab', 'empty', 'not-a-list', 'unknown-module', 'unsupported-param',
  'unknown-play-keyword', 'unknown-task-keyword', 'run-sample', 'run-sample-second', 'run-no-facts', 'adhoc-ping'];
const golden = (n) => readFileSync(new URL(`./golden/${n}.txt`, import.meta.url), 'utf8');

for (const n of names) test(`golden ${n} exists and is non-empty`, () => assert.ok(golden(n).length > 0));

test('run-sample-second runs no handler', () => assert.doesNotMatch(golden('run-sample-second'), /RUNNING HANDLER/));

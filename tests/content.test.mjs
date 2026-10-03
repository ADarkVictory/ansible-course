// Rules every lesson must obey (spec 6). Iterates course.yaml; lessons are added there as they are written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as yaml from '../vendor/js-yaml.mjs';
import { checkChoice, checkCommand, checkWrite } from '../checker.js';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const registry = yaml.load(read('modules.yaml'));
const keywords = yaml.load(read('keywords.yaml'));
const course = yaml.load(read('course.yaml'));

const lessons = course.modules.flatMap((m) => m.lessons.map((l) => {
  const base = `lessons/${m.dir}/${l.file}`;
  return { base, md: `${base}.md`, ex: `${base}.ex.yaml`, exercises: existsSync(new URL(`${base}.ex.yaml`, root)) ? yaml.load(read(`${base}.ex.yaml`)) : [] };
}));
const all = lessons.flatMap((l) => l.exercises.map((e) => ({ ...e, lesson: l })));
// Inventory exercises (kind: inventory) check an inventory file, not a playbook; their own validation arrives with that kind.
const playbook = (e) => e.kind !== 'inventory';
const nonEmpty = (s) => typeof s === 'string' && s.trim() !== '';

test('course.yaml lists lessons, and every lesson has its .md and a parsing .ex.yaml', () => {
  assert.ok(lessons.length > 0);
  for (const l of lessons) {
    assert.ok(existsSync(new URL(l.md, root)), `${l.md} is missing`);
    assert.ok(existsSync(new URL(l.ex, root)), `${l.ex} is missing`);
    assert.ok(Array.isArray(l.exercises) && l.exercises.length > 0, `${l.ex} must be a non-empty list`);
  }
});

test('exercise ids are unique across the course', () => {
  const ids = all.map((e) => e.id);
  assert.ok(ids.every(nonEmpty), 'every exercise needs an id');
  assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), []);
});

test('every exercise has a known type', () => {
  for (const e of all) assert.ok(['write', 'command', 'choice'].includes(e.type), `${e.id}: unknown type ${e.type}`);
});

test('every exercise marker in a lesson names an exercise of that lesson, and each exercise is placed exactly once', () => {
  for (const l of lessons) {
    const placed = [...read(l.md).matchAll(/<!--\s*exercise:\s*(\S+?)\s*-->/g)].map((m) => m[1]);
    const ids = l.exercises.map((e) => e.id);
    assert.deepEqual(placed.filter((id) => !ids.includes(id)), [], `${l.md}: marker names an exercise missing from the .ex.yaml`);
    assert.deepEqual(ids.filter((id) => placed.filter((p) => p === id).length !== 1), [], `${l.md}: exercise not placed exactly once`);
  }
});

test('every write and command exercise has checks, each with a non-empty hint', () => {
  for (const e of all.filter((e) => e.type !== 'choice')) {
    assert.ok(Array.isArray(e.checks) && e.checks.length > 0, `${e.id}: needs checks`);
    e.checks.forEach((c, i) => assert.ok(nonEmpty(c.hint), `${e.id}: check ${i + 1} needs a hint`));
  }
});

test('every check uses only known keys', () => {
  const sub = ['module', 'name'];
  for (const e of all.filter((e) => e.type !== 'choice' && playbook(e))) {
    e.checks.forEach((c, i) => {
      const at = `${e.id}: check ${i + 1}`;
      if (e.type === 'command') return assert.deepEqual(Object.keys(c).filter((k) => !['program', 'pattern', 'module', 'args', 'flags', 'hint'].includes(k)), [], `${at}: unknown key`);
      assert.deepEqual(Object.keys(c).filter((k) => !['play', 'task', 'handler', 'forbid', 'has', 'hint'].includes(k)), [], `${at}: unknown key`);
      const kinds = ['play', 'task', 'handler', 'forbid'].filter((k) => k in c);
      assert.equal(kinds.length, 1, `${at}: needs exactly one of play, task, handler, forbid`);
      if (kinds[0] !== 'play') assert.deepEqual(Object.keys(c[kinds[0]]).filter((k) => !sub.includes(k)), [], `${at}: unknown ${kinds[0]} key`);
    });
  }
});

test('command exercises have an inventory', () => {
  for (const e of all.filter((e) => e.type === 'command')) assert.ok(e.inventory && typeof e.inventory === 'object', `${e.id}: needs an inventory`);
});

test('every output_golden names a file in tests/golden', () => {
  for (const e of all.filter((e) => 'output_golden' in e)) assert.ok(existsSync(new URL(`tests/golden/${e.output_golden}.txt`, root)), `${e.id}: no tests/golden/${e.output_golden}.txt`);
});

test('every wrong entry has code and a valid 1-based fails', () => {
  for (const e of all.filter((e) => e.wrong)) {
    for (const w of e.wrong) {
      assert.ok(typeof w.code === 'string', `${e.id}: wrong entry needs code`);
      assert.ok(Number.isInteger(w.fails) && w.fails >= 1 && w.fails <= (e.checks?.length ?? 0), `${e.id}: fails ${w.fails} is not an index into checks`);
    }
  }
});

const run = (e, code) => e.type === 'write' ? checkWrite(e, code, registry, keywords) : checkCommand(e, code, registry);

test('every write and command solution passes all its checks', () => {
  for (const e of all.filter((e) => e.type !== 'choice' && playbook(e))) {
    const r = run(e, e.solution);
    assert.ok(r.ok, `${e.id}: solution fails${r.failedCheck ? ` check ${r.failedCheck}` : ''}: ${r.hint ?? r.output}`);
  }
});

test('every wrong entry fails at exactly its check', () => {
  for (const e of all.filter((e) => e.type !== 'choice' && playbook(e))) {
    for (const w of e.wrong ?? []) {
      const r = run(e, w.code);
      assert.ok(!r.ok && r.failedCheck === w.fails, `${e.id}: wrong entry expected to fail check ${w.fails}, got ${r.ok ? 'ok' : `check ${r.failedCheck}`}\n${w.code}`);
    }
  }
});

test('every choice has exactly one correct option and every option explains why', () => {
  for (const e of all.filter((e) => e.type === 'choice')) {
    assert.ok(nonEmpty(e.question), `${e.id}: needs a question`);
    assert.equal(e.options.filter((o) => o.correct === true).length, 1, `${e.id}: needs exactly one correct option`);
    e.options.forEach((o, i) => {
      assert.ok(nonEmpty(o.text) && nonEmpty(o.why), `${e.id}: option ${i + 1} needs text and why`);
      assert.equal(checkChoice(e, i).ok, o.correct === true);
    });
  }
});

// Inventory exercises (kind: inventory): the learner writes /home/student/inventory.yml. The output is what
// `ansible-inventory -i inventory.yml --graph` prints for it (tools/capture.sh, tests/golden/inv-*.txt).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import * as yaml from '../vendor/js-yaml.mjs';
import { checkWrite, parseInventory } from '../checker.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const registry = yaml.load(read('../modules.yaml'));
const keywords = yaml.load(read('../keywords.yaml'));
const fixture = (n) => read(`../tools/fixtures/${n}.yml`);
const golden = (n) => read(`./golden/${n}.txt`);
const check = (checks, src) => checkWrite({ id: 'x', type: 'write', kind: 'inventory', checks }, src, registry, keywords);
const TAB_HINT = 'Replace tabs with spaces.';
const CURLY_HINT = 'Your keyboard inserted curly quotes; use straight quotes.';

// Every inv-* fixture: the whole output, byte for byte (warnings, failed plugins, partial inventories, YAML errors).
const stems = readdirSync(new URL('../tools/fixtures/', import.meta.url)).filter((f) => /^inv-.*\.yml$/.test(f)).map((f) => f.slice(0, -4));
test('there are inventory goldens to compare against', () => assert.ok(stems.length >= 15));
for (const n of stems) {
  test(`${n}: output is what ansible-inventory --graph prints`, () => assert.equal(parseInventory(fixture(n)).output, golden(n)));
}

test('the YAML lesson inventory prints the same graph as the INI one', () => {
  assert.equal(golden('inv-lesson'), golden('inventory-lesson'));
});

test('a tab: the real YAML error frame for /home/student/inventory.yml, plus the tab hint', () => {
  const r = parseInventory(fixture('inv-yaml-tab'));
  assert.match(r.output, /^Origin: \/home\/student\/inventory\.yml:4:1$/m);
  assert.equal(r.hint, TAB_HINT);
});

// ---- the inventory check: { group, hosts?, children?, hint } ----------------------------------------------------
const lesson = fixture('inv-lesson'); // all > ungrouped(bastion1), prod > web(web1, web2), db(db1)
const groupChecks = [
  { group: 'prod', children: ['web', 'db'], hint: 'prod holds the groups web and db.' },
  { group: 'web', hosts: ['web2', 'web1'], hint: 'web holds web1 and web2.' },
  { group: 'db', hosts: ['db1'], hint: 'db holds db1.' },
];

test('a right inventory passes, and its output is the real graph', () => {
  const r = check(groupChecks, lesson);
  assert.equal(r.ok, true);
  assert.equal(r.output, golden('inv-lesson'));
  assert.equal(r.hint, undefined);
});

test('groups are found at any depth under all; hosts and children compare as sets', () => {
  assert.equal(check([{ group: 'web', hosts: ['web1', 'web2'], hint: 'h' }], lesson).ok, true);
  assert.equal(check([{ group: 'prod', children: ['db', 'web'], hint: 'h' }], lesson).ok, true);
});

test('all and ungrouped can be checked like any group', () => {
  assert.equal(check([{ group: 'ungrouped', hosts: ['bastion1'], hint: 'h' }, { group: 'all', children: ['ungrouped', 'prod'], hint: 'h' }], lesson).ok, true);
});

test('hosts must match exactly: a missing or an extra host fails that check, with the real graph as output', () => {
  for (const hosts of [['web1'], ['web1', 'web2', 'web3']]) {
    const r = check([groupChecks[2], { group: 'web', hosts, hint: 'web is wrong.' }], lesson);
    assert.deepEqual([r.ok, r.failedCheck, r.hint, r.output], [false, 2, 'web is wrong.', golden('inv-lesson')]);
  }
});

test('children must match exactly; hosts are direct members only', () => {
  assert.equal(check([{ group: 'prod', children: ['web'], hint: 'h' }], lesson).failedCheck, 1);
  assert.equal(check([{ group: 'prod', hosts: ['web1', 'web2', 'db1'], hint: 'h' }], lesson).failedCheck, 1);
  assert.equal(check([{ group: 'prod', hosts: [], hint: 'h' }], lesson).ok, true);
  assert.equal(check([{ group: 'prod', hint: 'h' }], lesson).ok, true);
});

test('a missing group fails its check', () => {
  const r = check([{ group: 'staging', hint: 'Add staging.' }], lesson);
  assert.deepEqual([r.ok, r.failedCheck, r.hint], [false, 1, 'Add staging.']);
});

test('hosts given as a list: Ansible cannot parse the file, so web has no hosts and check 1 speaks over the real output', () => {
  const r = check([{ group: 'web', hosts: ['web1', 'web2'], hint: 'hosts is a mapping.' }], fixture('inv-hosts-list'));
  assert.deepEqual([r.ok, r.failedCheck, r.hint, r.output], [false, 1, 'hosts is a mapping.', golden('inv-hosts-list')]);
});

test('a group only in the partial inventory of a failed parse, not under all, does not count', () => {
  // inv-undefined-child: prod got web as a child, but the parse stopped before prod joined all.
  assert.equal(check([{ group: 'prod', hint: 'h' }], fixture('inv-undefined-child')).failedCheck, 1);
  assert.equal(check([{ group: 'web', hosts: ['web1'], hint: 'h' }], fixture('inv-undefined-child')).ok, false);
});

test('every check passes but Ansible warned or failed to parse: not correct, and no check hint', () => {
  for (const [n, checks] of [
    ['inv-undefined-child', [{ group: 'web', hosts: ['web1'], hint: 'h' }]],
    ['inv-warnings', [{ group: 'db', hosts: ['db1'], hint: 'h' }]],
    ['inv-group-list', [{ group: 'db', hosts: ['db1'], hint: 'h' }]],
  ]) {
    const r = check(checks, fixture(n));
    assert.deepEqual([r.ok, r.failedCheck, r.hint, r.output], [false, undefined, undefined, golden(n)], n);
  }
});

test('a YAML error stops before the checks: real output and the tab hint, no check index', () => {
  const r = check(groupChecks, fixture('inv-yaml-tab'));
  assert.deepEqual([r.ok, r.failedCheck, r.hint, r.output], [false, undefined, TAB_HINT, golden('inv-yaml-tab')]);
  const c = check(groupChecks, fixture('inv-yaml-colon'));
  assert.deepEqual([c.ok, c.failedCheck, c.hint, c.output], [false, undefined, undefined, golden('inv-yaml-colon')]);
});

test('an empty editor: the empty inventory, and check 1 speaks', () => {
  const r = check(groupChecks, '');
  assert.deepEqual([r.ok, r.failedCheck, r.output], [false, 1, golden('inv-empty')]);
});

test('curly quotes in a name: the curly hint, not the check hint', () => {
  const r = check([{ group: 'web', hosts: ['web1'], hint: 'h' }], 'web:\n  hosts:\n    “web1”:\n');
  assert.deepEqual([r.ok, r.hint], [false, CURLY_HINT]);
  assert.match(r.output, /\|--“web1”/);
  assert.equal(check([{ group: 'web', hosts: ['web1'], hint: 'h' }], '# “my” hosts\nweb:\n  hosts:\n    web1:\n').ok, true);
});

test('an unknown check key is an authoring error', () => {
  assert.throws(() => check([{ group: 'web', host: ['web1'], hint: 'h' }], lesson), /unknown check key host/);
});

test('Run again shows the same output (an inventory has no second run)', () => {
  const ex = { id: 'x', type: 'write', kind: 'inventory', checks: groupChecks };
  assert.deepEqual(checkWrite(ex, lesson, registry, keywords, { second: true }), checkWrite(ex, lesson, registry, keywords));
});

// ---- what the engine does not render: no output, and a hint that says so -------------------------------------
test('what the engine cannot render faithfully gives no output and says so', () => {
  for (const [src, re] of [
    ['web:\n  hosts:\n    web[1:3]:\n', /host ranges/],
    ['web:\n  hosts:\n    web1:2222:\n', /host ranges or ports/],
    ['web:\n  hosts:\n    web1:\n      http-port: 8080\n', /variable name 'http-port'/],
    ['web:\n  vars:\n    true: 1\n', /variable name 'true'/],
    ['plugin: constructed\n', /inventory plugins/],
    ['{}\n', /INI/],
    ['web1\n', /INI/],
    ['web:\n  hosts:\n    "":\n', /empty/],
  ]) {
    const r = parseInventory(src);
    assert.equal(r.output, '', src);
    assert.match(r.hint, re, src);
    const c = check([{ group: 'web', hint: 'h' }], src);
    assert.deepEqual([c.ok, c.output, c.failedCheck], [false, '', undefined], src);
  }
});

test('two name clashes: both warnings (real Ansible orders them at random; the engine uses definition order)', () => {
  const out = parseInventory('web:\n  hosts:\n    web1:\ndb:\n  hosts:\n    db1:\nprod:\n  hosts:\n    web:\n    db:\n').output;
  assert.match(out, /^\[WARNING\]: Found both group and host with same name: web\n\[WARNING\]: Found both group and host with same name: db\n@all:\n/);
});

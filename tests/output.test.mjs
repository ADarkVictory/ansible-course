import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as yaml from '../vendor/js-yaml.mjs';
import { parsePlaybook } from '../checker.js';
import { render, resolveHosts } from '../output.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const registry = yaml.load(read('../modules.yaml'));
const keywords = yaml.load(read('../keywords.yaml'));
const inventory = { web: ['web1', 'web2'] }; // tools/fixtures/inventory.ini
const run = (source, opts = {}) => {
  const { plays, error } = parsePlaybook(source, registry, keywords);
  assert.equal(error, undefined);
  return render(plays, inventory, { source, ...opts });
};
const fixture = (n) => read(`../tools/fixtures/${n}.yml`);
const golden = (n) => read(`./golden/${n}.txt`);
const RECAP = (h, ok, changed, failed = 0) =>
  `${h.padEnd(26)} : ok=${String(ok).padEnd(4)} changed=${String(changed).padEnd(4)} unreachable=0    failed=${failed}    skipped=0    rescued=0    ignored=0   \n`;

// Whole-output goldens from real ansible-core 2.21.4 (tools/capture.sh).
for (const [name, n, opts] of [
  ['run-sample: first run', 'run-sample', {}],
  ['run-sample: second run (idempotent modules ok, command still changed, no handler)', 'run-sample', { second: true }],
  ['run-no-facts: no Gathering Facts', 'run-no-facts', {}],
  ['unsupported-param: [ERROR] block with Origin and excerpt, fatal per host, failed=1', 'unsupported-param', {}],
  ['yum-unsupported: yum runs as dnf, so the message names ansible.legacy.dnf', 'yum-unsupported', {}],
  ['invalid-choice: a value outside the module\'s choices, listed in argument-spec order', 'invalid-choice', {}],
  ['invalid-choice-unsupported: choices are checked before unknown parameters, and case-sensitively', 'invalid-choice-unsupported', {}],
  ['raw-params: bare text on a module that takes none fails as Ansible prints it (caused-by block)', 'raw-params', {}],
  ['missing-handler: notify naming no handler stops the run with the real [ERROR]', 'missing-handler', {}],
  ['run-idempotency: unnamed tasks, creates (both forms), changed_when, pre_tasks flush, debug msg/var', 'run-idempotency', {}],
  ['run-idempotency: second run (creates/changed_when ok; still-changed command fires its handler)', 'run-idempotency', { second: true }],
  ['run-intro: the playbook lesson 1 shows', 'run-intro', {}],
  ['run-intro: second run', 'run-intro', { second: true }],
  ['run-no-tasks: a host that runs no task has no recap row', 'run-no-tasks', {}],
  ['run-templates: {{ name }} of play and task variables in names and debug, with Python\'s True', 'run-templates', {}],
  ['invalid-choice-template: a {{ }} value is checked once the play variable is filled in', 'invalid-choice-template', {}],
  ['invalid-choice-bool: a boolean is converted to True before the choices check', 'invalid-choice-bool', {}],
  ['invalid-choice-null: an empty value is None', 'invalid-choice-null', {}],
  ['missing-required: a lone typo leaves path missing; required comes before choices and unsupported', 'missing-required', {}],
  ['mutually-exclusive: comes before required and choices', 'mutually-exclusive', {}],
  ['required-one-of: command with no command', 'required-one-of', {}],
  ['required-if: append needs groups', 'required-if', {}],
  ['required-by: state needs name', 'required-by', {}],
  ['copy-no-src: the copy action plugin fails first ("Action failed:")', 'copy-no-src', {}],
  ['copy-no-dest', 'copy-no-dest', {}],
  ['copy-src-content', 'copy-src-content', {}],
  ['copy-content-dir-dest', 'copy-content-dir-dest', {}],
  ['template-no-src: the template action plugin raises (no "Action failed:")', 'template-no-src', {}],
  ['template-state', 'template-state', {}],
  ['debug-msg-var: debug\'s action plugin checks its arguments (no "changed" in the result)', 'debug-msg-var', {}],
  ['debug-unsupported', 'debug-unsupported', {}],
]) {
  test(name, () => assert.equal(run(fixture(n), opts), golden(opts.second ? `${n}-second` : n)));
}

test('command with creates: changed on the first run, ok on the second', () => {
  const src = '- hosts: web\n  gather_facts: false\n  tasks:\n    - command: touch /tmp/x\n      args:\n        creates: /tmp/x\n';
  assert.match(run(src), /TASK \[command\] \*+\nchanged: \[web1\]\nchanged: \[web2\]\n/);
  assert.match(run(src, { second: true }), /TASK \[command\] \*+\nok: \[web1\]\nok: \[web2\]\n/);
});

test('handlers: only on the first run when only idempotent modules notify them', () => {
  const src = fixture('run-sample');
  assert.match(run(src), /RUNNING HANDLER \[Say hello\]/);
  assert.doesNotMatch(run(src, { second: true }), /RUNNING HANDLER/);
});

test('a failed task stops the play and every later play; notified handlers do not run', () => {
  const src = [
    '- hosts: web', '  gather_facts: false', '  tasks:',
    '    - name: notify', '      command: echo hi', '      notify: h',
    '    - name: bad', '      ansible.builtin.file:', '        path: /tmp/x', '        pathh: /tmp/x',
    '    - name: after', '      ping:',
    '  handlers:', '    - name: h', '      debug: msg=handled',
    '- hosts: web', '  tasks:', '    - ping:', '',
  ].join('\n');
  const out = run(src);
  assert.match(out, /\nTASK \[bad\] \*+\n\[ERROR\]: Task failed: Module failed: Unsupported parameters for \(ansible\.builtin\.file\) module: pathh\. [^\n]+\nOrigin: \/home\/student\/playbook\.yml:7:7\n\n5       command: echo hi\n6       notify: h\n7     - name: bad\n        \^ column 7\n\nfatal: \[web1\]: FAILED! => \{"changed": false, "msg": "Unsupported [^\n]+"\}\nfatal: \[web2\][^\n]+\n\nPLAY RECAP \*+\n/);
  assert.doesNotMatch(out, /after|RUNNING HANDLER|Gathering/);
  assert.ok(out.endsWith(`${RECAP('web1', 1, 1, 1)}${RECAP('web2', 1, 1, 1)}\n`));
});

test('a notified handler with an unsupported parameter fails under RUNNING HANDLER', () => {
  const src = '- hosts: web\n  gather_facts: false\n  tasks:\n    - command: echo\n      notify: hb\n  handlers:\n    - name: hb\n      file: {path: /tmp/x, pathh: 1}\n';
  assert.match(run(src), /\nRUNNING HANDLER \[hb\] \*+\n\[ERROR\]: Task failed: Module failed: Unsupported parameters for \(file\) module: pathh\. [^\n]+\nOrigin: \/home\/student\/playbook\.yml:7:7\n/);
});

test('notify naming no handler: the real error, and the run stops there', () => {
  const src = '- hosts: web\n  gather_facts: false\n  tasks:\n    - name: t\n      command: echo\n      notify: Restart nginxx\n  handlers:\n    - name: Restart nginx\n      debug: msg=x\n';
  assert.equal(run(src), [
    '', `PLAY [web] ${'*'.repeat(69)}`, '', `TASK [t] ${'*'.repeat(71)}`,
    "[ERROR]: The requested handler 'Restart nginxx' was not found in either the main handlers list nor in the listening handlers list", '',
  ].join('\n'));
});

test('host patterns: list order, unmatched pattern warning, all; long names keep three stars', () => {
  const src = [
    '- hosts: [web2, web1]', '  gather_facts: false', '  tasks:', '    - ping:',
    '- hosts: nomatch', '  tasks:', '    - ping:',
    '- hosts: all', '  gather_facts: false', '  tasks:',
    '    - name: A very long task name that goes well beyond the eighty column limit of the terminal ok', '      ansible.builtin.setup:', '',
  ].join('\n');
  assert.equal(run(src), [
    '', `PLAY [web2,web1] ${'*'.repeat(63)}`, '', `TASK [ping] ${'*'.repeat(68)}`, 'ok: [web2]', 'ok: [web1]',
    '[WARNING]: Could not match supplied host pattern, ignoring: nomatch', '',
    `PLAY [nomatch] ${'*'.repeat(65)}`, 'skipping: no hosts matched', '',
    `PLAY [all] ${'*'.repeat(69)}`, '',
    'TASK [A very long task name that goes well beyond the eighty column limit of the terminal ok] ***', 'ok: [web1]', 'ok: [web2]', '',
    `PLAY RECAP ${'*'.repeat(69)}`, RECAP('web1', 2, 0) + RECAP('web2', 2, 0), '',
  ].join('\n'));
});

test('debug: changed_when true shows changed with the msg; dict output has sorted keys', () => {
  const src = '- hosts: web1\n  gather_facts: false\n  vars:\n    d: {b: 1, a: [], c: {}}\n  tasks:\n    - debug: var=d\n      changed_when: true\n';
  assert.match(run(src), /\nchanged: \[web1\] => \{\n {4}"d": \{\n {8}"a": \[\],\n {8}"b": 1,\n {8}"c": \{\}\n {4}\}\n\}\n/);
});

test('file state=touch and service state=restarted change on every run', () => {
  const src = '- hosts: web\n  gather_facts: false\n  tasks:\n    - file: {path: /tmp/t, state: touch}\n    - service: {name: nginx, state: restarted}\n';
  assert.ok(run(src, { second: true }).endsWith(`${RECAP('web1', 2, 2)}${RECAP('web2', 2, 2)}\n`));
});

test('hosts: localhost is the implicit localhost; a partly matched list warns and runs the rest', () => {
  const out = run('- hosts: localhost\n  gather_facts: false\n  tasks:\n    - ping:\n- hosts: [web1, nope]\n  gather_facts: false\n  tasks:\n    - ping:\n');
  assert.equal(out, [
    '', `PLAY [localhost] ${'*'.repeat(63)}`, '', `TASK [ping] ${'*'.repeat(68)}`, 'ok: [localhost]',
    '[WARNING]: Could not match supplied host pattern, ignoring: nope', '', `PLAY [web1,nope] ${'*'.repeat(63)}`, '',
    `TASK [ping] ${'*'.repeat(68)}`, 'ok: [web1]', '', `PLAY RECAP ${'*'.repeat(69)}`, RECAP('localhost', 1, 0) + RECAP('web1', 1, 0), '',
  ].join('\n'));
});

// Host patterns over tools/fixtures/inventory-multi.ini, checked against real `ansible <pattern> --list-hosts` (tests/golden/list-hosts.json).
// (checker-command.test.mjs replays every real --list-hosts pattern through resolveHosts.)
const multi = { web: ['web1', 'web2'], db: ['db1'], prod: ['web1', 'db1'], staging: ['web2'] };

test('resolveHosts: an array of patterns is split element by element (a play with hosts: [web, db:!db1])', () => {
  assert.deepEqual(resolveHosts(['web', 'db:!db1'], multi), { hosts: ['web1', 'web2'], unmatched: [] });
});

test('render: hosts patterns (intersection, exclusion, comma form) and one warning per unmatched pattern per run', () => {
  const { plays, error } = parsePlaybook(fixture('hosts-patterns'), registry, keywords);
  assert.equal(error, undefined);
  assert.equal(render(plays, multi, { source: fixture('hosts-patterns') }), golden('run-hosts-patterns'));
});

test('choices: a value with inventory_hostname differs per host, so it is not checked', () => {
  const task = (state) => `- hosts: web\n  gather_facts: false\n  tasks:\n    - ansible.builtin.file:\n        path: /tmp/x\n        state: ${state}\n`;
  for (const [v, bad] of [['"{{ inventory_hostname }}"', false], ['directory', false], ['Directory', true]]) assert.equal(/\[ERROR\]/.test(run(task(v))), bad, v);
});

test('choices: "True"/"False" match a choice that is the one boolean word among them (module_utils/common/parameters.py)', () => {
  const task = (k, v) => `- hosts: web\n  gather_facts: false\n  tasks:\n    - ansible.builtin.${k}: ${v}\n`;
  assert.doesNotMatch(run(task('apt', 'upgrade=True')), /\[ERROR\]/); // yes is the only true word in dist, full, no, safe, yes
  assert.match(run(task('user', 'name=x update_password=True')), /value of update_password must be one of: always, on_create, got: True/);
});

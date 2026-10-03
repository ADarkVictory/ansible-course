import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as yaml from '../vendor/js-yaml.mjs';
import { parsePlaybook } from '../checker.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const registry = yaml.load(read('../modules.yaml'));
const keywords = yaml.load(read('../keywords.yaml'));
const parse = (src) => parsePlaybook(src, registry, keywords);
const fixture = (n) => read(`../tools/fixtures/${n}.yml`);
const golden = (n) => read(`./golden/${n}.txt`);

const TAB_HINT = 'Replace tabs with spaces.';
const CURLY_HINT = 'Your keyboard inserted curly quotes; use straight quotes.';

// Stripping rule: none. A playbook that fails to parse makes ansible-playbook print only the error
// (no warnings, no inventory noise), so each error golden is compared whole, byte for byte.
const errorGoldens = ['yaml-indent', 'yaml-tab', 'yaml-colon', 'yaml-unclosed-quote', 'yaml-dedent', 'yaml-mapping-values',
  'empty', 'not-a-list', 'unknown-module', 'unknown-play-keyword', 'task-keyword-typo', 'no-action', 'task-not-a-dict',
  'hosts-missing'];

for (const n of errorGoldens) {
  test(`${n}: error is the real ansible-core output`, () => {
    const r = parse(fixture(n));
    assert.equal(r.error, golden(n));
    assert.equal(r.plays, undefined);
  });
}

test('tabs: real error plus the tab hint', () => {
  assert.equal(parse(fixture('yaml-tab')).hint, TAB_HINT);
  assert.equal(parse(fixture('yaml-indent')).hint, undefined);
});

test('curly quotes in otherwise valid YAML: parses (as real Ansible does) but carries the hint', () => {
  for (const q of ['“nginx”', '‘nginx’']) {
    const r = parse(`- hosts: web\n  tasks:\n    - ansible.builtin.dnf:\n        name: ${q}\n`);
    assert.equal(r.error, undefined);
    assert.equal(r.plays[0].tasks[0].args.name, q);
    assert.equal(r.hint, CURLY_HINT);
  }
  assert.equal(parse(fixture('run-sample')).hint, undefined);
});

test('curly quotes that break YAML: the real YAML error plus the curly hint', () => {
  const r = parse('- hosts: web\n  tasks:\n    - ansible.builtin.debug:\n        msg: “a: b”\n');
  assert.match(r.error, /^\[ERROR\]: YAML parsing failed: Colons in unquoted values must be followed by a non-space character\.\n/);
  assert.equal(r.hint, CURLY_HINT);
});

test('unsupported parameter: the task carries the msg from the golden fatal line', () => {
  const fatal = golden('unsupported-param').split('\n').find((l) => l.startsWith('fatal: [web1]'));
  const { msg } = JSON.parse(fatal.slice(fatal.indexOf('{')));
  const r = parse(fixture('unsupported-param'));
  assert.equal(r.error, undefined);
  assert.equal(r.runtimeError, undefined);
  assert.equal(r.plays[0].tasks[0].module, 'ansible.builtin.file');
  assert.equal(r.plays[0].tasks[0].unsupported, msg);
});

test('unsupported parameter: message names the module that ran ("(file)" for a short name, ansible.legacy.copy for copy)', () => {
  const r = parse('- hosts: web\n  tasks:\n    - file:\n        path: /tmp/x\n        pathh: 1\n');
  assert.match(r.plays[0].tasks[0].unsupported, /^Unsupported parameters for \(file\) module: pathh\. Supported parameters include: _diff_peek, /);
  const copy = parse('- hosts: web\n  tasks:\n    - ansible.builtin.copy: {content: x, dest: /tmp/x, bogus: 1}\n');
  assert.match(copy.plays[0].tasks[0].unsupported, /^Unsupported parameters for \(ansible\.legacy\.copy\) module: bogus\. /);
});

test('unsupported parameter: handlers and pre_tasks carry it too', () => {
  const { plays } = parse([
    '- hosts: web',
    '  pre_tasks:',
    '    - file: {path: /tmp/x, pathh: 1}',
    '  tasks:',
    '    - ping:',
    '  handlers:',
    '    - service: {name: nginx, state: restarted, enabeld: true}',
    '',
  ].join('\n'));
  assert.equal(plays[0].pre_tasks[0].unsupported,
    `Unsupported parameters for (file) module: pathh. Supported parameters include: ${registry['ansible.builtin.file'].supported}`);
  // service runs the host's backend module, so the message names it (simulated hosts: systemd).
  assert.equal(plays[0].handlers[0].unsupported,
    `Unsupported parameters for (ansible.legacy.systemd) module: enabeld. Supported parameters include: ${registry['ansible.builtin.service'].supported}`);
  assert.equal('unsupported' in plays[0].tasks[0], false);
});

test('aliases and internal parameters are not unsupported', () => {
  const r = parse('- hosts: web\n  tasks:\n    - file: { dest: /tmp/x, state: directory }\n    - shell: { cmd: uptime, strip_empty_ends: true }\n');
  assert.equal(r.plays[0].tasks.length, 2);
  for (const t of r.plays[0].tasks) assert.equal('unsupported' in t, false);
});

test('a parse error in a later play beats a runtime error in an earlier one', () => {
  const r = parse(`${fixture('unsupported-param')}- hosts: web\n  taks: 1\n`);
  assert.match(r.error, /^\[ERROR\]: 'taks' is not a valid attribute for a Play\n/);
});

test('run-sample parses into plays with FQCN modules, args and keywords', () => {
  assert.deepEqual(parse(fixture('run-sample')), {
    plays: [{
      hosts: 'web',
      handlers: [{ name: 'Say hello', module: 'ansible.builtin.debug', action: 'ansible.builtin.debug', line: 3, col: 7, args: { msg: 'Handler ran' }, keywords: {} }],
      tasks: [
        { name: 'Create a directory', module: 'ansible.builtin.file', action: 'ansible.builtin.file', line: 7, col: 7,
          args: { path: '/tmp/{{ inventory_hostname }}', state: 'directory', mode: '0755' }, keywords: {} },
        { name: 'Write a file', module: 'ansible.builtin.copy', action: 'ansible.builtin.copy', line: 12, col: 7,
          args: { content: 'Hello from {{ inventory_hostname }}\n', dest: '/tmp/{{ inventory_hostname }}/hello.txt', mode: '0644' },
          keywords: { notify: 'Say hello' } },
        { name: 'Run a command', module: 'ansible.builtin.command', action: 'ansible.builtin.command', line: 18, col: 7, args: 'uptime', keywords: {} },
      ],
    }],
  });
});

test('short names expand to FQCN; k=v strings stay raw for Task 4; args keyword merges under module args', () => {
  const { plays } = parse([
    '- hosts: web',
    '  become: yes',
    '  gather_facts: no',
    '  tasks:',
    '    - dnf:',
    '        name: nginx',
    '      when: ansible_os_family == "RedHat"',
    '      register: out',
    '    - copy: src=a dest=b',
    '    - ping:',
    '    - service:',
    '        name: nginx',
    '      args:',
    '        state: started',
    '        name: ignored',
    '',
  ].join('\n'));
  const [play] = plays;
  assert.equal(play.become, true);
  assert.equal(play.gather_facts, false);
  assert.deepEqual(play.handlers, []);
  assert.deepEqual(play.tasks, [
    { module: 'ansible.builtin.dnf', action: 'dnf', line: 5, col: 7, args: { name: 'nginx' }, keywords: { when: 'ansible_os_family == "RedHat"', register: 'out' } },
    { module: 'ansible.builtin.copy', action: 'copy', line: 9, col: 7, args: 'src=a dest=b', keywords: {} },
    { module: 'ansible.builtin.ping', action: 'ping', line: 10, col: 7, args: {}, keywords: {} },
    { module: 'ansible.builtin.service', action: 'service', line: 11, col: 7, args: { state: 'started', name: 'nginx' }, keywords: { args: { state: 'started', name: 'ignored' } } },
  ]);
});

test('odd input never throws', () => {
  for (const src of ['', '   \n', '# only a comment\n', '[]', 'hello', '5', 'true', '-', '- 5', '- true', '- [a]', '- {}',
    '- hosts:\n', '- hosts: [web, 5]\n', '- hosts: web\n  tasks: 5\n', '- hosts: web\n  tasks:\n    - 5\n',
    '- hosts: web\n  tasks:\n    - debug: 5\n', '- hosts: web\n  tasks:\n    - {}\n', '{{', ':::', '- [', '\t', '“', '---\n- hosts: a\n---\n- hosts: b\n',
    '- hosts: web\n  tasks:\n    - name: x\n      debug:\n        msg: {{ foo }}\n', '- &a hosts: *a\n', '- !foo x\n', '\r\n- hosts: web\r\n',
    '- &p {hosts: web, taks: 1}\n- *p\n', '- hosts: web\n  tasks: &t\n    - ping: 5\n- hosts: db\n  tasks: *t\n',
    '- <<: {hosts: web, tasks: [{debug: 5, vars: 1, args: 2}]}\n', '- &q {hosts: web, vars: 5}\n- *q\n']) {
    const r = parse(src);
    assert.ok(typeof r.error === 'string' || Array.isArray(r.plays), JSON.stringify(src));
  }
});

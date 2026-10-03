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
  'hosts-missing', 'tombstone-include', 'tombstone-module', 'hosts-empty', 'hosts-none', 'hosts-invalid', 'hosts-not-list',
  'vars-not-dict', 'task-vars-not-dict', 'action-local-action', 'import-playbook'];

for (const n of errorGoldens) {
  test(`${n}: error is the real ansible-core output`, () => {
    const r = parse(fixture(n));
    assert.equal(r.error, golden(n));
    assert.equal(r.plays, undefined);
  });
}

test('tabs: real error plus the tab hint, only when the line Ansible points at holds the tab', () => {
  assert.equal(parse(fixture('yaml-tab')).hint, TAB_HINT);
  assert.equal(parse(fixture('yaml-indent')).hint, undefined);
  const r = parse('- hosts: "web\t"\n  tasks: [\n');
  assert.match(r.error, /^\[ERROR\]: YAML parsing failed/);
  assert.equal(r.hint, undefined);
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
  assert.equal(r.plays[0].tasks[0].module, 'ansible.builtin.file');
  assert.equal(r.plays[0].tasks[0].unsupported, msg);
});

test('unsupported parameter: message names the module that ran ("(file)" for a short name, ansible.legacy.dnf for yum)', () => {
  const r = parse('- hosts: web\n  tasks:\n    - file:\n        path: /tmp/x\n        pathh: 1\n');
  assert.match(r.plays[0].tasks[0].unsupported, /^Unsupported parameters for \(file\) module: pathh\. Supported parameters include: _diff_peek, /);
  const yum = parse('- hosts: web\n  tasks:\n    - yum: {name: x, bogus: 1}\n');
  assert.match(yum.plays[0].tasks[0].unsupported, /^Unsupported parameters for \(ansible\.legacy\.dnf\) module: bogus\. /);
});

// ---- what the course does not simulate: a hint and no output, never invented Ansible text (final review C1, I2) -----
const notYet = (what) => ({ error: '', hint: `This course doesn't simulate \`${what}\` yet.` });
const pb = (play, task = '') => `- hosts: web\n${play}  tasks:\n    - ansible.builtin.ping:\n${task}`;

test('a play or task keyword the simulator does not model: a hint, never a plain run', () => {
  for (const k of ['vars_files', 'roles', 'serial', 'max_fail_percentage', 'force_handlers', 'collections', 'module_defaults', 'strategy',
    'ignore_errors', 'check_mode', 'run_once', 'vars_prompt', 'no_log']) {
    assert.deepEqual(parse(pb(`  ${k}: x\n`)), notYet(k), k);
  }
  for (const k of ['when', 'failed_when', 'loop', 'with_items', 'ignore_errors', 'run_once', 'check_mode', 'diff', 'no_log', 'until',
    'retries', 'async', 'module_defaults', 'collections', 'any_errors_fatal', 'loop_control']) {
    assert.deepEqual(parse(pb('', `      ${k}: x\n`)), notYet(k), k);
  }
  assert.deepEqual(parse('- hosts: web\n  tasks:\n    - block:\n        - ansible.builtin.ping:\n'), notYet('block'));
});

test('keywords the simulator models, or that cannot change what Ansible prints here, still run', () => {
  const play = '  name: P\n  gather_facts: false\n  become: true\n  become_user: root\n  remote_user: root\n  connection: local\n  port: 22\n'
    + '  tags: [a]\n  environment: {A: b}\n  timeout: 30\n  throttle: 1\n  any_errors_fatal: true\n  vars: {v: 1}\n';
  const task = '      become: true\n      become_user: root\n      register: r\n      tags: x\n      environment: {A: b}\n      timeout: 5\n'
    + '      throttle: 1\n      remote_user: root\n      port: 22\n      connection: local\n      delegate_to: localhost\n      changed_when: false\n';
  assert.ok(Array.isArray(parse(pb(play, task)).plays));
});

test('changed_when other than true or false is an expression the simulator cannot evaluate', () => {
  for (const v of ['false', 'True', 'yes']) assert.ok(Array.isArray(parse(pb('', `      changed_when: ${v}\n`)).plays), v);
  assert.deepEqual(parse(pb('', '      changed_when: "\'x\' in r.stdout"\n')),
    { error: '', hint: "This course doesn't simulate a `changed_when` expression yet; use true or false." });
});

test('templates: only {{ name }} of a variable the play or task sets (or inventory_hostname); anything else is a hint', () => {
  const ok = (src) => assert.ok(Array.isArray(parse(src).plays), src);
  const refused = (src, tpl) => assert.deepEqual(parse(src), { error: '', hint: `This course doesn't simulate \`${tpl}\` yet: it works out only {{ name }} of a variable the play or task sets.` }, src);
  const task = (args, vars = '') => `- hosts: web\n  vars:\n    app: shop\n    nested: "{{ app }}"\n  tasks:\n    - name: t\n      ${args}\n${vars}`;
  ok(task('ansible.builtin.debug: msg="{{ app }} on {{ inventory_hostname }}"'));
  ok(task('ansible.builtin.debug: msg="{{ x }}"', '      vars:\n        x: 1\n'));
  refused(task('ansible.builtin.debug: msg="{{ nope }}"'), '{{ nope }}');
  refused(task('ansible.builtin.debug: msg="{{ app | upper }}"'), '{{ app | upper }}');
  refused(task('ansible.builtin.debug: msg="{{ nested }}"'), '{{ nested }}');
  refused(task('ansible.builtin.file: path=/tmp/{{ nope }} state=directory'), '/tmp/{{ nope }}');
  refused(task('ansible.builtin.ping:\n      notify: "{{ nope }}"'), '{{ nope }}');
  refused(task('ansible.builtin.debug: msg="{% if app %}x{% endif %}"'), '{% if app %}x{% endif %}');
  refused('- name: "P {{ inventory_hostname }}"\n  hosts: web\n  tasks:\n    - ansible.builtin.ping:\n', 'P {{ inventory_hostname }}');
  refused('- hosts: web\n  tasks:\n    - ansible.builtin.ping:\n  handlers:\n    - name: "Restart {{ svc }}"\n      ansible.builtin.ping:\n', 'Restart {{ svc }}');
});

test('debug var= of a variable the playbook does not set, or a reserved variable name: a hint', () => {
  assert.deepEqual(parse(pb('', '').replace('ansible.builtin.ping:', 'ansible.builtin.debug: var=nope')),
    { error: '', hint: "This course doesn't simulate `debug: var=nope` yet: it shows only a variable the play or task sets, with no template in it." });
  assert.ok(Array.isArray(parse(pb('  vars: {d: {a: 1}}\n').replace('ansible.builtin.ping:', 'ansible.builtin.debug: var=d')).plays));
  for (const src of [pb('  vars: {port: 1}\n'), pb('', '      vars: {name: 1}\n'), pb('', '      register: tags\n')]) {
    assert.match(parse(src).hint, /^Ansible reserves the name `(port|name|tags)`/, src);
  }
});

test('a duplicate key in a playbook: a hint (Ansible warns and keeps the last value; the course does not print that warning)', () => {
  assert.deepEqual(parse('- hosts: web\n  tasks:\n    - ansible.builtin.ping:\n  tasks:\n    - ansible.builtin.ping:\n'),
    { error: '', hint: 'Remove the repeated `tasks` key: YAML keeps only its last value, and this course doesn\'t simulate the warning Ansible prints about it.' });
});

test('a key YAML reads as a date: a hint, not an invented YAML error', () => {
  assert.deepEqual(parse('- hosts: web\n  2024-01-01: x\n'), { error: '', hint: 'YAML reads `2024-01-01` as a date, not a name; quote it.' });
});

// ---- module arguments, in ansible-core's order (final review C2) -------------------------------------------------------
const args = (line) => parse(`- hosts: web\n  tasks:\n    - ${line}\n`);
const failure = (line) => args(line).plays[0].tasks[0].unsupported;

test('arguments: mutually exclusive, then required, then choices, then unsupported (module_utils/common/arg_spec.py)', () => {
  assert.equal(failure('ansible.builtin.file: {pathh: /tmp/x}'), 'missing required arguments: path'); // a lone typo
  assert.equal(failure('ansible.builtin.file: {state: bogus, bogus: 1}'), 'missing required arguments: path');
  assert.equal(failure('ansible.builtin.lineinfile: {regexp: a, search_string: b, state: bogus}'), 'parameters are mutually exclusive: regexp|search_string');
  assert.equal(failure('ansible.builtin.dnf: {name: x, list: y, best: true, nobest: true}'), 'parameters are mutually exclusive: name|list, best|nobest');
  assert.equal(failure('ansible.builtin.dnf: {pkg: x, list: y}'), 'parameters are mutually exclusive: name|list'); // aliases count as their option
  assert.equal(failure('ansible.builtin.command: {chdir: /tmp}'), 'one of the following is required: _raw_params, cmd, argv');
  assert.equal(failure('ansible.builtin.command: {cmd: x, argv: [x]}'), 'parameters are mutually exclusive: _raw_params|cmd|argv');
  assert.equal(failure('ansible.builtin.user: {name: x, append: yes}'), 'append is True but all of the following are missing: groups');
  assert.equal(failure('ansible.builtin.user: name=x append=yes'), 'append is True but all of the following are missing: groups');
  assert.equal(failure('ansible.builtin.systemd_service: {state: started}'), "missing parameter(s) required by 'state': name");
  assert.equal(failure('ansible.builtin.service: {enabled: true}'), "missing parameter(s) required by 'enabled': name");
  // defaults count as given: systemd_service needs one of state/enabled/..., and daemon_reload defaults to false
  for (const ok of ['ansible.builtin.systemd_service: {name: x}', 'ansible.builtin.dnf: {state: present}', 'ansible.builtin.user: {name: x, append: no}',
    'ansible.builtin.debug:', 'ansible.builtin.command: echo hi']) assert.equal(failure(ok), undefined, ok);
});

test('choices: a value that is not a string is compared as Ansible converts it (True, None, 7)', () => {
  assert.equal(failure('ansible.builtin.file: {path: /x, state: true}'), 'value of state must be one of: absent, directory, file, hard, link, touch, got: True');
  assert.equal(failure('ansible.builtin.file: {path: /x, state: }'), 'value of state must be one of: absent, directory, file, hard, link, touch, got: None');
  assert.equal(failure('ansible.builtin.file: {path: /x, state: 7}'), 'value of state must be one of: absent, directory, file, hard, link, touch, got: 7');
  assert.equal(failure('ansible.builtin.apt: {name: x, upgrade: true}'), 'parameters are mutually exclusive: deb|package|upgrade');
  assert.equal(failure('ansible.builtin.apt: {upgrade: true}'), undefined); // True is yes, the one true word in its choices
});

test('copy and template: the action plugin checks src, content and dest first (Action failed / raised)', () => {
  const t = (line) => { const [task] = args(line).plays[0].tasks; return [task.unsupported, task.via]; };
  assert.deepEqual(t('ansible.builtin.copy: {dest: /x, bogus: 1}'), ['src (or content) is required', 'action']);
  assert.deepEqual(t('ansible.builtin.copy: {content: x}'), ['dest is required', 'action']);
  assert.deepEqual(t('ansible.builtin.copy: {src: a, content: x, dest: /x}'), ['src and content are mutually exclusive', 'action']);
  assert.deepEqual(t('ansible.builtin.copy: {content: x, dest: /tmp/}'), ['can not use content with a dir as dest', 'action']);
  assert.deepEqual(t('ansible.builtin.template: {dest: /x}'), ['src and dest are required', 'raised']);
  assert.deepEqual(t('ansible.builtin.template: {src: a, dest: /x, state: present}'), ["'state' cannot be specified on a template", 'raised']);
  assert.deepEqual(t('ansible.builtin.debug: {msg: a, var: b}'), ['parameters are mutually exclusive: msg|var', 'debug']);
  // the module's own check after the action plugin also reports the file's checksum, which the course cannot know
  for (const line of ['ansible.builtin.copy: {content: x, dest: /x, bogus: 1}', 'ansible.builtin.template: {src: a, dest: /x, bogus: 1}']) {
    assert.deepEqual(args(line), { error: '', hint: "This course doesn't simulate this copy failure yet: Ansible's message would include the file's checksum." }, line);
  }
});

test('an option and its alias both set, or a required option left empty: a hint', () => {
  assert.deepEqual(args('ansible.builtin.file: {path: /x, dest: /y, state: touch}'), { error: '', hint: 'Set path or its alias dest, not both.' });
  assert.deepEqual(args('ansible.builtin.file: {path: , state: touch}'), { error: '', hint: "This course doesn't simulate an empty `path` yet." });
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
        { name: 'Run a command', module: 'ansible.builtin.command', action: 'ansible.builtin.command', line: 18, col: 7, args: { _raw_params: 'uptime' }, keywords: {} },
      ],
    }],
  });
});

test('short names expand to FQCN; k=v strings become args; args keyword merges under module args', () => {
  const { plays } = parse([
    '- hosts: web',
    '  become: yes',
    '  gather_facts: no',
    '  tasks:',
    '    - dnf:',
    '        name: nginx',
    '      become_user: root',
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
    { module: 'ansible.builtin.dnf', action: 'dnf', line: 5, col: 7, args: { name: 'nginx' }, keywords: { become_user: 'root', register: 'out' } },
    { module: 'ansible.builtin.copy', action: 'copy', line: 9, col: 7, args: { src: 'a', dest: 'b' }, keywords: {} },
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

test('a real module the course does not simulate: a hint, no invented error; a redirect alias resolves; a typo keeps the real error', () => {
  const pb = (m) => `- hosts: web\n  tasks:\n    - ${m}:\n        path: /tmp/x\n`;
  assert.deepEqual(parse(pb('stat')), { error: '', hint: "This course doesn't simulate stat yet." });
  assert.deepEqual(parse(pb('ansible.builtin.raw')), { error: '', hint: "This course doesn't simulate ansible.builtin.raw yet." });
  assert.equal(parse(`- hosts: web\n  tasks:\n    - systemd:\n        name: nginx\n`).plays[0].tasks[0].module, 'ansible.builtin.systemd_service');
  assert.match(parse(pb('stta')).error, /^\[ERROR\]: couldn't resolve module\/action 'stta'/);
});

test('yum (and ansible.builtin.yum) run as dnf; removed names (include) are not a "does not simulate" hint', () => {
  for (const m of ['yum', 'ansible.builtin.yum']) {
    const t = parse(`- hosts: web\n  tasks:\n    - ${m}:\n        name: nginx\n`).plays[0].tasks[0];
    assert.equal(t.module, 'ansible.builtin.dnf');
    assert.equal(t.unsupported, undefined);
  }
  assert.equal(parse(fixture('tombstone-include')).hint, undefined);
});

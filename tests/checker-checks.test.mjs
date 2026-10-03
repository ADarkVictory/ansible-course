import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as yaml from '../vendor/js-yaml.mjs';
import { checkWrite, parsePlaybook } from '../checker.js';
import { render } from '../output.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const registry = yaml.load(read('../modules.yaml'));
const keywords = yaml.load(read('../keywords.yaml'));
const check = (ex, src, opts) => checkWrite(ex, src, registry, keywords, opts);
const tasksOf = (src) => parsePlaybook(src, registry, keywords).plays[0].tasks;
const CURLY_HINT = 'Your keyboard inserted curly quotes; use straight quotes.';

// The spec's handlers-1 exercise (section 3.2).
const handlers1 = {
  id: 'handlers-1',
  type: 'write',
  inventory: { web: ['web1', 'web2'] },
  checks: [
    { task: { module: 'ansible.builtin.template' }, has: { notify: 'Restart nginx' }, hint: 'The template task never tells anything to restart.' },
    { handler: { name: 'Restart nginx', module: 'ansible.builtin.systemd_service' }, has: { state: 'restarted' }, hint: 'The handler must restart nginx.' },
  ],
};
const solution = (handler = 'state: restarted', notify = 'notify: Restart nginx') => [
  '- hosts: web',
  '  become: true',
  '  tasks:',
  '    - name: Deploy nginx.conf',
  '      ansible.builtin.template:',
  '        src: nginx.conf.j2',
  '        dest: /etc/nginx/nginx.conf',
  ...(notify ? [`      ${notify}`] : []),
  '  handlers:',
  '    - name: Restart nginx',
  '      ansible.builtin.systemd_service:',
  '        name: nginx',
  `        ${handler}`,
  '',
].join('\n');
const play = (...lines) => ['- hosts: web', '  gather_facts: false', ...lines, ''].join('\n');
const one = (checks, extra = {}) => ({ id: 'x', type: 'write', inventory: { web: ['web1'] }, checks, ...extra });

test('handlers-1: the solution is ok and its output is the rendered first run', () => {
  const r = check(handlers1, solution());
  assert.equal(r.ok, true);
  assert.equal(r.hint, undefined);
  assert.equal(r.failedCheck, undefined);
  assert.equal(r.output, render(parsePlaybook(solution(), registry, keywords).plays, handlers1.inventory, { source: solution() }));
  assert.match(r.output, /RUNNING HANDLER \[Restart nginx\]/);
});

test('handlers-1: template without notify fails check 1 with its hint, and shows what the playbook really does', () => {
  const src = solution('state: restarted', '');
  const r = check(handlers1, src);
  assert.deepEqual([r.ok, r.failedCheck, r.hint], [false, 1, 'The template task never tells anything to restart.']);
  assert.equal(r.output, render(parsePlaybook(src, registry, keywords).plays, handlers1.inventory, { source: src }));
  assert.match(r.output, /PLAY RECAP/);
  assert.doesNotMatch(r.output, /RUNNING HANDLER/);
});

test('handlers-1: handler with state started fails check 2', () => {
  const r = check(handlers1, solution('state: started'));
  assert.deepEqual([r.ok, r.failedCheck, r.hint], [false, 2, 'The handler must restart nginx.']);
});

test('handlers-1: a wrong notify name is stopped by Ansible itself (no handler by that name), not by the hint', () => {
  const r = check(handlers1, solution('state: restarted', 'notify: Restart nginxx'));
  assert.equal(r.ok, false);
  assert.equal(r.failedCheck, undefined);
  assert.match(r.output, /^\[ERROR\]: The requested handler 'Restart nginxx' was not found/m);
});

test('notify as a one-item list equals the string form', () => {
  const src = solution('state: restarted', 'notify:\n        - Restart nginx');
  assert.equal(check(handlers1, src).ok, true);
});

test('no notify and no handler: the run is fine, so check 1 speaks', () => {
  const src = play('  tasks:', '    - ansible.builtin.template: { src: a, dest: b }');
  assert.equal(check(handlers1, src).failedCheck, 1);
});

test('forbid fails on a task that matches, passes otherwise', () => {
  const ex = one([{ forbid: { module: 'ansible.builtin.shell' }, hint: 'Use a module.' }]);
  const bad = check(ex, play('  tasks:', '    - shell: yum install -y nginx'));
  assert.deepEqual([bad.ok, bad.failedCheck, bad.hint], [false, 1, 'Use a module.']);
  assert.match(bad.output, /TASK \[shell\]/);
  assert.equal(check(ex, play('  tasks:', '    - ansible.builtin.dnf: name=nginx')).ok, true);
});

test('forbid also looks in handlers and pre/post tasks, and short module names resolve to ansible.builtin', () => {
  const ex = one([{ forbid: { module: 'shell' } }]);
  assert.equal(check(ex, play('  tasks:', '    - ping:', '      notify: h', '  handlers:', '    - name: h', '      shell: echo')).failedCheck, 1);
  assert.equal(check(ex, play('  post_tasks:', '    - command: echo')).ok, true);
  assert.equal(check(ex, play('  post_tasks:', '    - ansible.builtin.shell: echo')).failedCheck, 1);
});

test('free-form dnf: name=nginx state=present passes has { name, state } like the mapping form', () => {
  const ex = one([{ task: { module: 'ansible.builtin.dnf' }, has: { name: 'nginx', state: 'present' } }]);
  assert.equal(check(ex, play('  tasks:', '    - ansible.builtin.dnf: name=nginx state=present')).ok, true);
  assert.equal(check(ex, play('  tasks:', '    - ansible.builtin.dnf: name=nginx state=latest')).failedCheck, 1);
  assert.equal(check(ex, play('  tasks:', '    - ansible.builtin.dnf:', '        name: nginx', '        state: present')).ok, true);
});

test('alias pkg for name on package is normalised before the check', () => {
  const ex = one([{ task: { module: 'ansible.builtin.package' }, has: { name: 'nginx' } }]);
  assert.equal(check(ex, play('  tasks:', '    - package: { pkg: nginx }')).ok, true);
  assert.deepEqual(tasksOf(play('  tasks:', '    - ansible.builtin.file: { dest: /tmp/x, state: touch }'))[0].args, { path: '/tmp/x', state: 'touch' });
  assert.deepEqual(tasksOf(play('  tasks:', '    - service: { unit: nginx, state: started }'))[0].args, { name: 'nginx', state: 'started' });
  // k=v spelling too
  assert.deepEqual(tasksOf(play('  tasks:', '    - ansible.builtin.file: dest=/tmp/x state=touch'))[0].args, { path: '/tmp/x', state: 'touch' });
});

test('has compares a k=v string with the boolean or number it converts to; lists of one with their item', () => {
  const ex = one([{ task: { module: 'service' }, has: { enabled: true } }, { task: { module: 'user' }, has: { uid: 1000 } }]);
  assert.equal(check(ex, play('  tasks:', '    - service: name=nginx enabled=yes', '    - user: name=bob uid=1000')).ok, true);
  assert.equal(check(ex, play('  tasks:', '    - service: name=nginx enabled=no', '    - user: name=bob uid=1000')).failedCheck, 1);
  assert.equal(check(ex, play('  tasks:', '    - service: { name: nginx, enabled: yes }', '    - user: { name: bob, uid: 1001 }')).failedCheck, 2);
});

test('has looks in keywords as well as args, on the given keys only', () => {
  const ex = one([{ task: { module: 'command' }, has: { become: true, creates: '/tmp/x' } }]);
  assert.equal(check(ex, play('  tasks:', '    - command: touch /tmp/x creates=/tmp/x', '      become: true')).ok, true);
  assert.equal(check(ex, play('  tasks:', '    - command: touch /tmp/x creates=/tmp/x')).failedCheck, 1);
});

test('task check matches on name too', () => {
  const ex = one([{ task: { module: 'ping', name: 'Check' } }]);
  assert.equal(check(ex, play('  tasks:', '    - name: Check', '      ping:')).ok, true);
  assert.equal(check(ex, play('  tasks:', '    - name: Other', '      ping:')).failedCheck, 1);
});

test('play check: become: true fails when absent, passes when present', () => {
  const ex = one([{ play: { become: true }, hint: 'Run as root.' }]);
  const bad = check(ex, play('  tasks:', '    - ping:'));
  assert.deepEqual([bad.ok, bad.failedCheck, bad.hint], [false, 1, 'Run as root.']);
  assert.equal(check(ex, play('  become: true', '  tasks:', '    - ping:')).ok, true);
  assert.equal(check(ex, play('  become: yes', '  tasks:', '    - ping:')).ok, true);
});

test('an unknown check type is an authoring error, not a silent pass', () => {
  assert.throws(() => check(one([{ wat: {} }]), play('  tasks:', '    - ping:')), /unknown check/);
});

test('fqcn: true rejects copy: with the built-in hint, or the exercise own', () => {
  const ex = one([{ task: { module: 'ansible.builtin.copy' } }], { fqcn: true });
  const src = (m) => play('  tasks:', `    - ${m}: { src: a, dest: b }`);
  const bad = check(ex, src('copy'));
  assert.deepEqual([bad.ok, bad.hint], [false, 'Use the fully qualified collection name, e.g. ansible.builtin.copy.']);
  assert.equal(bad.failedCheck, undefined);
  assert.match(bad.output, /TASK \[copy\]/);
  assert.equal(check(ex, src('ansible.builtin.copy')).ok, true);
  assert.equal(check({ ...ex, fqcn_hint: 'Spell it out.' }, src('copy')).hint, 'Spell it out.');
  // without fqcn the short name is fine
  assert.equal(check({ ...ex, fqcn: false }, src('copy')).ok, true);
  // handlers count
  const h = check(ex, play('  tasks:', '    - ansible.builtin.copy: { src: a, dest: b }', '      notify: h', '  handlers:', '    - name: h', '      debug: msg=x'));
  assert.deepEqual([h.ok, h.hint], [false, 'Use the fully qualified collection name, e.g. ansible.builtin.copy.']);
});

// ---- parse errors and curly quotes ----------------------------------------------------------------------------

test('a parse error is the output, with the hint when there is one', () => {
  const r = check(handlers1, '- hosts: web\n\ttasks: []\n');
  assert.equal(r.ok, false);
  assert.match(r.output, /^\[ERROR\]: YAML parsing failed: Tabs are usually invalid in YAML\./);
  assert.equal(r.hint, 'Replace tabs with spaces.');
  assert.equal(check(handlers1, '').ok, false);
  assert.equal(check(handlers1, '').hint, undefined);
});

test('curly quote in a module argument value (mapping or k=v) fails with the hint and no output', () => {
  const ex = one([{ task: { module: 'dnf' }, has: { name: 'nginx' } }]);
  for (const t of ['    - dnf: { name: “nginx” }', '    - dnf: name=“nginx”', '    - dnf: { name: nginx, state: ‘present’ }']) {
    assert.deepEqual(check(ex, play('  tasks:', t)), { ok: false, output: '', hint: CURLY_HINT });
  }
});

test('curly quote in a keyword value (task, play, vars) fails; in a name or a comment it passes', () => {
  const ex = one([{ task: { module: 'ping' } }]);
  for (const src of [
    play('  tasks:', '    - ping:', '      when: x == “a”'),
    play('  vars: { v: “a” }', '  tasks:', '    - ping:'),
    play('  tasks:', '    - ping:', '  handlers:', '    - debug: msg=“hi”'),
    '- hosts: web\n  gather_facts: false\n  become_user: “root”\n  tasks:\n    - ping:\n',
  ]) assert.deepEqual(check(ex, src), { ok: false, output: '', hint: CURLY_HINT }, src);
  const named = '- hosts: web  # it’s “fine”\n  name: “Quoted” play\n  gather_facts: false\n  tasks:\n    - name: ‘Quoted’ task\n      ping:\n';
  assert.equal(check(ex, named).ok, true);
});

test('curly quotes that break the YAML give the YAML error and the hint', () => {
  const r = check(handlers1, '- hosts: web\n  tasks:\n    - ansible.builtin.debug:\n        msg: “a: b”\n');
  assert.equal(r.ok, false);
  assert.match(r.output, /^\[ERROR\]: YAML parsing failed/);
  assert.equal(r.hint, CURLY_HINT);
});

// ---- crashes and the order of the pipeline --------------------------------------------------------------------

test('an unsupported parameter on a task that runs fails with the real fatal, and no check hint', () => {
  const ex = one([{ task: { module: 'file' }, has: { path: '/tmp/x' }, hint: 'misleading' }]);
  const r = check(ex, play('  tasks:', '    - ansible.builtin.file:', '        path: /tmp/x', '        pathh: /tmp/x'));
  assert.equal(r.ok, false);
  assert.equal(r.hint, undefined);
  assert.equal(r.failedCheck, undefined);
  assert.match(r.output, /Unsupported parameters for \(ansible\.builtin\.file\) module: pathh\./);
  assert.match(r.output, /fatal: \[web1\]: FAILED!/);
});

test('k=v with a rejected parameter is unsupported exactly as the mapping form is', () => {
  const kv = tasksOf(play('  tasks:', '    - ansible.builtin.file: path=/tmp/x pathh=1'))[0];
  const map = tasksOf(play('  tasks:', '    - ansible.builtin.file: { path: /tmp/x, pathh: 1 }'))[0];
  assert.match(kv.unsupported, /^Unsupported parameters for \(ansible\.builtin\.file\) module: pathh\. Supported parameters include: /);
  assert.equal(kv.unsupported, map.unsupported);
  assert.equal(tasksOf(play('  tasks:', '    - file: path=/tmp/x pathh=1'))[0].unsupported.startsWith('Unsupported parameters for (file) module'), true);
  const ex = one([{ task: { module: 'file' }, has: { path: '/tmp/x' } }]);
  const r = check(ex, play('  tasks:', '    - ansible.builtin.file: path=/tmp/x pathh=1'));
  assert.deepEqual([r.ok, r.hint, r.failedCheck], [false, undefined, undefined]);
  assert.match(r.output, /fatal: \[web1\]/);
});

test('free-form command keeps unknown k=v text as the command; shell accepts its inline keys', () => {
  const [c, s] = tasksOf(play('  tasks:', '    - command: echo hi foo=bar creates=/tmp/x', '    - shell: ls chdir=/tmp executable=/bin/sh'));
  assert.deepEqual(c.args, { creates: '/tmp/x', _raw_params: 'echo hi foo=bar' });
  assert.deepEqual(s.args, { chdir: '/tmp', executable: '/bin/sh', _raw_params: 'ls' });
  assert.equal(c.unsupported, undefined);
  assert.equal(s.unsupported, undefined);
});

test('bare text on a module that takes none is rejected by Ansible before it runs', () => {
  const t = tasksOf(play('  tasks:', '    - ansible.builtin.dnf: nginx', '    - file: /tmp/x'));
  assert.equal(t[0].unsupported, "Action 'ansible.builtin.dnf' does not support raw params.");
  assert.equal(t[1].unsupported, "Action 'ansible.builtin.file' does not support raw params.");
  assert.equal(check(one([]), play('  tasks:', '    - ansible.builtin.dnf: nginx')).ok, false);
  // a lone template is a mapping Ansible only sees at run time
  const tpl = tasksOf(play('  tasks:', '    - ansible.builtin.dnf: "{{ pkg_args }}"'))[0];
  assert.equal(tpl.unsupported, undefined);
});

test('an unsupported task that never runs does not block success (handler nobody notifies)', () => {
  const src = play('  tasks:', '    - ping:', '  handlers:', '    - name: h', '      file: { path: /x, pathh: 1 }');
  assert.equal(check(one([{ task: { module: 'ping' } }]), src).ok, true);
});

test('an unsupported task wins over a failing check: the playbook has to run first', () => {
  const ex = one([{ task: { module: 'dnf' }, has: { name: 'nginx' }, hint: 'Install nginx.' }]);
  const r = check(ex, play('  tasks:', '    - ping:', '    - file: { path: /x, pathh: 1 }'));
  assert.equal(r.failedCheck, undefined);
  assert.equal(r.hint, undefined);
  assert.match(r.output, /fatal: \[web1\]/);
});

test('second: the success output is the second run (handlers do not fire again)', () => {
  const plays = parsePlaybook(solution(), registry, keywords).plays;
  const r = check(handlers1, solution(), { second: true });
  assert.equal(r.ok, true);
  assert.equal(r.output, render(plays, handlers1.inventory, { second: true, source: solution() }));
  assert.doesNotMatch(r.output, /RUNNING HANDLER/);
  // a failed check still shows the first run
  assert.match(check(handlers1, solution('state: started'), { second: true }).output, /changed: \[web1\]/);
});

// ---- k=v parsing against ansible-core's own parse_kv --------------------------------------------------------------

// tests/golden/kv.json (tools/gen-kv.py): what real parse_kv returns per input; null where real Ansible refuses to split.
test('k=v strings parse as ansible-core parse_kv does (plain and free-form modules)', () => {
  const rows = JSON.parse(read('./golden/kv.json'));
  assert.ok(rows.length > 25);
  for (const { in: s, kv, freeform } of rows) {
    for (const [module, want] of [['ansible.builtin.copy', kv], ['ansible.builtin.command', freeform]]) {
      const r = parsePlaybook(`- hosts: web\n  tasks:\n    - ${module}: ${JSON.stringify(s)}\n`, registry, keywords);
      if (want === null) assert.match(r.error, /^\[ERROR\]: Error loading tasks: failed at splitting arguments/, s);
      else assert.deepEqual(r.plays[0].tasks[0].args, want, `${module}: ${s}`);
    }
  }
});

test('unbalanced quotes in k=v: the real error, byte for byte', () => {
  const src = read('../tools/fixtures/args-unbalanced-quote.yml');
  assert.equal(parsePlaybook(src, registry, keywords).error, read('./golden/args-unbalanced-quote.txt'));
});

test('the args keyword merges under k=v, and k=v wins', () => {
  const [t] = tasksOf(play('  tasks:', '    - command: touch /tmp/x creates=/tmp/y', '      args:', '        creates: /tmp/z', '        chdir: /tmp'));
  assert.deepEqual(t.args, { creates: '/tmp/y', chdir: '/tmp', _raw_params: 'touch /tmp/x' });
});

test('parsed tasks keep line, col, action and unsupported', () => {
  const [t] = tasksOf(play('  tasks:', '    - copy: src=a dest=b nope=1'));
  assert.deepEqual([t.line, t.col, t.action], [4, 7, 'copy']);
  assert.match(t.unsupported, /nope\./);
});

test('action: string form parses its k=v too, and its unbalanced quotes name the whole string', () => {
  const [t] = tasksOf(play('  tasks:', '    - action: copy src=a dest="b c"'));
  assert.deepEqual([t.action, t.args], ['copy', { src: 'a', dest: 'b c' }]);
  // real 2.21.4: "...unbalanced jinja2 block or quotes: debug msg=\"hello world" (the action string, module name included)
  const r = parsePlaybook(play('  tasks:', '    - action: debug msg="hello world'), registry, keywords);
  assert.match(r.error, /^\[ERROR\]: Error loading tasks: failed at splitting arguments, either an unbalanced jinja2 block or quotes: debug msg="hello world\n/);
});

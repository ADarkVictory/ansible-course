import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as yaml from '../vendor/js-yaml.mjs';
import { checkChoice, checkCommand, parseCommand } from '../checker.js';
import { renderAdhoc } from '../output.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const registry = yaml.load(read('../modules.yaml'));
const golden = (n) => read(`./golden/${n}.txt`);
const web = { web: ['web1', 'web2'] }; // tools/fixtures/inventory.ini
const multi = { web: ['web1', 'web2'], db: ['db1'], prod: ['web1', 'db1'], staging: ['web2'] }; // tools/fixtures/inventory-multi.ini
const ex = (checks, extra = {}) => ({ id: 'x', type: 'command', inventory: multi, checks, ...extra });
const run = (line, extra, checks = []) => checkCommand(ex(checks, extra), line, registry);
const pingCheck = { program: 'ansible', pattern: 'web', module: 'ansible.builtin.ping', hint: 'Ping the web group.' };

test('ansible web -m ping and -m ansible.builtin.ping both pass the check; output is the real ping run', () => {
  for (const line of ['ansible web -m ping', 'ansible web -m ansible.builtin.ping']) {
    const r = checkCommand({ ...ex([pingCheck]), inventory: web }, line, registry);
    assert.deepEqual(r, { ok: true, output: golden('adhoc-ping') });
  }
});

test('a check may name the module by its short name; option order and attached values do not matter', () => {
  for (const line of ['ansible -m ping web', 'ansible web -mping', 'ansible web -m=ping', 'ansible web --module-name=ping', 'ansible web -m command -m ping']) {
    assert.equal(run(line, {}, [{ module: 'ping', pattern: 'web' }]).ok, true, line);
  }
});

test('-a "name=nginx state=present" parses into args; aliases become the canonical name; flags are long names', () => {
  const c = parseCommand('ansible web -m dnf -a "pkg=nginx state=present" -b -u root -i inventory.ini -vv', registry);
  assert.deepEqual(c.args, { name: 'nginx', state: 'present' });
  assert.equal(c.module, 'ansible.builtin.dnf');
  assert.deepEqual(c.flags, { become: true, user: 'root', inventory: ['inventory.ini'], verbose: 2 });
  assert.equal(c.pattern, 'web');
  assert.equal(c.program, 'ansible');
});

test('checks on args and flags are partial matches; the first failing check gives its hint and 1-based index', () => {
  const checks = [
    { module: 'dnf', args: { name: 'nginx', state: 'present' }, hint: 'Install nginx with dnf.' },
    { flags: { become: true }, hint: 'Installing packages needs root: add -b.' },
  ];
  assert.equal(run('ansible web -m dnf -a "name=nginx state=present" -b', {}, checks).ok, true);
  const r = run('ansible web -m dnf -a "name=nginx state=present"', {}, checks);
  assert.equal(r.ok, false);
  assert.equal(r.hint, 'Installing packages needs root: add -b.');
  assert.equal(r.failedCheck, 2);
  assert.equal(run('ansible web -m dnf -a "name=httpd state=present" -b', {}, checks).failedCheck, 1);
});

test('quoted arguments with spaces survive; backslashes escape; single quotes are literal', () => {
  const args = (line, m = 'debug') => parseCommand(`ansible web -m ${m} ${line}`, registry).args;
  assert.deepEqual(args(`-a 'msg="hello world"'`), { msg: 'hello world' });
  assert.deepEqual(args(`-a "msg='a b'"`), { msg: 'a b' });
  assert.deepEqual(args('-a "msg=\\"hi there\\""'), { msg: 'hi there' });
  assert.deepEqual(args('-a echo\\ hello\\ world', 'command'), { _raw_params: 'echo hello world' });
  assert.deepEqual(args('-a "echo hello world"', 'command'), { _raw_params: 'echo hello world' });
  assert.deepEqual(args(`-a ''`, 'command'), {});
  assert.deepEqual(args('-a "a=1" -a "b=2"', 'debug'), { b: '2' });
});

test('-a accepts a JSON mapping, like the real option', () => {
  assert.equal(run(`ansible web -m ping -a '{"data": "a b"}'`).output, golden('adhoc-ping-data'));
});

test('unknown module: the real ad-hoc error, shown with no hint even though it also fails the module check', () => {
  const r = run('ansible web -m ansible.builtin.serivce', {}, [{ module: 'service', hint: 'x' }]);
  assert.deepEqual(r, { ok: false, output: golden('adhoc-unknown-module') });
});

test('real ad-hoc failures: unsupported parameter (short and FQCN), raw params, no argument for command', () => {
  assert.equal(run('ansible web -m ping -a bogus=x').output, golden('adhoc-unsupported-param'));
  assert.equal(run('ansible web -m ansible.builtin.ping -a bogus=x').output, golden('adhoc-unsupported-param-fqcn'));
  assert.equal(run('ansible web -m ping -a hello').output, golden('adhoc-raw-params'));
  assert.equal(run('ansible web').output, golden('adhoc-no-command-arg'));
  assert.equal(run('ansible web -m command -a ""').output, golden('adhoc-no-command-arg'));
  assert.equal(run('ansible nosuch -m shell').output, golden('adhoc-no-hosts-no-arg'));
  for (const line of ['ansible web -m ping -a bogus=x', 'ansible web -m ping -a hello', 'ansible web']) {
    assert.equal(run(line, {}, [{ pattern: 'web' }]).ok, false, `${line} fails in real Ansible, so it is never correct`);
  }
});

test('a .yml pattern with no -a: the real hint about ansible-playbook (.yaml does not get it)', () => {
  assert.equal(run('ansible playbook.yml').output, golden('adhoc-yml-pattern'));
  assert.match(golden('adhoc-yml-pattern'), /module \(did you mean to run ansible-playbook\?\)\n$/);
  const yaml = run('ansible site.yaml').output;
  assert.match(yaml, /No argument passed to command module\n$/);
});

test('a real module the course does not simulate: a hint and no invented error; typos still get the real error', () => {
  for (const m of ['stat', 'raw', 'ansible.builtin.stat', 'ansible.legacy.ping', 'ansible.legacy.stat']) {
    const r = run(`ansible web -m ${m} -a x=1`, {}, [{ module: 'ping', hint: 'h' }]);
    assert.deepEqual(r, { ok: false, output: '', hint: `This course doesn't simulate ${m} yet.` }, m);
  }
  assert.match(run('ansible web -m stta').output, /^\[ERROR\]: Task failed: Cannot resolve 'stta'/);
});

test('yum runs as dnf; include and removed modules print the real removal text; typos keep the resolve error', () => {
  for (const m of ['yum', 'ansible.builtin.yum']) {
    const c = parseCommand(`ansible web -m ${m} -a "name=nginx state=present"`, registry);
    assert.equal(c.module, 'ansible.builtin.dnf');
    assert.equal(run(`ansible web -m ${m} -a "name=nginx"`, {}, [{ module: 'dnf', args: { name: 'nginx' } }]).ok, true);
  }
  assert.equal(run("ansible web -m yum -a 'name=x use_backend=dnf4 bogus=1'").output, golden('adhoc-yum-unsupported'));
  for (const m of ['include', 'ansible.builtin.include', 'ansible.legacy.include']) {
    assert.deepEqual(run(`ansible web -m ${m}`, {}, [{ module: 'ping', hint: 'h' }]), { ok: false, output: golden('adhoc-include-tombstone') }, m);
  }
  assert.match(run('ansible web -m ansible.builtin.bigip_facts').output, /^\[ERROR\]: Task failed: The 'ansible.builtin.bigip_facts' module has been removed[^\n]*\nOrigin: <adhoc 'ansible.builtin.bigip_facts' task>\n/);
  assert.equal(run('ansible web -m bigip_facts').output, golden('adhoc-module-tombstone'));
  assert.equal(run('ansible nosuch -m include').output, golden('adhoc-no-hosts'));
  assert.match(run('ansible web -m ec2_instance').output, /^\[ERROR\]: Task failed: Cannot resolve 'ec2_instance'/);
});

test('a redirect alias resolves to the simulated module (systemd is systemd_service); the error names it as typed', () => {
  const c = parseCommand('ansible web -m systemd -a "name=nginx state=started"', registry);
  assert.equal(c.module, 'ansible.builtin.systemd_service');
  assert.equal(run('ansible web -m systemd -a "name=nginx"', {}, [{ module: 'systemd_service', args: { name: 'nginx' } }]).ok, true);
  assert.equal(run("ansible web -m systemd -a 'name=x bogus=1'").output, golden('adhoc-unsupported-param-redirect'));
});

test('command and shell results use the exercise stdout; empty stdout prints a blank line', () => {
  assert.equal(run('ansible web -m command -a "echo hello"', { stdout: 'hello' }).output, golden('adhoc-command'));
  assert.equal(run('ansible web -m shell -a "echo hi; echo there"', { stdout: 'hi\nthere\n' }).output, golden('adhoc-shell'));
  assert.equal(run('ansible web -m ansible.builtin.command -a true').output, golden('adhoc-command-empty'));
});

test('ping data parameter', () => {
  assert.equal(run('ansible web -m ping -a \'data="a b"\'').output, golden('adhoc-ping-data'));
});

test('pattern matching no host: the real warnings; the pattern check still gives its hint', () => {
  const r = run('ansible nosuch -m ping', {}, [pingCheck]);
  assert.deepEqual(r, { ok: false, output: golden('adhoc-no-hosts'), hint: 'Ping the web group.', failedCheck: 1 });
});

test('--limit: intersects with the pattern; empty and unmatched limits are the real error', () => {
  assert.equal(run("ansible 'web:db' -m ping --limit prod").output, golden('adhoc-limit'));
  assert.equal(run('ansible web -m ping -l db').output, golden('adhoc-limit-empty'));
  assert.equal(run('ansible nosuch -m ping --limit nosuch').output, golden('adhoc-limit-unmatched'));
  assert.equal(run('ansible web -m ping --limit=db1 -l web').output, run('ansible web -m ping').output); // the last -l wins
});

test('--list-hosts prints what real ansible lists, for every pattern captured from it', () => {
  for (const { pattern, output } of JSON.parse(read('./golden/list-hosts.json'))) {
    assert.equal(run(`ansible '${pattern}' --list-hosts`).output, output, pattern);
  }
});

test('renderAdhoc takes parseCommand(...) and the inventory', () => {
  assert.equal(renderAdhoc(parseCommand('ansible web -m ping', registry), web), golden('adhoc-ping'));
});

test('exercise output replaces the generated output on success; failures still show the real run', () => {
  const output = 'web1 | CHANGED => {"x": 1}\n';
  assert.deepEqual(run('ansible web -m ping', { output }, [{ pattern: 'web' }]), { ok: true, output });
  assert.equal(run('ansible db -m ping', { output }, [{ pattern: 'web', hint: 'h' }]).output.startsWith('db1 | SUCCESS'), true);
});

test('options the simulator cannot show (-v, -o, -C, -K, ...): no invented output unless the exercise supplies it', () => {
  assert.deepEqual(run('ansible web -m ping -vvv', {}, [{ pattern: 'db', hint: 'h' }]), { ok: false, output: '', hint: 'h', failedCheck: 1 });
  assert.deepEqual(run('ansible web -m ping -C', { output: 'shown\n' }, [{ pattern: 'web' }]), { ok: true, output: 'shown\n' });
});

test('a program other than ansible is not part of this exercise', () => {
  const r = run('ansible-playbook site.yml', {}, [{ program: 'ansible-playbook', hint: 'h' }]);
  assert.equal(r.ok, false);
  assert.equal(r.output, '');
  assert.match(r.hint, /ansible-playbook/);
  assert.match(r.hint, /not part of this exercise/);
});

test('input mistakes give a hint and no invented Ansible output', () => {
  for (const [line, hint] of [
    ['', /Type a command/],
    ['   ', /Type a command/],
    ['ansible web -m "ping', /quote/],
    ["ansible web -m ping -a 'x", /quote/],
    ['ansible web -m ping -a "msg=“hi”"', /curly quotes; use straight quotes/],
    ['ansible web -m ‘ping’', /curly quotes; use straight quotes/],
    ['ansible -m ping', /host pattern/],
    ['ansible web db -m ping', /one host pattern/],
    ['ansible web -m ping \u2014become', /into a dash; type two hyphens/],
    ['ansible web -m ping \u2013b', /into a dash; type two hyphens/],
    ['ansible web \u2014list-hosts', /into a dash; type two hyphens/],
    ['ansible web -m ping --bogus', /--bogus/],
    ['ansible web -m ping -x', /-x/],
    ['ansible web -m', /-m needs a value/],
    ['ansible web -m ping --limit', /--limit needs a value/],
    ['ansible web --mod=ping', /--mod/], // ansible does not abbreviate long options
    ['ansible web -m ping -a "msg=\\"x"', /quote/],
  ]) {
    const r = run(line, {}, [{ pattern: 'web', hint: 'check hint' }]);
    assert.equal(r.ok, false, line);
    assert.equal(r.output, '', line);
    assert.match(r.hint, hint, line);
  }
});

test('a dash inside a quoted value is just text', () => {
  assert.equal(run('ansible web -m ping -a \'data="a \u2013 b"\'').ok, true);
});

test('an unknown key in a check is a content bug, not a silent pass', () => {
  assert.throws(() => run('ansible web -m ping', {}, [{ modul: 'ping' }]), /unknown check/);
});

test('flags: -bK style clusters, repeated and appended options', () => {
  const c = parseCommand('ansible web -m ping -bk -e a=1 --extra-vars b=2 --limit web1 --become-user=app', registry);
  assert.deepEqual(c.flags, { become: true, 'ask-pass': true, 'extra-vars': ['a=1', 'b=2'], limit: 'web1', 'become-user': 'app' });
});

test('checkChoice returns whether the option is correct, and its why', () => {
  const choice = {
    id: 'c', type: 'choice', question: 'q',
    options: [{ text: 'a', correct: false, why: 'Not a.' }, { text: 'b', correct: true, why: 'Because b.' }, { text: 'c', why: 'Nor c.' }],
  };
  assert.deepEqual(checkChoice(choice, 0), { ok: false, why: 'Not a.' });
  assert.deepEqual(checkChoice(choice, 1), { ok: true, why: 'Because b.' });
  assert.deepEqual(checkChoice(choice, 2), { ok: false, why: 'Nor c.' });
  assert.deepEqual(checkChoice(choice, 7), { ok: false, why: '' });
});

test('hosts check: the hosts the command targets after --limit, in any order, however the pattern is spelt', () => {
  const check = [{ hosts: ['web1'], hint: 'Only the production web servers.' }];
  for (const line of ["ansible 'web:&prod' -m ping", "ansible 'prod:&web' -m ping", "ansible 'web,&prod' -m ping", 'ansible web -m ping --limit prod', 'ansible web1 -m ping']) {
    assert.equal(run(line, {}, check).ok, true, line);
  }
  assert.equal(run("ansible 'db:web' -m ping", {}, [{ hosts: ['web2', 'db1', 'web1'] }]).ok, true);
  for (const line of ["ansible 'web:prod' -m ping", 'ansible web -m ping', 'ansible nosuch -m ping']) {
    assert.deepEqual(run(line, {}, check).failedCheck, 1, line);
  }
});

test('shell operators: an unquoted & | ; < > or a ! outside single quotes is the shell\'s, so a hint and no output', () => {
  for (const [line, hint] of [
    ['ansible web:&prod -m ping', /unquoted &/],
    ['ansible web -m shell -a ss -tln | grep 443', /unquoted \|/],
    ['ansible web -a echo hi; echo there', /unquoted ;/],
    ['ansible web -a echo hi > /tmp/x', /unquoted >/],
    ['ansible web:!db -m ping', /history expansion.*single quotes/],
    ['ansible "web:!db" -m ping', /history expansion.*single quotes/],
    [`ansible web -m shell -a "echo it's" | cat`, /unquoted \|/],
    ['ansible web -m ping -a "data=hi!there"', /history expansion/],
  ]) {
    const r = run(line, {}, [{ pattern: 'web', hint: 'check hint' }]);
    assert.equal(r.ok, false, line);
    assert.equal(r.output, '', line);
    assert.match(r.hint, hint, line);
  }
  // What bash passes through untouched: quoted operators, ! in single quotes or escaped, ! before a blank, = or the closing quote.
  for (const line of ["ansible 'web:&prod' -m ping", 'ansible "web:&prod" -m ping', "ansible 'web:!db' -m ping", 'ansible web:\\!db -m ping',
    "ansible web -m shell -a 'ss -tln | grep 443'", 'ansible web -m shell -a "echo a; echo b > /tmp/x"', 'ansible web -m ping -a "data=hi!"',
    'ansible web -m ping -a "data=a! b"']) {
    assert.equal(parseCommand(line, registry).hint, undefined, line);
  }
  assert.equal(parseCommand('ansible web:\\!db -m ping', registry).pattern, 'web:!db');
});

test('command and shell: a failed check shows no output, as the exercise stdout belongs to the expected command only', () => {
  const ex = { stdout: 'LISTEN 0 511 0.0.0.0:443 0.0.0.0:*' };
  const checks = [{ module: 'shell', hint: 'Pipes need a shell.' }];
  assert.deepEqual(run("ansible web -a 'ss -tln | grep :443'", ex, checks), { ok: false, output: '', hint: 'Pipes need a shell.', failedCheck: 1 });
  assert.match(run("ansible web -m shell -a 'ss -tln | grep :443'", ex, checks).output, /^web1 \| CHANGED \| rc=0 >>\nLISTEN/);
});

test('the ad-hoc lesson: the engine prints what real ansible printed over its inventory (adhoc-lesson-*)', () => {
  const inventory = { web: ['web1', 'web2', 'web3'], db: ['db1', 'db2'], lb: ['lb1'], prod: ['web1', 'web2', 'db1', 'lb1'], staging: ['web3', 'db2'] }; // tools/fixtures/inventory-adhoc.ini
  for (const [stem, line, stdout] of [
    ['adhoc-lesson-ping', 'ansible web -m ping'],
    ['adhoc-lesson-command-pipe', "ansible web -a 'echo hello | tr a-z A-Z'", 'hello | tr a-z A-Z'],
    ['adhoc-lesson-shell-pipe', "ansible web -m shell -a 'echo hello | tr a-z A-Z'", 'HELLO'],
    ['adhoc-lesson-exclude', "ansible 'prod:!db' --list-hosts"],
    ['adhoc-lesson-limit', 'ansible web -m ping --limit staging'],
  ]) assert.equal(checkCommand({ id: 'x', type: 'command', inventory, stdout }, line, registry).output, golden(stem), stem);
});

// ansible-doc (lesson 05): checks over program, the plugin name and options; its output is only ever a captured golden (output_golden).
const doc = (line, checks = [], extra = {}) => checkCommand({ id: 'x', type: 'command', checks, ...extra }, line, registry);
const snippet = [{ program: 'ansible-doc', module: 'systemd_service', flags: { snippet: true }, hint: 'Show the snippet.' }];

test('ansible-doc: the plugin name resolves as ansible-doc resolves it (short, FQCN, ansible.legacy, the systemd twin); options by long name', () => {
  for (const line of ['ansible-doc -s systemd_service', 'ansible-doc --snippet ansible.builtin.systemd_service', 'ansible-doc ansible.builtin.systemd -s',
    'ansible-doc -s ansible.legacy.systemd_service', 'ansible-doc -s systemd', 'ansible-doc --snip systemd_service', 'ansible-doc -t module -s systemd_service']) {
    assert.deepEqual(doc(line, snippet, { output: 'snippet\n' }), { ok: true, output: 'snippet\n' }, line);
  }
  const c = parseCommand('ansible-doc -s ansible.builtin.dnf -v', registry);
  assert.deepEqual([c.program, c.module, c.pattern, c.flags], ['ansible-doc', 'ansible.builtin.dnf', 'ansible.builtin.dnf', { snippet: true, verbose: 1 }]);
});

test('ansible-doc: yum is not dnf (real ansible-doc prints "yum was not found"); another plugin type is not the module', () => {
  const dnf = [{ program: 'ansible-doc', module: 'dnf', hint: 'Look up dnf.' }];
  for (const line of ['ansible-doc -s yum', 'ansible-doc -s ansible.builtin.yum', 'ansible-doc -t lookup -s dnf', 'ansible-doc -s dnf ping', 'ansible-doc -s']) {
    assert.deepEqual(doc(line, dnf, { output: 'x' }), { ok: false, output: '', hint: 'Look up dnf.', failedCheck: 1 }, line);
  }
});

test('ansible-doc -l: the collection filter is the pattern; a failed check shows no output', () => {
  const list = [{ program: 'ansible-doc', flags: { list: true }, hint: 'List them.' }, { pattern: 'ansible.builtin', hint: 'Only ansible.builtin.' }];
  assert.deepEqual(doc('ansible-doc -l ansible.builtin', list, { output: 'list\n' }), { ok: true, output: 'list\n' });
  assert.equal(doc('ansible-doc --list ansible.builtin', list).ok, true);
  assert.equal(doc('ansible-doc -l', list, { output: 'list\n' }).failedCheck, 2);
  assert.equal(doc('ansible-doc -l builtin', list).failedCheck, 2);
  assert.deepEqual(doc('ansible-doc -s ansible.builtin', list, { output: 'list\n' }), { ok: false, output: '', hint: 'List them.', failedCheck: 1 });
});

test('ansible-doc: options it rejects give a hint and no output', () => {
  for (const [line, hint] of [
    ['ansible-doc -s -l ansible.builtin', /one at a time/],
    ['ansible-doc -sl ping', /one at a time/],
    ['ansible-doc -m ping', /ansible-doc does not know the option -m/],
    ['ansible-doc --li ansible.builtin', /--li is ambiguous/], // --list or --list_files
    ['ansible-doc -t', /-t needs a value/],
  ]) {
    const r = doc(line, snippet, { output: 'x' });
    assert.deepEqual([r.ok, r.output, r.failedCheck], [false, '', undefined], line);
    assert.match(r.hint, hint, line);
  }
});

test('long options abbreviate as in argparse: a unique prefix is the option, an ambiguous one is an error', () => {
  assert.deepEqual(parseCommand('ansible web --list-ho --lim=web1', registry).flags, { 'list-hosts': true, limit: 'web1' });
  assert.match(parseCommand('ansible web --mod=ping', registry).hint, /--mod is ambiguous: --module-path, --module-name/);
  assert.match(parseCommand('ansible web --inv x -m ping', registry).hint, /--inv is ambiguous/); // --inventory and its alias --inventory-file
});

test('an ansible line in an exercise with no inventory (an ansible-doc exercise) runs nothing: the program check fails, no output', () => {
  for (const line of ['ansible web -m ping', 'ansible all -m systemd_service -a name=nginx']) {
    assert.deepEqual(doc(line, snippet, { output: 'x' }), { ok: false, output: '', hint: 'Show the snippet.', failedCheck: 1 }, line);
  }
});

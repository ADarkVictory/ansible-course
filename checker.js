// Pure ES module, no DOM: the browser and Node run the same code.
// parsePlaybook turns playbook text into plays, or into the exact error ansible-core 2.21.4 prints for it.
import * as yaml from './vendor/js-yaml.mjs';
import { render, renderAdhoc, renderGraph } from './output.js'; // output.js imports format/excerpt back; both only call each other at run time, so the cycle is harmless.

const PATH = '/home/student/playbook.yml';
const INV = '/home/student/inventory.yml';
const TAB_HINT = 'Replace tabs with spaces.';
const CURLY_HINT = 'Your keyboard inserted curly quotes; use straight quotes.';
const DASH_HINT = 'Your keyboard turned -- into a dash; type two hyphens.';
const TASK_LISTS = new Set(['handlers', 'pre_tasks', 'post_tasks', 'tasks']);
// YAML 1.1 as PyYAML (and so Ansible) resolves it: js-yaml's YAML 1.1 also reads y/n as booleans and 0-led "05:30" as base-60 ints.
const SCHEMA = yaml.YAML11_SCHEMA.withTags(
  { ...yaml.boolYaml11Tag, resolve: (s) => /^[yYnN]$/.test(s) ? yaml.NOT_RESOLVED : yaml.boolYaml11Tag.resolve(s) },
  { ...yaml.intYaml11Tag, resolve: (s) => /^[-+]?0[0-9_]*:/.test(s) ? yaml.NOT_RESOLVED : yaml.intYaml11Tag.resolve(s) },
);

/**
 * @param source   playbook text
 * @param registry parsed modules.yaml
 * @param keywords parsed keywords.yaml ({ play, task, block } from ansible-core)
 * @returns { plays, hint? } | { error, hint? }
 *   Every task's args are a mapping: k=v strings are parsed as Ansible does (free-form modules keep the bare text as `_raw_params`),
 *   the `args` keyword is merged in, and aliases are renamed to the canonical parameter.
 *   A task (in any list) whose parameters real Ansible would reject at run time carries `unsupported: <exact msg>`;
 *   the renderer raises it when the task (or notified handler) runs.
 *   A hint next to plays (curly quotes) means the checker must still fail: real Ansible would run the wrong value.
 */
export function parsePlaybook(source, registry, keywords) {
  const src = String(source).replace(/\r\n?/g, '\n');
  const out = parse(src, registry, keywords);
  if (!out.hint && /[“”‘’]/.test(src)) out.hint = CURLY_HINT;
  return out;
}

// ---- Exercise checks -----------------------------------------------------------------------------------------------
const FQCN_HINT = 'Use the fully qualified collection name, e.g. ansible.builtin.copy.';
const CURLY = /[“”‘’]/;
const fail = (output, hint, failedCheck) => ({ ok: false, output, ...(hint && { hint }), ...(failedCheck && { failedCheck }) });

/**
 * Decides whether a learner's playbook meets a `write` exercise (spec 3.3).
 * @param exercise { inventory, checks: [{ play | task | handler | forbid, has?, hint? }], fqcn?, fqcn_hint? }
 * @param opts     { second?: show the output of running the playbook again }
 * @returns { ok, output, hint?, failedCheck? } failedCheck is the 1-based index into exercise.checks.
 */
export function checkWrite(exercise, source, registry, keywords, opts = {}) {
  if (exercise.kind === 'inventory') return checkInventory(exercise, source);
  const parsed = parsePlaybook(source, registry, keywords);
  if ('error' in parsed) return fail(parsed.error, parsed.hint);
  const { plays } = parsed;
  // YAML takes curly quotes as literal text, so only a value that Ansible would act on makes the answer wrong; a name or comment is fine.
  if (parsed.hint && plays.some(({ name, pre_tasks, tasks, post_tasks, handlers, ...play }) =>
    hasCurly(play) || [pre_tasks, tasks, post_tasks, handlers].flat().some((t) => t && (hasCurly(t.args) || hasCurly(t.keywords))))) {
    return fail('', parsed.hint);
  }

  const first = render(plays, exercise.inventory, { source });
  // A playbook that real Ansible would stop on (unsupported parameter on a task that runs, notify naming no handler)
  // is never correct, and the hint for a check would only mislead: the learner needs that error first.
  // render knows what is reachable, so its [ERROR] block is the test.
  if (/^\[ERROR\]: /m.test(first)) return fail(first);

  const lists = (p) => [p.pre_tasks, p.tasks, p.post_tasks].flatMap((l) => l ?? []);
  const all = plays.flatMap((p) => [...lists(p), ...p.handlers]);
  if (exercise.fqcn && all.some((t) => !t.action.includes('.'))) return fail(first, exercise.fqcn_hint ?? FQCN_HINT);
  const checks = exercise.checks ?? [];
  const i = checks.findIndex((c) => {
    if (c.play) return !plays.some((p) => has(p, c.play));
    if (c.forbid) return all.some((t) => matches(t, c.forbid, c.has));
    if (c.task) return !plays.some((p) => lists(p).some((t) => matches(t, c.task, c.has)));
    if (c.handler) return !plays.some((p) => p.handlers.some((t) => matches(t, c.handler, c.has)));
    throw new Error(`unknown check in exercise ${exercise.id}: ${JSON.stringify(c)}`);
  });
  if (i >= 0) return fail(first, checks[i].hint, i + 1);
  return { ok: true, output: opts.second ? render(plays, exercise.inventory, { second: true, source }) : first };
}

const hasCurly = (v) => typeof v === 'string' ? CURLY.test(v)
  : v !== null && typeof v === 'object' && Object.entries(v).some(([k, x]) => CURLY.test(k) || hasCurly(x));

// A task matches { module, name? } (short module names are ansible.builtin) and carries every key of `want` in its args or keywords.
function matches(task, { module, name }, want) {
  return (module === undefined || task.module === (module.includes('.') ? module : `ansible.builtin.${module}`))
    && (name === undefined || task.name === name)
    && has({ ...task.keywords, ...task.args }, want);
}

const has = (obj, want = {}) => Object.entries(want).every(([k, v]) => Object.hasOwn(obj, k) && same(obj[k], v));

// Deep equality, as lenient as Ansible: one-item lists equal their item (notify: [x] is notify: x), and a k=v string
// ("yes", "1000") equals the boolean or number it converts to.
function same(a, want) {
  const one = (v) => Array.isArray(v) && v.length === 1 ? v[0] : v;
  [a, want] = [one(a), one(want)];
  if (typeof a === 'string' && typeof want === 'boolean') return (want ? /^(1|y|yes|on|t|true)$/i : /^(0|n|no|off|f|false)$/i).test(a);
  if (typeof a === 'string' && typeof want === 'number') return a.trim() !== '' && Number(a) === want;
  if (Array.isArray(a) && Array.isArray(want)) return a.length === want.length && a.every((x, i) => same(x, want[i]));
  if (isMap(a) && isMap(want)) return Object.keys(a).length === Object.keys(want).length && has(a, want);
  return a === want;
}

// ---- Command and choice exercises ------------------------------------------------------------------------------------
// ansible's options (`ansible --help`), as `long|alias|s` names: the first is the long name that `flags` uses. A trailing `=` takes a
// value (`=+`: every occurrence is kept, otherwise the last wins), `*` counts occurrences. Long options are not abbreviated.
const OPTIONS = [
  'become|b', 'become-method=', 'become-user=', 'ask-become-pass|K', 'become-password-file|become-pass-file=', 'inventory|inventory-file|i=+',
  'list-hosts', 'limit|l=', 'flush-cache', 'poll|P=', 'background|B=', 'one-line|o', 'tree|t=', 'private-key|key-file=', 'user|u=',
  'connection|c=', 'timeout|T=', 'ssh-common-args=', 'sftp-extra-args=', 'scp-extra-args=', 'ssh-extra-args=', 'ask-pass|k',
  'connection-password-file|conn-pass-file=', 'check|C', 'diff|D', 'extra-vars|e=+', 'vault-id=+', 'ask-vault-password|ask-vault-pass|J',
  'vault-password-file|vault-pass-file=+', 'forks|f=', 'module-path|M=+', 'playbook-dir=', 'task-timeout=', 'args|a=', 'module-name|m=',
  'verbose|v*', 'version', 'help|h',
];
const BY_FLAG = new Map(OPTIONS.flatMap((spec) => {
  const [, names, kind] = /^([^=*]+)(.*)$/.exec(spec);
  const list = names.split('|');
  return list.map((n) => [n.length === 1 ? `-${n}` : `--${n}`, { name: list[0], kind }]);
}));
// Options that change what ansible prints (verbosity, prompts, check mode, ...) beyond what renderAdhoc shows; with one of them the
// simulator shows no output of its own, only the exercise's `output` on success.
const UNSIMULATED = new Set(['verbose', 'one-line', 'check', 'diff', 'tree', 'background', 'poll', 'ask-become-pass', 'ask-pass',
  'ask-vault-password', 'version', 'help', 'task-timeout']);

// A shell line's words: whitespace separates them; quotes and backslashes only (no $, globs, pipes). undefined: a quote is left open.
function shellWords(line) {
  const words = [];
  let w = null, q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q === "'") { if (c === "'") q = null; else w += c; }
    else if (c === '\\' && (!q || '"\\$`'.includes(line[i + 1] ?? ''))) w = (w ?? '') + (line[++i] ?? '\\');
    else if (c === q) q = null;
    else if (!q && (c === '"' || c === "'")) { q = c; w ??= ''; }
    else if (!q && /\s/.test(c)) { if (w !== null) words.push(w); w = null; }
    else w = (w ?? '') + c;
  }
  if (q) return undefined;
  if (w !== null) words.push(w);
  return words;
}

// argparse's reading of the words after `ansible`: { flags, pos } or { error } (a hint, in the course's words).
function parseArgv(argv) {
  const flags = {}, pos = [];
  const looksLikeOption = (w) => w.length > 1 && w[0] === '-' && !/^-\d/.test(w) && !w.includes(' ');
  const set = ({ name, kind }, value) => {
    if (kind === '*') flags[name] = (flags[name] ?? 0) + 1;
    else if (kind === '=+') (flags[name] ??= []).push(value);
    else flags[name] = kind ? value : true;
  };
  for (let i = 0; i < argv.length; i++) {
    const w = argv[i];
    if (w === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (!looksLikeOption(w)) { pos.push(w); continue; }
    // `--limit x`, `--limit=x`; for short options `-l x`, `-lx`, `-l=x` and clusters such as `-bK` or `-vvv`.
    for (let j = w.startsWith('--') ? 0 : 1; j < w.length; j++) {
      const eq = w.indexOf('=');
      const flag = j === 0 ? (eq < 0 ? w : w.slice(0, eq)) : `-${w[j]}`;
      const opt = BY_FLAG.get(flag);
      if (!opt) return { error: `ansible does not know the option ${flag}.` };
      if (!opt.kind || opt.kind === '*') {
        if (j === 0 && eq >= 0) return { error: `${flag} does not take a value.` };
        set(opt);
        if (j === 0) break;
        continue;
      }
      let value = j === 0 ? (eq < 0 ? undefined : w.slice(eq + 1)) : w.slice(j + 1).replace(/^=/, '') || undefined;
      value ??= looksLikeOption(argv[i + 1] ?? '-') ? undefined : argv[++i];
      if (value === undefined) return { error: `${flag} needs a value.` };
      set(opt, value);
      break;
    }
  }
  if (!pos.length) return { error: 'ansible needs a host pattern, for example: ansible web -m ping' };
  if (pos.length > 1) return { error: 'ansible takes one host pattern; quote it if it contains spaces or special characters.' };
  return { flags, pos };
}

/**
 * A learner's command line as the checks and renderAdhoc see it.
 * @returns { hint } for a line that cannot be run (the hint says why), else
 *   { program, pattern, module, args, flags } for the checks: module is the resolved name (short names are ansible.builtin.*, `command`
 *   when there is no -m), args the canonical parameters of -a, flags the other options by long name (true, a string, an array for
 *   options that repeat, a count for -v);
 *   plus what renderAdhoc prints from: mod (-m as typed), known, typedArgs (-a as typed), noArg, rawParams, unsupported.
 *   Only `ansible` lines are read; other programs arrive with the lessons that need their output.
 */
export function parseCommand(line, registry) {
  if (CURLY.test(line)) return { hint: CURLY_HINT };
  const words = shellWords(String(line));
  if (!words) return { hint: 'Close the quote you opened.' };
  if (!words.length) return { hint: 'Type a command.' };
  if (words.some((w) => /^[\u2013\u2014]/.test(w))) return { hint: DASH_HINT }; // iOS Smart Punctuation: -- becomes an em dash, - an en dash
  const [program, ...argv] = words;
  if (program !== 'ansible') return { program, hint: `"${program}" is not part of this exercise; use the ansible command.` };
  const { flags, pos, error } = parseArgv(argv);
  if (error) return { program, hint: error };
  const { 'module-name': mod = 'command', args: text = '', ...rest } = flags;
  const { module, spec, real, twin, tombstone } = lookup(mod, registry);
  if (real && !spec && !tombstone) return { program, hint: notSimulated(mod) };
  let typed = {};
  if (text) {
    let json;
    try { json = JSON.parse(text); } catch { /* not JSON: k=v */ }
    typed = isMap(json) ? json : parseKv(text, spec?.freeform);
    if (!typed) return { program, hint: 'The quotes in -a do not balance: close every quote you open.' };
  }
  const rawParams = Boolean(spec && '_raw_params' in typed && !spec.freeform);
  return {
    program, pattern: pos[0], module, args: spec ? normalise(spec, { ...typed }) : { ...typed }, flags: rest,
    mod, known: real, tombstone, typedArgs: typed, rawParams,
    noArg: !text && (module === 'ansible.builtin.command' || module === 'ansible.builtin.shell'),
    unsupported: spec && !rawParams ? unsupportedMsg(spec, mod, typed, twin) : undefined,
  };
}

/**
 * Decides whether a learner's command meets a `command` exercise.
 * @param exercise { inventory, checks: [{ program?, pattern?, module?, args?, flags?, hint? }], stdout?, output? }
 *                 a check passes when every key it names matches (args and flags: the keys it names); `stdout` is what a command
 *                 or shell module prints; `output` replaces the generated output on success (modules the simulator cannot run).
 * @returns { ok, output, hint?, failedCheck? } failedCheck is the 1-based index into exercise.checks.
 */
export function checkCommand(exercise, line, registry) {
  const cmd = parseCommand(line, registry);
  if (cmd.hint) return fail('', cmd.hint);
  const shown = Object.keys(cmd.flags).some((f) => UNSIMULATED.has(f)) ? '' : renderAdhoc(cmd, exercise.inventory, { stdout: exercise.stdout });
  // A command real Ansible stops on is never correct, and a check's hint would only mislead: the learner needs that error first.
  if (/^\[ERROR\]: /m.test(shown)) return fail(shown);
  const checks = exercise.checks ?? [];
  const canonical = (m) => m.includes('.') ? m : `ansible.builtin.${m}`;
  const i = checks.findIndex((c) => {
    const bad = Object.keys(c).find((k) => !['program', 'pattern', 'module', 'args', 'flags', 'hint'].includes(k));
    if (bad) throw new Error(`unknown check ${bad} in exercise ${exercise.id}: ${JSON.stringify(c)}`);
    return !((c.program ?? cmd.program) === cmd.program && (c.pattern ?? cmd.pattern) === cmd.pattern
      && canonical(c.module ?? cmd.module) === cmd.module && has(cmd.args, c.args) && has(cmd.flags, c.flags));
  });
  if (i >= 0) return fail(shown, checks[i].hint, i + 1);
  return { ok: true, output: exercise.output ?? shown };
}

/** The chosen option's verdict and explanation: { ok, why }. */
export function checkChoice(exercise, index) {
  const option = exercise.options[index];
  return { ok: option?.correct === true, why: option?.why ?? '' };
}

// YAML text as Ansible's loader reads it: { data, tree } or { error, hint? } (the YAML error frame naming `path`).
function load(src, path = PATH) {
  let events, tree, docs;
  try {
    events = yaml.parseEvents(src);
    tree = nodeTree(src, events);
    // json: true lets a later duplicate key win, as PyYAML does. tree.dups holds the duplicates (Ansible warns about each).
    // ponytail: playbooks do not print that warning yet; inventories do.
    docs = yaml.constructFromEvents(events, { schema: SCHEMA, json: true, source: src });
  } catch (e) {
    if (!(e instanceof yaml.YAMLException)) throw e;
    return { error: yamlError(src, e, tree, path), ...(src.includes('\t') && { hint: TAB_HINT }) };
  }
  if (docs.length > 1) {
    // ponytail: libyaml points at the second "---"; a second document opened without "---" falls back to line 1.
    const starts = [...src.matchAll(/^---(?=\s|$)/gm)].map((m) => m.index);
    const pos = starts[events[0].explicitStart ? 1 : 0] ?? 0;
    return { error: yamlFormat(src, 'Expected a single document in the stream but found another document.', ...lineCol(src, pos), path) };
  }
  return { data: docs[0] ?? null, tree };
}

// ---- Inventory exercises (kind: inventory) -------------------------------------------------------------------------
// The learner writes /home/student/inventory.yml. What they see is what `ansible-inventory -i inventory.yml --graph` prints:
// ansible-core tries the auto, yaml and ini inventory plugins in turn. When yaml parses the file, the other failures stay
// silent; when none does, all three failures are printed and the run goes on with whatever the yaml plugin had added before
// it stopped (nothing is rolled back, and groups are not attached to `all`). Ported from plugins/inventory/yaml.py,
// inventory/data.py and inventory/group.py; goldens: tests/golden/inv-*.txt.
// ponytail: keys are read as strings (a group or host YAML reads as a number, boolean or null is not simulated, nor are
// integer-like names, which JS objects order first); several group/host name clashes warn in definition order, where
// real Ansible's order varies from run to run; ansible_group_priority values and duplicate localhost entries are not checked.
const INVALID_GROUP_CHARS = /^\p{Nd}|[^\p{L}\p{N}_]/u; // C.INVALID_VARIABLE_NAMES, Unicode-aware as in Python
const NOT_SIMULATED_INI = 'Ansible would read this file as an INI inventory, which this course doesn\'t simulate here. Write the inventory in YAML.';
class Unsupported { constructor(hint) { this.hint = hint; } }
class ParseFailure { constructor(msg) { this.msg = msg; } }
// utils/vars.py validate_variable_name; an invalid name makes Ansible print a deprecation warning the course does not reproduce.
const checkVar = (name) => {
  if (!/^[A-Za-z_]\w*$/.test(name) || ['False', 'None', 'True', 'false', 'none', 'not', 'true'].includes(name)) {
    throw new Unsupported(`This course doesn't simulate Ansible's warning about the variable name '${name}'. Variable names use only letters, digits and underscores, and start with a letter or underscore.`);
  }
};

/**
 * @returns { output, groups, hint?, yamlError?, unsupported? }
 *   output: what ansible-inventory --graph prints ('' when the course cannot reproduce it; hint then says why);
 *   groups: Map name → { hosts: [names], children: [names], parents: [names] }, the inventory Ansible ends up with;
 *   yamlError: the file is not valid YAML; hint: tabs, curly quotes, or what is not simulated.
 */
export function parseInventory(source) {
  const src = String(source).replace(/\r\n?/g, '\n');
  const loaded = load(src, INV);
  const groups = new Map(), hosts = new Map(); // host → Set of the groups it is directly in
  let out = '';
  const warned = new Set(); // Display.warning prints a given message once
  const warn = (msg) => { if (!warned.has(msg)) { warned.add(msg); out += `[WARNING]: ${msg}\n`; } };
  const ancestors = (g, seen = new Set()) => {
    for (const p of groups.get(g).parents) if (!seen.has(p)) { seen.add(p); ancestors(p, seen); }
    return seen;
  };
  const addGroup = (name) => {
    if (groups.has(name)) return;
    if (INVALID_GROUP_CHARS.test(name)) warn('Invalid characters were found in group names but not replaced, use -vvvv to see details');
    groups.set(name, { hosts: [], children: [], parents: [] });
  };
  const addChild = (parent, child) => { // InventoryData.add_child
    const g = groups.get(parent);
    if (groups.has(child)) {
      if (parent === child) throw new ParseFailure("can't add group to itself");
      if (g.children.includes(child)) return;
      if (ancestors(parent).has(child)) throw new ParseFailure(`Adding group '${child}' as child to '${parent}' creates a recursive dependency loop.`);
      g.children.push(child);
      if (!groups.get(child).parents.includes(parent)) groups.get(child).parents.push(parent);
    } else if (hosts.has(child)) {
      if (!g.hosts.includes(child)) { g.hosts.push(child); hosts.get(child).add(parent); }
    } else throw new ParseFailure(`${child} is not a known host nor group`);
  };
  // yaml.py InventoryModule._parse_group
  const parseGroup = (name, data) => {
    if (!(isMap(data) || data === null)) {
      warn(`Skipping '${name}' as this is not a valid group definition`);
      return name;
    }
    addGroup(name);
    if (data === null) return name;
    for (const section of ['vars', 'children', 'hosts'].filter((k) => k in data)) {
      if (typeof data[section] === 'string') data[section] = { [data[section]]: null };
      if (!(isMap(data[section]) || data[section] === null)) {
        throw new ParseFailure(`Invalid "${section}" entry for "${name}" group, requires a dictionary, found "${pyType(data[section])}" instead.`);
      }
    }
    for (const [key, value] of Object.entries(data)) {
      if (value instanceof Date) throw new Unsupported('This course doesn\'t simulate dates in an inventory yet.');
      if (!(isMap(value) || value === null)) {
        warn(`Skipping key (${key}) in group (${name}) as it is not a mapping, it is a ${pyType(value)}`);
        continue;
      }
      if (value === null) continue;
      if (key === 'vars') Object.keys(value).forEach(checkVar);
      else if (key === 'children') for (const [sub, d] of Object.entries(value)) addChild(name, parseGroup(sub, d));
      else if (key === 'hosts') {
        for (const [host, d] of Object.entries(value)) {
          if (host === '') throw new Unsupported('This course doesn\'t simulate an empty host name; give every host a name.');
          if (/[[\]:]/.test(host)) throw new Unsupported('This course doesn\'t simulate host ranges or ports in inventory host names yet.');
          const vars = pyFalsy(d) ? {} : d;
          if (!isMap(vars)) throw new ParseFailure(`Invalid data from file, expected dictionary and got:\n\n${pyStr(vars)}`);
          if (!hosts.has(host)) hosts.set(host, new Set());
          const g = groups.get(name); // InventoryData.add_host: a host, even where a group has the same name
          if (!g.hosts.includes(host)) { g.hosts.push(host); hosts.get(host).add(name); }
          Object.keys(vars).forEach(checkVar);
        }
      } else warn(`Skipping unexpected key (${key}) in group (${name}), only "vars", "children" and "hosts" are valid`);
    }
    return name;
  };
  // yaml.py InventoryModule.parse: undefined when it parsed the file, else why it failed.
  const yamlPlugin = (data) => {
    if (pyFalsy(data)) return 'Parsed empty YAML file';
    if (!isMap(data)) return `YAML inventory has invalid structure, it should be a dictionary, got: ${pyType(data)}`;
    try {
      for (const [name, d] of Object.entries(data)) parseGroup(name, d);
    } catch (e) {
      if (e instanceof ParseFailure) return e.msg;
      throw e;
    }
  };
  const reconcile = () => { // InventoryData.reconcile_inventory
    for (const name of groups.keys()) if (name !== 'all' && !ancestors(name).size) addChild('all', name);
    for (const [host, direct] of hosts) {
      const ungrouped = groups.get('ungrouped');
      if (direct.has('ungrouped')) {
        if ([...direct].some((g) => g !== 'all' && g !== 'ungrouped')) { ungrouped.hosts.splice(ungrouped.hosts.indexOf(host), 1); direct.delete('ungrouped'); }
      } else if ([...direct].every((g) => g === 'all')) addChild('ungrouped', host);
    }
    for (const name of groups.keys()) if (hosts.has(name)) warn(`Found both group and host with same name: ${name}`);
  };
  const failed = (plugin, msg, detail) =>
    `[WARNING]: Failed to parse inventory with '${plugin}' plugin: ${msg}\n\nFailed to parse inventory with '${plugin}' plugin.\n\n<<< caused by >>>\n\n${detail}\n\n`;
  const pluginOrigin = (plugin) => `Origin: <inventory plugin '${plugin}' with source '${INV}'>`;

  try {
    addGroup('all');
    addGroup('ungrouped');
    addChild('all', 'ungrouped');
    let auto, yamlMsg;
    if ('error' in loaded) {
      const frame = loaded.error.slice('[ERROR]: '.length).trimEnd();
      yamlMsg = frame.split('\n')[0];
      auto = [yamlMsg, frame]; // the auto plugin loads the file first, so its failure carries the YAML error frame
    } else {
      for (const d of loaded.tree.dups) {
        out += `[WARNING]: Found duplicate mapping key ${pyRepr(d.str)}.\n${excerpt(src, ...lineCol(src, d.pos), INV)}\n\nUsing last defined value only.\n\n`;
      }
      if (isMap(loaded.data) && !pyFalsy(loaded.data.plugin ?? null)) throw new Unsupported('This course doesn\'t simulate inventory plugins yet.');
      const msg = `no root 'plugin' key found, '${INV}' is not a valid YAML inventory plugin config file`;
      auto = [msg, `${msg}\n${pluginOrigin('auto')}`];
      yamlMsg = yamlPlugin(loaded.data);
    }
    const ini = yamlMsg === undefined ? undefined : iniFailure(src);
    if (ini === undefined) reconcile(); // parsed by yaml, or by ini as an empty inventory (a file of comments and blank lines)
    else {
      for (const host of ini.hosts) { // what the ini plugin added before it failed stays, in ungrouped
        if (!hosts.has(host)) hosts.set(host, new Set());
        if (!groups.get('ungrouped').hosts.includes(host)) { groups.get('ungrouped').hosts.push(host); hosts.get(host).add('ungrouped'); }
      }
      const iniMsg = `Failed to parse inventory: ${ini.msg}`;
      out += failed('auto', ...auto) + failed('yaml', yamlMsg, `${yamlMsg}\n${pluginOrigin('yaml')}`) + failed('ini', iniMsg, `${iniMsg}\nOrigin: ${INV}`)
        + `[WARNING]: Unable to parse ${INV} as an inventory source\n[WARNING]: No inventory was parsed, only implicit localhost is available\n`;
    }
    const curly = CURLY.test(src) && ('error' in loaded || hasCurly(loaded.data));
    const hint = loaded.hint ?? (curly ? CURLY_HINT : undefined);
    return { output: out + renderGraph(groups), groups, ...(hint && { hint }), ...('error' in loaded && { yamlError: true }) };
  } catch (e) {
    if (e instanceof Unsupported) return { output: '', groups, hint: e.hint, unsupported: true };
    throw e;
  }
}

// How the ini plugin fails on this text (plugins/inventory/ini.py): { msg, hosts } with the hosts it had added to ungrouped by
// then, or undefined for a file of blank and comment lines (ini parses that as an empty inventory). Throws Unsupported when
// ini would parse the file (an INI inventory, which the course does not simulate) or reach what is not simulated here.
function iniFailure(src) {
  const hosts = [];
  for (const raw of src.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '#' || line[0] === ';') continue;
    if (/^\[[^:\]\s]+(?::\w+)?\]\s*(?:#.*)?$/.test(line)) throw new Unsupported(NOT_SIMULATED_INI); // a [section]
    if (line.startsWith('[') && line.endsWith(']')) {
      return { hosts, msg: `Invalid section entry: '${line}'. Please make sure that there are no spaces in the section entry, and that there are no other invalid characters` };
    }
    if (/["'\\]/.test(line)) throw new Unsupported(NOT_SIMULATED_INI); // ponytail: shlex quoting is not simulated
    const [host, ...rest] = line.replace(/#.*/, '').split(/\s+/).filter(Boolean); // shlex.split(comments=True), unquoted
    if (host.includes('[')) throw new Unsupported(NOT_SIMULATED_INI); // host ranges
    if (host.endsWith(':')) return { hosts, msg: `Invalid host pattern '${host}' supplied, ending in ':' is not allowed, this character is reserved to provide a port.` };
    if (host === '---') return { hosts, msg: "Invalid host pattern '---' supplied, '---' is normally a sign this is a YAML file." };
    const bad = rest.find((t) => !t.includes('='));
    if (bad !== undefined) return { hosts, msg: `Expected key=value host variable assignment, got: ${bad}` };
    if (host.includes(':')) throw new Unsupported(NOT_SIMULATED_INI); // a port
    rest.forEach((t) => checkVar(t.slice(0, t.indexOf('='))));
    hosts.push(host);
  }
  if (hosts.length) throw new Unsupported(NOT_SIMULATED_INI);
  return undefined;
}

/**
 * Decides whether a learner's inventory meets a `kind: inventory` write exercise.
 * @param exercise { checks: [{ group, hosts?, children?, hint }] } a check passes when `group` is reachable from `all` and
 *                 directly holds exactly `hosts` and exactly the child groups `children` (each compared as a set, when given)
 * @returns { ok, output, hint?, failedCheck? } like checkWrite. The checks run on the inventory Ansible ended up with, even after
 *          it failed to parse the file; an inventory Ansible warned about is never correct, but a failing check speaks first.
 */
function checkInventory(exercise, source) {
  const inv = parseInventory(source);
  if (inv.hint) return fail(inv.output, inv.hint);
  if (inv.yamlError) return fail(inv.output);
  const reachable = new Set();
  const walk = (g) => { if (!reachable.has(g)) { reachable.add(g); inv.groups.get(g).children.forEach(walk); } };
  walk('all');
  const same = (have, want) => have.length === want.length && want.every((x) => have.includes(String(x)));
  const checks = exercise.checks ?? [];
  const i = checks.findIndex((c) => {
    const bad = Object.keys(c).find((k) => !['group', 'hosts', 'children', 'hint'].includes(k));
    if (bad) throw new Error(`unknown check key ${bad} in exercise ${exercise.id}: ${JSON.stringify(c)}`);
    const g = reachable.has(c.group) && inv.groups.get(c.group);
    return !g || (c.hosts && !same(g.hosts, c.hosts)) || (c.children && !same(g.children, c.children));
  });
  if (i >= 0) return fail(inv.output, checks[i].hint, i + 1);
  if (/^\[WARNING\]/m.test(inv.output)) return fail(inv.output);
  return { ok: true, output: inv.output };
}

function parse(src, registry, kw) {
  const loaded = load(src);
  if ('error' in loaded) return loaded;
  const { data, tree } = loaded;
  const err = (msg, ctx, help) => ({ error: format(msg, ctx, help) });
  const at = (node) => excerpt(src, ...lineCol(src, node.pos));
  const ctx = (value, node) => value === null ? undefined
    : typeof value === 'boolean' || !node || node.pos < 0 ? `Origin: <unknown>\n\n${shorten(pyStr(value))}` : at(node);

  const root = tree.items[0]?.items[0];
  if (data === null) return err(`Empty playbook, nothing to do: ${PATH}`);
  if (!Array.isArray(data)) {
    // Real 2.21.4 shows no line for a top-level number.
    return err(`A playbook must be a list of plays, got a ${pyType(data)} instead: ${PATH}`, typeof data === 'number' ? `Origin: ${PATH}` : ctx(data, root));
  }
  if (!data.length) return err(`A playbook must contain at least one play: ${PATH}`);

  const plays = [];
  for (const [pi, ds] of data.entries()) {
    const pnode = root.items[pi];
    if (!isMap(ds)) return err("playbook entries must be either valid plays or 'import_playbook' statements", ctx(ds, pnode));
    const imp = ds.import_playbook ?? ds['ansible.builtin.import_playbook'];
    if (typeof imp === 'string') { // the simulator has no other files, so this is real Ansible's missing-file error
      const p = imp.startsWith('/') ? imp : `/home/student/${imp}`;
      return err(`Unable to retrieve file contents. Could not find or access '${p}' on the Ansible Controller: [Errno 2] No such file or directory: '${p}' If you are using a module and expect the file to exist on the remote, see the remote_src option.`);
    }
    for (const k of Object.keys(ds)) {
      if (!kw.play.includes(k)) return err(`'${k}' is not a valid attribute for a Play`, at(child(pnode, k)?.key ?? pnode));
    }
    const play = { ...ds, tasks: [], handlers: [] };
    for (const list of kw.play.filter((k) => (k === 'vars' || TASK_LISTS.has(k)) && k in ds)) { // ansible's load order
      const value = ds[list];
      if (value === null) continue;
      if (list === 'vars') {
        if (!isMap(value)) return err('Vars in a Play must be specified as a dictionary.', ctx(value, child(pnode, 'vars')?.value ?? pnode));
        continue;
      }
      if (!Array.isArray(value)) {
        return err(`A malformed block was encountered while loading ${list}: ${pyStr(value)} should be a list or None but is ${pyType(value)}`, at(pnode));
      }
      play[list] = [];
      for (const [ti, t] of value.entries()) {
        const tnode = child(pnode, list)?.value.items?.[ti] ?? pnode;
        if (!isMap(t)) {
          // Ansible wraps runs of non-block entries in an implicit block and reports the whole run.
          const isBlock = (x) => isMap(x) && ['block', 'rescue', 'always'].some((k) => k in x);
          let a = ti, b = ti + 1;
          while (a > 0 && !isBlock(value[a - 1])) a--;
          while (b < value.length && !isBlock(value[b])) b++;
          const run = pyRepr(value.slice(a, b));
          return err(`A malformed block was encountered while loading block: The ds (${run}) should be a dict but was a <class 'list'>`, `Origin: <unknown>\n\n${shorten(run)}`);
        }
        // ponytail: block/rescue/always arrive with module 5; until then a block is an unresolved action 'block'.
        const task = parseTask(t, tnode, list === 'handlers', registry, kw, err, at, ctx);
        if ('error' in task) return task;
        [task.line, task.col] = lineCol(src, tnode.pos); // where output.js points a failed task's Origin
        if (task.rawParams) { // Ansible's "caused by" Origin is the action key
          const [line, col] = lineCol(src, task.rawParams.pos);
          task.rawParams = { line, col };
        }
        play[list].push(task);
      }
    }
    if ('hosts' in ds) {
      const h = ds.hosts;
      if (pyFalsy(h)) return err('Hosts list cannot be empty. Please check your playbook');
      if (Array.isArray(h)) {
        if (h.includes(null)) return err("Hosts list cannot contain values of 'None'. Please check your playbook");
        const bad = h.find((x) => typeof x !== 'string');
        if (bad !== undefined) return err(`Hosts list contains an invalid host value: '${pyStr(bad)}'`);
      } else if (typeof h !== 'string') return err('Hosts list must be a sequence or string. Please check your playbook.');
    }
    plays.push(play);
  }
  // ponytail: Ansible checks the required hosts when it reaches the play; for a later play that is after earlier plays ran.
  const missing = data.findIndex((p) => !('hosts' in p));
  if (missing >= 0) return err("The field 'hosts' is required but was not set.", at(root.items[missing]));
  return { plays };
}

// Action resolution as in ansible-core's parsing/mod_args.py (parse with skip_action_validation, then resolve).
function parseTask(t, tnode, handler, registry, kw, err, at, ctx) {
  const cands = [];
  for (const k of ['action', 'local_action']) {
    if (!(k in t)) continue;
    if (cands.length) return err('action and local_action are mutually exclusive', at(tnode));
    cands.push(k);
  }
  for (const k of Object.keys(t)) if (!kw.task.includes(k) && !k.startsWith('with_')) cands.push(k);
  const extra = t.args;
  if (cands.length && 'args' in t && extra !== null && !isMap(extra) && !(typeof extra === 'string' && /^\{\{[\s\S]*\}\}$/.test(extra))) {
    return err('The value of the task `args` keyword is invalid.', at(child(tnode, 'args')?.value ?? tnode), 'A mapping or template which resolves to a mapping is required.');
  }
  let mod, args, raw, key;
  for (const k of cands) {
    const v = t[k];
    if (mod !== undefined) return err(`conflicting action statements: ${mod}, ${k}`, at(tnode));
    if (k === 'action' || k === 'local_action') {
      // ponytail: only the string form ("copy src=a dest=b"); the deprecated mapping form is not read.
      if (typeof v !== 'string') return err(`unexpected parameter type in action: ${pyType(v)}`, at(tnode));
      [, mod, args] = /^\s*(\S*)\s*([\s\S]*)$/.exec(v);
    } else {
      if (v !== null && typeof v !== 'string' && !isMap(v)) return err(`unexpected parameter type in action: ${pyType(v)}`, at(tnode));
      [mod, args] = [k, v ?? {}];
    }
    raw = v;
    key = k;
  }
  if (mod === undefined) return err('no module/action detected in task.', at(tnode));
  const { module, spec, real, twin, tombstone } = lookup(mod, registry);
  if (tombstone) return err(tombstone.message, at(tnode)); // golden: tombstone-include, tombstone-module
  if (real && !spec) return { error: '', hint: notSimulated(mod) };
  if (!spec) return err(`couldn't resolve module/action '${mod}'. This often indicates a misspelling, missing collection, or incorrect module path.`, at(tnode));

  if ('vars' in t && t.vars !== null && !isMap(t.vars)) {
    return err(`Vars in a ${handler ? 'Handler' : 'Task'} must be specified as a dictionary.`, ctx(t.vars, child(tnode, 'vars')?.value ?? tnode));
  }
  if (typeof args === 'string') {
    args = parseKv(args, spec.freeform);
    if (!args) return err(`Error loading tasks: failed at splitting arguments, either an unbalanced jinja2 block or quotes: ${raw}`, at(tnode));
  }
  args = { ...(isMap(extra) ? extra : {}), ...args }; // the `args` keyword stays in keywords too
  const keywords = Object.fromEntries(Object.entries(t).filter(([k]) => k !== 'name' && !cands.includes(k)));
  if ('local_action' in t) keywords.delegate_to = 'localhost';
  // action: the module as written, which Ansible's TASK banner shows for an unnamed task.
  const task = { ...('name' in t && { name: t.name }), module, action: mod, args, keywords };

  if ('_raw_params' in args && !spec.freeform) {
    // A lone "{{ var }}" is the variable params of a mapping, which the simulator cannot see; anything else is rejected before the module runs.
    if (/^\{\{[\s\S]*\}\}$/.test(args._raw_params)) delete args._raw_params;
    else task.rawParams = child(tnode, key)?.key ?? tnode; // the action key's node; the caller turns it into { line, col }
  }
  const bad = !task.rawParams && unsupportedMsg(spec, mod, args, twin);
  if (bad) task.unsupported = bad;
  normalise(spec, args);
  return task;
}

// Legal = documented params and aliases plus what the real module accepted ("Supported parameters include" text).
// The message names the module that actually ran, recorded per spelling in modules.yaml `reports_as`.
function unsupportedMsg(spec, mod, args, twin) {
  const [, names, aliases = ''] = /^(.*?)(?: \((.*)\))?\.$/.exec(spec.supported);
  const legal = new Set([...spec.params, ...Object.keys(spec.aliases), ...`${names}, ${aliases}`.split(', ')]);
  const bad = Object.keys(args).filter((k) => !legal.has(k)).sort();
  const ran = twin ? mod : spec.reports_as[mod.includes('.') ? 'fqcn' : 'short']; // a twin runs under the name typed
  if (bad.length) return `Unsupported parameters for (${ran}) module: ${bad.join(', ')}. Supported parameters include: ${spec.supported}`;
}

const fqcn = (name) => name.includes('.') ? name : `ansible.builtin.${name}`;
const notSimulated = (mod) => `This course doesn't simulate ${mod} yet.`;

// A module name as real Ansible resolves it, from modules.yaml: `known` lists every real ansible.builtin module, `twins` and `redirects`
// map aliases to simulated modules, `tombstones` hold removed names with Ansible's text. ansible.legacy.<x> resolves as ansible.builtin.<x>,
// but its output names are not captured, so the course does not simulate it.
//   module/spec: the simulated module the name runs as; twin: it is named as typed in "Unsupported parameters" (a redirect runs as its target);
//   tombstone: removed; real: Ansible resolves the name even when the course has no spec for it. Only a name that is not real gets
//   Ansible's "couldn't resolve" / "Cannot resolve" error.
function lookup(name, registry) {
  const fq = fqcn(name);
  const legacy = fq.startsWith('ansible.legacy.');
  const builtin = legacy ? fq.replace('ansible.legacy.', 'ansible.builtin.') : fq;
  const twin = registry.twins?.[builtin];
  const module = registry.redirects?.[builtin] ?? twin ?? builtin;
  const tombstone = registry.tombstones?.[builtin];
  return {
    module, twin: Boolean(twin), tombstone, spec: legacy || tombstone ? undefined : registry[module],
    real: Boolean(tombstone || registry[module] || registry.known?.includes(builtin.replace('ansible.builtin.', ''))),
  };
}

// Aliases are accepted by Ansible; checks compare canonical names.
function normalise(spec, args) {
  for (const [alias, name] of Object.entries(spec.aliases)) {
    if (alias in args) { args[name] ??= args[alias]; delete args[alias]; }
  }
  return args;
}

// ---- Free-form k=v arguments (ansible/parsing/splitter.py: split_args, parse_kv, join_args) ------------------------
// Ported line for line, since the whitespace, quote and {{ }} rules decide what a learner's `msg="hello world"` means.
// ponytail: \N{name} escapes are not decoded (needs the Unicode name table).
const RAW_KEYS = ['creates', 'removes', 'chdir', 'executable', 'warn', 'stdin', 'stdin_add_newline', 'strip_empty_ends'];
const ESCAPES = { '\\': '\\', "'": "'", '"': '"', a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };

// A task's arg string as a mapping, or undefined when its quotes or jinja2 blocks do not balance.
function parseKv(args, checkRaw) {
  const parts = splitArgs(args);
  if (!parts) return undefined;
  const options = [], raw = [];
  for (const orig of parts) {
    const x = orig.replace(/\\(?:U([0-9a-fA-F]{8})|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([\\'"abfnrtv]))/g,
      (_, U, u, h, c) => c ? ESCAPES[c] : String.fromCodePoint(parseInt(U ?? u ?? h, 16)));
    let pos = 0;
    do pos = x.indexOf('=', pos + 1); while (pos > 0 && x[pos - 1] === '\\');
    if (pos < 0) { raw.push(x.includes('=') ? x.replaceAll('\\=', '=') : orig); continue; }
    const k = x.slice(0, pos), v = x.slice(pos + 1).trim();
    if (checkRaw && !RAW_KEYS.includes(k)) raw.push(orig);
    else options.push([k.trim(), v.length > 1 && v[0] === v.at(-1) && '"\''.includes(v[0]) && v.at(-2) !== '\\' ? v.slice(1, -1) : v]);
  }
  if (raw.length) options.push(['_raw_params', raw.reduce((r, p) => !r || r.endsWith('\n') ? r + p : `${r} ${p}`, '')]);
  return Object.fromEntries(options);
}

function splitArgs(args) {
  const params = [], items = args.split('\n');
  const end = () => params.length - 1;
  const depth = (tok, d, open, close) => {
    const o = tok.split(open).length - 1, c = tok.split(close).length - 1;
    return o === c ? d : Math.max(0, d + o - c);
  };
  let quote = null, inside = false, print = 0, block = 0, comment = 0;
  for (const [itemIdx, item] of items.entries()) {
    let continued = false;
    for (const [idx, token] of item.split(' ').entries()) {
      if (token === '' && idx !== 0) { // subsequent spaces are kept so the text can be rebuilt
        if (!params.length) params.push('');
        params[end()] += ' ';
        continue;
      }
      if (token === '\\' && !inside) { continued = true; continue; }
      const was = inside;
      for (let i = 0; i < token.length; i++) { // _get_quote_state
        const ch = token[i];
        if ((ch === '"' || ch === "'") && token[i - 1] !== '\\') quote = !quote ? ch : ch === quote ? null : quote;
      }
      inside = quote !== null;
      let appended = false;
      if (inside && !was && !(print || block || comment)) { params.push(token); appended = true; }
      else if (print || block || comment || inside || was) {
        params[end()] += `${idx > 0 ? ' ' : ''}${token}`;
        appended = true;
      }
      const track = (d, open, close) => {
        const n = depth(token, d, open, close);
        if (n !== d && !appended) { params.push(token); appended = true; }
        return n;
      };
      print = track(print, '{{', '}}');
      block = track(block, '{%', '%}');
      comment = track(comment, '{#', '#}');
      if (!(print || block || comment) && !inside && !appended && token !== '') params.push(token);
    }
    if (items.length > 1 && itemIdx !== items.length - 1 && !continued) { // keep the newline between lines
      if (!params.length) params.push('');
      params[end()] += '\n';
    }
  }
  return print || block || comment || inside ? undefined : params;
}

// ---- YAML errors -------------------------------------------------------------------------------------------------
// js-yaml's reasons and marks differ from libyaml's, so each kind is mapped to the libyaml wording ansible-core shows.
// Then Ansible's own target-line heuristics (tabs, templates, colons, quotes) run, as in ansible/_internal/_yaml/_errors.py.
function yamlError(src, e, tree, path) {
  const r = e.reason;
  let pos = e.mark?.position ?? 0;
  let msg;
  if (/^bad indentation of a (mapping|sequence) entry|^end of the stream or a document separator is expected/.test(r)) {
    msg = blockMsg(src, pos);
  } else if (/multiline key may not be an implicit key|^expected ':' after a mapping key/.test(r)) {
    // Golden-free but checked against real runs: libyaml notices the missing ':' at the next token, js-yaml at the key's line end.
    msg = "While scanning a simple key could not find expected ':'.";
    if (r.startsWith('expected')) pos += /^(?:\s|#.*)*/.exec(src.slice(pos))[0].length;
    else {
      // js-yaml runs the key on into an equally indented next line; libyaml stops and reports that line's start.
      const lines = src.split('\n'), [l, c] = lineCol(src, pos);
      let k = l - 2;
      while (k >= 0 && !lines[k].trim()) k--;
      const keyCol = k < 0 ? -1 : /^ *(?:- +)*/.exec(lines[k])[0].length, indent = /^ */.exec(lines[l - 1])[0].length;
      if (indent <= keyCol) pos -= c - 1 - indent;
    }
  } else if (/quoted scalar|deficient indentation|flow collection|missed comma/.test(r)) {
    const { quote, flow } = openAt(src, pos);
    if (quote !== undefined) {
      // libyaml reads a quoted scalar across lines to its closing quote, wherever that is. Golden-backed: yaml-unclosed-quote.
      const end = closeQuote(src, quote);
      // ponytail: when a later quote closes it, we assume the text right after that quote is what breaks.
      [msg, pos] = end < 0 ? ['While scanning a quoted scalar found unexpected end of stream.', src.length] : [blockMsg(src, end + 1), end + 1];
    } else {
      // ponytail: wording from libyaml's parser; its mark may sit on a later token than js-yaml's.
      msg = flow === '{' ? "While parsing a flow mapping did not find expected ',' or '}'." : "While parsing a flow sequence did not find expected ',' or ']'.";
    }
  } else if (/complex keys/.test(r) && tree?.complexKey !== undefined) {
    // libyaml's "found unhashable key" points at the key, e.g. the inner mapping of an unquoted {{ var }}.
    msg = 'While constructing a mapping found unhashable key.';
    pos = tree.complexKey;
  } else {
    // ponytail: remaining js-yaml reasons (tags, anchors, directives, escapes) keep their own wording in libyaml's frame.
    msg = `${r[0].toUpperCase()}${r.slice(1)}.`;
  }
  return yamlFormat(src, msg, ...lineCol(src, pos), path);
}

function yamlFormat(src, msg, line, col, path) {
  const target = (src.split('\n')[line - 1] ?? '');
  const valueAt = (m) => m.index + m[0].length - m.groups.value.length; // `value` is always the last group
  let help, m, c;
  if (target.includes('\t')) {
    [msg, col] = ['Tabs are usually invalid in YAML.', target.indexOf('\t') + 1];
  } else if ((m = /^\s*(?:-\s+)*(?:[\p{L}\p{N}_\s]+:\s+)?(?<value>\{\{.*\}\})/u.exec(target))) {
    [msg, col] = ['This may be an issue with missing quotes around a template block.', valueAt(m) + 1];
    help = '\nFor example:\n\n    raw: {{ some_var }}\n\nShould be:\n\n    raw: "{{ some_var }}"\n';
  } else if (!target.trimStart().startsWith(':')
    && (m = /^\s*(?:-\s+)*(?:[\p{L}\p{N}_\s[\]{}]+:\s+)?(?<value>.*)$/u.exec(target))
    && (c = /:($| )/.exec(m.groups.value.replace(/^\s*('[^']*'|"[^"]*")\s*$/, (q) => '.'.repeat(q.length))))) {
    [msg, col] = ['Colons in unquoted values must be followed by a non-space character.', valueAt(m) + c.index + 1];
    help = '\nFor example:\n\n    raw: echo \'name: ansible\'\n\nShould be:\n\n    raw: "echo \'name: ansible\'"\n';
  } else if ((m = /^\s*(?:-\s+)*(?:[\p{L}\p{N}_\s]+:\s+)?(?<value>["'].*?\s*)$/u.exec(target))) {
    const v = m.groups.value, q = v[0];
    if (q !== v.at(-1)) {
      [msg, col] = ['Values starting with a quote must end with the same quote.', valueAt(m) + 1];
      help = '\nFor example:\n\n    raw: "foo" in bar\n\nShould be:\n\n    raw: \'"foo" in bar\'\n';
    } else if (target.split(q).length - 1 > 2) {
      [msg, col] = ['Values starting with a quote must end with the same quote, and not contain that quote.', valueAt(m) + 1];
      help = '\nFor example:\n\n    raw: "foo" in "bar"\n\nShould be:\n\n    raw: \'"foo" in "bar"\'\n';
    }
  }
  return format(`YAML parsing failed: ${msg}`, excerpt(src, line, col, path), help);
}

// Innermost open block collection at or left of column c, read off the lines above line li (0-based): 'seq', 'map', or
// undefined when nothing is open (the document has ended). A "- " entry opens a sequence unless it is indentless
// (same column as its parent mapping key).
function openCollection(lines, li, c) {
  const shape = (l) => /^( *)(-(?: +|$))?(.?)/.exec(l);
  const skip = (l, s) => (!s[2] && !s[3]) || s[3] === '#' || /^(---|\.\.\.)(\s|$)/.test(l);
  for (let i = li - 1; i >= 0; i--) {
    const s = shape(lines[i]);
    if (skip(lines[i], s) || s[1].length > c) continue;
    if (!s[2] || s[1].length + s[2].length <= c) return 'map';
    for (let j = i - 1; j >= 0; j--) {
      const p = shape(lines[j]);
      if (skip(lines[j], p) || p[1].length > s[1].length) continue;
      if (p[1].length < s[1].length) return 'seq';
      if (!p[2]) return 'map';
    }
    return 'seq';
  }
  return undefined;
}

// libyaml's reading of a token that breaks block structure at pos.
// ponytail: libyaml's indent stack is approximated from the lines above; golden-backed: yaml-indent, yaml-dedent, yaml-mapping-values.
function blockMsg(src, pos) {
  const [line, col] = lineCol(src, pos);
  if (src[pos] === ':') return 'Mapping values are not allowed in this context.';
  const open = openCollection(src.split('\n'), line - 1, col - 1);
  return open === 'seq' ? "While parsing a block collection did not find expected '-' indicator."
    : open === 'map' ? 'While parsing a block mapping did not find expected key.' : 'Did not find expected <document start>.';
}

// Index of the quote that closes the quoted scalar opening at i, or -1.
function closeQuote(src, i) {
  const q = src[i];
  for (let j = i + 1; j < src.length; j++) {
    if (q === '"' && src[j] === '\\') j++;
    else if (src[j] === q) {
      if (q === "'" && src[j + 1] === "'") j++;
      else return j;
    }
  }
  return -1;
}

// What is still open at pos: { quote: index of its opening quote } or { flow: '[' | '{' | undefined }.
// A rough scan (quotes and brackets only count where a node can start), enough to name the error.
function openAt(src, pos) {
  const stack = [];
  for (let i = 0; i < pos; i++) {
    const ch = src[i], start = /[\s[{,]/.test(src[i - 1] ?? '\n');
    if (start && (ch === '"' || ch === "'")) {
      const end = closeQuote(src, i);
      if (end < 0 || end >= pos) return { quote: i };
      i = end;
    } else if (start && ch === '#') i = src.indexOf('\n', i) < 0 ? pos : src.indexOf('\n', i);
    else if (start && (ch === '[' || ch === '{')) stack.push(ch);
    else if (ch === ']' || ch === '}') stack.pop();
  }
  return { flow: stack.at(-1) };
}

// ---- Ansible's error frame (_event_formatting.py, _error_utils.SourceContext) ------------------------------------
export function format(msg, ctx, help) {
  const s = [msg, ...(ctx === undefined ? [] : [ctx]), ...(help ? ['', help] : [])].join('\n').trim();
  return `[ERROR]: ${s}${s.includes('\n') ? '\n\n' : '\n'}`;
}

export function excerpt(src, line, col, path = PATH) {
  const origin = `Origin: ${path}:${line}:${col}`;
  const lines = (src.match(/[^\n]*\n|[^\n]+$/g) ?? []).map((l) => l.replace(/\n$/, ''));
  const start = Math.max(0, line - 3);
  if (lines.length < line) return `${origin}\n\n(source not shown: file truncated)`;
  const w = String(line).length, max = 120 - w - 1;
  let usable = max;
  const out = lines.slice(start, line).map((l, i) => {
    l = l.replaceAll('\t', ' ');
    if (l.length > max) [l, usable] = [`${l.slice(0, max - 3)}...`, max - 3];
    return `${String(start + i + 1).padStart(w)}${l ? ' ' : ''}${l}`;
  });
  if (col >= 1 && usable >= col) {
    const mark = `column ${col}`;
    out.push(`${' '.repeat(w)} ${col + 1 + mark.length > max ? `${' '.repeat(Math.max(0, col - mark.length - 2))}${mark} ^` : `${' '.repeat(col - 1)}^ ${mark}`}`);
  }
  return `${origin}\n\n${out.join('\n')}`;
}

function lineCol(src, pos) {
  const before = src.slice(0, Math.max(0, pos)).split('\n');
  return [before.length, before.at(-1).length + 1];
}

// js-yaml's events as nodes with source offsets: { pos, items } for sequences, { pos, keys: Map(key → { key, value }) }
// for mappings, { pos } otherwise. Also records the first non-scalar mapping key (libyaml: "found unhashable key"), and in
// root.dups every repeated key ({ pos, str }) in the order Ansible's constructor warns: level by level (PyYAML builds nested
// collections breadth first), in document order within a level.
function nodeTree(src, events) {
  const E = yaml.EVENT_ID, root = { items: [] }, stack = [root], dups = [];
  const add = (n) => {
    const top = stack.at(-1);
    if (!top.keys) return top.items.push(n);
    if (!top.pending) return (top.pending = n);
    if (top.pending.str === undefined) root.complexKey ??= top.pending.pos;
    else if (top.keys.has(top.pending.str)) dups.push({ ...top.pending, depth: stack.length });
    top.keys.set(top.pending.str, { key: top.pending, value: n });
    top.pending = undefined;
  };
  for (const e of events) {
    const pos = [e.tagStart, e.anchorStart, e.valueStart, e.start].find((p) => p >= 0) ?? -1;
    if (e.type === E.DOCUMENT || e.type === E.SEQUENCE) stack.push({ pos, items: [] });
    else if (e.type === E.MAPPING) stack.push({ pos, keys: new Map() });
    else if (e.type === E.POP) add(stack.pop());
    else add(e.type === E.SCALAR ? { pos, str: yaml.getScalarValue(src, e) } : { pos });
  }
  root.dups = dups.sort((a, b) => a.depth - b.depth);
  return root;
}

// A mapping node's entry for key k ({ key, value }); undefined for aliases and merged (<<) keys.
const child = (node, k) => node.keys?.get(k);

// ---- Python's view of values ---------------------------------------------------------------------------------------
const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);

function pyType(v) {
  if (v === null) return "<class 'NoneType'>";
  if (typeof v === 'boolean') return "<class 'bool'>";
  const t = Array.isArray(v) ? 'List' : typeof v === 'string' ? 'Str' : typeof v === 'number' ? (Number.isInteger(v) ? 'Int' : 'Float') : 'Dict';
  return `<class 'ansible.module_utils._internal._datatag._AnsibleTagged${t}'>`;
}

// ponytail: floats that are whole numbers print as ints (js-yaml drops the ".0"), int keys print quoted (JS object keys are
// strings), and non-printable escapes are not reproduced.
export function pyRepr(v) {
  if (v === null || v === undefined) return 'None';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') {
    const q = v.includes("'") && !v.includes('"') ? '"' : "'";
    const esc = { '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t' };
    return q + v.replace(/[\\\n\r\t]/g, (ch) => esc[ch]).replaceAll(q, `\\${q}`) + q;
  }
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(', ')}]`;
  return `{${Object.entries(v).map(([k, x]) => `${pyRepr(k)}: ${pyRepr(x)}`).join(', ')}}`;
}

const pyStr = (v) => typeof v === 'string' ? v : pyRepr(v);

const pyFalsy = (v) => v === null || v === false || v === 0 || v === ''
  || (Array.isArray(v) ? !v.length : isMap(v) && !Object.keys(v).length);

// textwrap.shorten(text, width=120)
function shorten(s) {
  s = s.trim().split(/\s+/).join(' ');
  if (s.length <= 120) return s;
  const cut = s.slice(0, 115);
  return `${cut.slice(0, Math.max(0, cut.lastIndexOf(' ')))} [...]`;
}

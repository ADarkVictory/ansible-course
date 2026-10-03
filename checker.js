// Pure ES module, no DOM: the browser and Node run the same code.
// parsePlaybook turns playbook text into plays, or into the exact error ansible-core 2.21.4 prints for it.
import * as yaml from './vendor/js-yaml.mjs';
import { render } from './output.js'; // output.js imports format/excerpt back; both only call each other at run time, so the cycle is harmless.

const PATH = '/home/student/playbook.yml';
const TAB_HINT = 'Replace tabs with spaces.';
const CURLY_HINT = 'Your keyboard inserted curly quotes; use straight quotes.';
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

/**
 * Decides whether a learner's playbook meets a `write` exercise (spec 3.3).
 * @param exercise { inventory, checks: [{ play | task | handler | forbid, has?, hint? }], fqcn?, fqcn_hint? }
 * @param opts     { second?: show the output of running the playbook again }
 * @returns { ok, output, hint?, failedCheck? } failedCheck is the 1-based index into exercise.checks.
 */
export function checkWrite(exercise, source, registry, keywords, opts = {}) {
  const parsed = parsePlaybook(source, registry, keywords);
  const fail = (output, hint, failedCheck) => ({ ok: false, output, ...(hint && { hint }), ...(failedCheck && { failedCheck }) });
  if (parsed.error) return fail(parsed.error, parsed.hint);
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

function parse(src, registry, kw) {
  let events, tree, docs;
  try {
    events = yaml.parseEvents(src);
    tree = nodeTree(src, events);
    // json: true lets a later duplicate key win, as PyYAML does.
    // ponytail: Ansible also prints a "Found duplicate mapping key" warning; not reproduced.
    docs = yaml.constructFromEvents(events, { schema: SCHEMA, json: true, source: src });
  } catch (e) {
    if (!(e instanceof yaml.YAMLException)) throw e;
    return { error: yamlError(src, e, tree), ...(src.includes('\t') && { hint: TAB_HINT }) };
  }
  const err = (msg, ctx, help) => ({ error: format(msg, ctx, help) });
  const at = (node) => excerpt(src, ...lineCol(src, node.pos));
  const ctx = (value, node) => value === null ? undefined
    : typeof value === 'boolean' || !node || node.pos < 0 ? `Origin: <unknown>\n\n${shorten(pyStr(value))}` : at(node);

  if (docs.length > 1) {
    // ponytail: libyaml points at the second "---"; a second document opened without "---" falls back to line 1.
    const starts = [...src.matchAll(/^---(?=\s|$)/gm)].map((m) => m.index);
    const pos = starts[events[0].explicitStart ? 1 : 0] ?? 0;
    return { error: yamlFormat(src, 'Expected a single document in the stream but found another document.', ...lineCol(src, pos)) };
  }
  const data = docs[0] ?? null;
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
        if (task.error) return task;
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
  const module = mod.includes('.') ? mod : `ansible.builtin.${mod}`;
  const spec = registry[module];
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
  // Legal = documented params and aliases plus what the real module accepted ("Supported parameters include" text).
  // The message names the module that actually ran, recorded per spelling in modules.yaml `reports_as`.
  if (!task.rawParams) {
    const [, names, aliases = ''] = /^(.*?)(?: \((.*)\))?\.$/.exec(spec.supported);
    const legal = new Set([...spec.params, ...Object.keys(spec.aliases), ...`${names}, ${aliases}`.split(', ')]);
    const bad = Object.keys(args).filter((k) => !legal.has(k)).sort();
    const ran = spec.reports_as[mod.includes('.') ? 'fqcn' : 'short'];
    if (bad.length) task.unsupported = `Unsupported parameters for (${ran}) module: ${bad.join(', ')}. Supported parameters include: ${spec.supported}`;
  }
  // Aliases are accepted by Ansible; checks compare canonical names.
  for (const [alias, name] of Object.entries(spec.aliases)) {
    if (alias in args) { args[name] ??= args[alias]; delete args[alias]; }
  }
  return task;
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
function yamlError(src, e, tree) {
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
  return yamlFormat(src, msg, ...lineCol(src, pos));
}

function yamlFormat(src, msg, line, col) {
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
  return format(`YAML parsing failed: ${msg}`, excerpt(src, line, col), help);
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

export function excerpt(src, line, col) {
  const origin = `Origin: ${PATH}:${line}:${col}`;
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
// for mappings, { pos } otherwise. Also records the first non-scalar mapping key (libyaml: "found unhashable key").
function nodeTree(src, events) {
  const E = yaml.EVENT_ID, root = { items: [] }, stack = [root];
  const add = (n) => {
    const top = stack.at(-1);
    if (!top.keys) return top.items.push(n);
    if (!top.pending) return (top.pending = n);
    if (top.pending.str === undefined) root.complexKey ??= top.pending.pos;
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
function pyRepr(v) {
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

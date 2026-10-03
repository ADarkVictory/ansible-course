// Pure ES module, no DOM: the browser and Node run the same code.
// parsePlaybook turns playbook text into plays, or into the exact error ansible-core 2.21.4 prints for it.
import * as yaml from './vendor/js-yaml.mjs';

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
 * @returns { plays, runtimeError?, hint? } | { error, hint? }
 *   runtimeError: { play, task, msg } for the first `tasks` entry real Ansible would fail at run time
 *   (unsupported parameters); the renderer turns it into the failed run.
 *   A hint next to plays (curly quotes) means the checker must still fail: real Ansible would run the wrong value.
 */
export function parsePlaybook(source, registry, keywords) {
  const src = String(source).replace(/\r\n?/g, '\n');
  const out = parse(src, registry, keywords);
  if (!out.hint && /[“”‘’]/.test(src)) out.hint = CURLY_HINT;
  return out;
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
  let runtimeError;
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
        play[list].push(task.task);
        if (list === 'tasks' && !runtimeError && task.unsupported) runtimeError = { play: pi, task: ti, msg: task.unsupported };
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
  return runtimeError ? { plays, runtimeError } : { plays };
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
  let mod, args;
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
  }
  if (mod === undefined) return err('no module/action detected in task.', at(tnode));
  const module = mod.includes('.') ? mod : `ansible.builtin.${mod}`;
  const spec = registry[module];
  if (!spec) return err(`couldn't resolve module/action '${mod}'. This often indicates a misspelling, missing collection, or incorrect module path.`, at(tnode));

  if ('vars' in t && t.vars !== null && !isMap(t.vars)) {
    return err(`Vars in a ${handler ? 'Handler' : 'Task'} must be specified as a dictionary.`, ctx(t.vars, child(tnode, 'vars')?.value ?? tnode));
  }
  // k=v strings stay raw for Task 4 (which also merges the `args` keyword into them); the keyword itself stays in keywords.
  if (isMap(args)) args = { ...(isMap(extra) ? extra : {}), ...args };
  const keywords = Object.fromEntries(Object.entries(t).filter(([k]) => k !== 'name' && !cands.includes(k)));
  if ('local_action' in t) keywords.delegate_to = 'localhost';
  const task = { ...('name' in t && { name: t.name }), module, args, keywords };

  // Legal = documented params and aliases plus what the real module accepted ("Supported parameters include" text).
  let unsupported;
  if (isMap(args)) {
    const [, names, aliases = ''] = /^(.*?)(?: \((.*)\))?\.$/.exec(spec.supported);
    const legal = new Set([...spec.params, ...Object.keys(spec.aliases), ...`${names}, ${aliases}`.split(', ')]);
    const bad = Object.keys(args).filter((k) => !legal.has(k)).sort();
    if (bad.length) unsupported = `Unsupported parameters for (${mod}) module: ${bad.join(', ')}. Supported parameters include: ${spec.supported}`;
  }
  return { task, unsupported };
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
function format(msg, ctx, help) {
  const s = [msg, ...(ctx === undefined ? [] : [ctx]), ...(help ? ['', help] : [])].join('\n').trim();
  return `[ERROR]: ${s}${s.includes('\n') ? '\n\n' : '\n'}`;
}

function excerpt(src, line, col) {
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

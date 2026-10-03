// Pure ES module, no DOM: the browser and Node run the same code.
// render prints what ansible-core 2.21.4's ansible-playbook prints (default callback, ANSIBLE_NOCOLOR=1, COLUMNS=80,
// forks=1) for plays from checker.js's parsePlaybook. Formats are copied from tests/golden/run-*.txt and unsupported-param.txt.
// renderAdhoc prints what `ansible <pattern> -m ...` prints (tests/golden/adhoc-*.txt); both share resolveHosts.
import { format, excerpt, pyRepr, shorten } from './checker.js';

const NEVER_CHANGES = new Set(['ansible.builtin.ping', 'ansible.builtin.debug', 'ansible.builtin.setup']);
const RECAP = ['ok', 'changed', 'unreachable', 'failed', 'skipped', 'rescued', 'ignored'];

// Display.banner: the message, a space, then stars to column 79 (never fewer than three), after a blank line.
const banner = (msg) => `\n${msg} ${'*'.repeat(Math.max(3, 79 - msg.length))}\n`;

// json.dumps(indent=4, sort_keys=True, ensure_ascii=False), as the callback prints module results.
const dump = (v) => JSON.stringify(v, (_, x) => x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a > b) - (a < b))) : x, 4);

const WARN_UNMATCHED = (p) => `[WARNING]: Could not match supplied host pattern, ignoring: ${p}\n`;
// What "Task failed: " is followed by when Ansible rejects a task's arguments (checker.js parsePlaybook `via`); the module itself: 'Module failed: '.
const FAILED_BY = { action: 'Action failed: ', raised: '', debug: '' };
const LOCALHOST = ['localhost', '127.0.0.1', '::1'];

/**
 * Hosts a pattern selects, as ansible's inventory manager does (list order, never sorted).
 * @param patterns  a pattern string or an array of them (a play's `hosts:`); each is split on `,`, or else on `:`
 * @param inventory { group: [host, ...], 'group:children': [group, ...] } (a `:children` key lists child groups, as in INI)
 * @returns { hosts, unmatched } unmatched: names that are neither a group nor a host (real Ansible warns once per name, per run)
 * Patterns: plain host or group names, `all`, `*`/`?` globs, `a:b` union, `a:&b` intersection, `a:!b` exclusion.
 * Evaluation order is Ansible's: plain patterns, then every `&`, then every `!`; with no plain pattern it starts from `all`.
 * ponytail: `web[0]` subscripts and `~regex` patterns are not resolved. A group lists its own hosts, then its children's in
 * order; real Ansible orders grandchildren by set iteration, so deeper nesting may list in another order.
 */
export function resolveHosts(patterns, inventory) {
  const hostsOf = (g) => [...new Set([...(inventory[g] ?? []), ...(inventory[`${g}:children`] ?? []).flatMap(hostsOf)])];
  const names = [...new Set(Object.keys(inventory).map((k) => k.replace(/:children$/, '')))];
  const everyone = [...new Set(names.flatMap((g) => inventory[g] ?? []))];
  const groups = { ungrouped: [], ...Object.fromEntries(names.map((g) => [g, hostsOf(g)])), all: everyone };
  const list = [patterns].flat().flatMap((p) => String(p).split(String(p).includes(',') ? /\s*,\s*/ : /\s*:\s*/)).map((p) => p.trim()).filter(Boolean);
  const kind = (p) => (p[0] === '!' ? 2 : p[0] === '&' ? 1 : 0);
  const plain = list.filter((p) => !kind(p));
  const ordered = [...(plain.length ? plain : ['all']), ...list.filter((p) => kind(p) === 1), ...list.filter((p) => kind(p) === 2)];
  const unmatched = new Set();
  const match = (name) => {
    const rx = new RegExp(`^${name.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
    const gs = Object.keys(groups).filter((g) => rx.test(g));
    const hs = everyone.filter((h) => rx.test(h));
    if (!gs.length && !hs.length) {
      if (LOCALHOST.includes(name)) return [name]; // the implicit localhost
      unmatched.add(name);
    }
    return [...new Set([...gs.flatMap((g) => groups[g]), ...hs])];
  };
  let hosts = [];
  for (const p of ordered) {
    if (everyone.includes(p)) { hosts.push(p); continue; }
    const that = match(kind(p) ? p.slice(1) : p);
    hosts = kind(p) === 2 ? hosts.filter((h) => !that.includes(h)) : kind(p) === 1 ? hosts.filter((h) => that.includes(h)) : [...hosts, ...that];
  }
  return { hosts: [...new Set(hosts)], unmatched: [...unmatched] };
}

// Templating covers {{ name }} only: parsePlaybook refuses every other template. A lone {{ name }} keeps its type, as Ansible's
// does; inside text a value prints as Python's str() (True, not true).
export function tpl(v, vars) {
  if (typeof v !== 'string') return v;
  const whole = /^\{\{\s*(\w+)\s*\}\}$/.exec(v);
  if (whole && Object.hasOwn(vars, whole[1])) return vars[whole[1]];
  return v.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (Object.hasOwn(vars, k) ? (typeof vars[k] === 'string' ? vars[k] : pyRepr(vars[k])) : m));
}
const text = (v, vars) => { const x = tpl(v, vars); return typeof x === 'string' || x == null ? x : pyRepr(x); };

/**
 * The hosts a command (or a play: { pattern: hosts, flags: {} }) targets: its pattern's, narrowed by --limit, in pattern order.
 * @param warn called with each name that matches nothing (the renderers print that warning once per name)
 */
export function targets(cmd, inventory, warn = () => {}) {
  const pick = (p) => { const r = resolveHosts(p, inventory); r.unmatched.forEach(warn); return r.hosts; };
  const hosts = pick(cmd.pattern);
  if (!cmd.flags.limit) return hosts;
  const keep = pick(cmd.flags.limit);
  return hosts.filter((h) => keep.includes(h));
}

// First run: every module changes except the ones that never do. Second run: only what real modules change again.
// changed_when is true or false here: parsePlaybook refuses expressions.
function isChanged(task, a, second) {
  const cw = task.keywords.changed_when;
  if (cw !== undefined) return cw === true || /^true$/i.test(cw);
  if (NEVER_CHANGES.has(task.module)) return false;
  if (!second) return true;
  switch (task.module) {
    case 'ansible.builtin.command': case 'ansible.builtin.shell': return !('creates' in a || 'removes' in a);
    case 'ansible.builtin.file': return a.state === 'touch';
    case 'ansible.builtin.service': case 'ansible.builtin.systemd_service': return a.state === 'restarted' || a.state === 'reloaded';
    default: return false;
  }
}

// parsePlaybook makes sure a debug var is set and holds no template.
const debugResult = (a, vars) => ('var' in a ? { [a.var]: vars[a.var] } : { msg: tpl(a.msg ?? 'Hello world!', vars) });

/**
 * @param plays     parsePlaybook(...).plays
 * @param inventory { group: [host, ...] }
 * @param opts      { second?: run the playbook again over the first run's state, source?: the playbook text (for Origin) }
 */
export function render(plays, inventory, { second = false, source = '' } = {}) {
  const stats = {}; // a host gets a recap row once a task ran on it
  const warned = new Set(); // Display.warning prints a given message once per run
  let out = '';
  const warn = (p) => { if (!warned.has(p)) { warned.add(p); out += WARN_UNMATCHED(p); } };

  run: for (const play of plays) {
    const hosts = targets({ pattern: play.hosts, flags: {} }, inventory, warn);
    out += banner(`PLAY [${text(play.name, play.vars ?? {}) || [play.hosts].flat().join(',')}]`);
    if (!hosts.length) {
      out += 'skipping: no hosts matched\n';
      continue;
    }
    const varsFor = (h, task) => ({ ...play.vars, ...task.keywords.vars, inventory_hostname: h });
    const notified = new Set();

    // Prints one task (or handler) on every host; returns 'failed' or 'error' when the run stops there.
    const exec = (task, kind) => {
      const label = (h) => (task.keywords.delegate_to ? `${h} -> ${task.keywords.delegate_to}` : h);
      out += banner(`${kind} [${text(task.name, varsFor(hosts[0], task)) || task.action}]`);
      // Golden: unsupported-param, raw-params, missing-required, copy-no-src, template-no-src, debug-msg-var. The [ERROR] block
      // shows once, then a fatal line per host; debug's own argument check reports no "changed".
      const raw = task.rawParams && `Action '${task.module}' does not support raw params.`;
      if (task.unsupported || raw) {
        const msg = raw ? `Task failed: ${raw}` : task.unsupported;
        out += raw
          // Ansible wraps this one (raised while preparing the task) as "Task failed." caused by the error at the action key.
          ? format(msg, `\nTask failed.\n${excerpt(source, task.line, task.col)}\n\n<<< caused by >>>\n\n${raw}\n${excerpt(source, task.rawParams.line, task.rawParams.col)}`)
          : format(`Task failed: ${FAILED_BY[task.via] ?? 'Module failed: '}${msg}`, excerpt(source, task.line, task.col));
        for (const h of hosts) {
          out += `fatal: [${label(h)}]: FAILED! => {${task.via === 'debug' ? '' : '"changed": false, '}"msg": ${JSON.stringify(msg)}}\n`;
          (stats[h] ??= {}).failed = 1;
        }
        return 'failed';
      }
      const a = task.args;
      const changed = isChanged(task, a, second);
      if (changed) {
        for (const n of [task.keywords.notify ?? []].flat()) {
          const hit = play.handlers.filter((hd) => hd.name === n || [hd.keywords.listen].flat().includes(n));
          if (!hit.length) {
            out += `[ERROR]: The requested handler '${n}' was not found in either the main handlers list nor in the listening handlers list\n`;
            return 'error';
          }
          for (const hd of hit) notified.add(hd);
        }
      }
      for (const h of hosts) {
        stats[h] ??= {};
        stats[h].ok = (stats[h].ok ?? 0) + 1;
        if (changed) stats[h].changed = (stats[h].changed ?? 0) + 1;
        const result = task.module === 'ansible.builtin.debug' ? ` => ${dump(debugResult(a, varsFor(h, task)))}` : '';
        out += `${changed ? 'changed' : 'ok'}: [${label(h)}]${result}\n`;
      }
    };
    // Handlers run in the order they are defined, at the flush after pre_tasks, tasks and post_tasks.
    const flush = () => {
      for (const hd of play.handlers.filter((x) => notified.has(x))) {
        notified.delete(hd);
        const r = exec(hd, 'RUNNING HANDLER');
        if (r) return r;
      }
    };

    const facts = { name: 'Gathering Facts', module: 'ansible.builtin.setup', args: {}, keywords: {} };
    const steps = [...(play.gather_facts === false ? [] : [facts]), ...(play.pre_tasks ?? []), flush,
      ...play.tasks, flush, ...(play.post_tasks ?? []), flush];
    for (const step of steps) {
      const r = typeof step === 'function' ? step() : exec(step, 'TASK');
      if (r === 'error') return out; // Ansible stops without a recap
      if (r) break run; // every host failed (the simulator runs all hosts alike), so no later task or play runs
    }
  }

  out += banner('PLAY RECAP');
  for (const h of Object.keys(stats).sort()) {
    out += `${h.padEnd(26)} : ${RECAP.map((k) => `${k}=${String(stats[h][k] ?? 0).padEnd(4)}`).join(' ')}\n`;
  }
  return `${out}\n`;
}

/**
 * What `ansible <pattern> -m <module> -a <args>` prints (default callback, no -v), for checker.js's parseCommand.
 * @param cmd       parseCommand(line, registry) of an `ansible` line
 * @param inventory { group: [host, ...] }
 * @param opts      { stdout?: what a command or shell module prints on every host }
 * Simulated: ping, command, shell, --list-hosts, --limit, and Ansible's errors. Any other valid module prints nothing here;
 * its exercise supplies `output`. Goldens: tests/golden/adhoc-*.txt, list-hosts.json.
 */
export function renderAdhoc(cmd, inventory, { stdout = '' } = {}) {
  let out = '';
  const warned = new Set();
  const hosts = targets(cmd, inventory, (p) => { if (!warned.has(p)) { warned.add(p); out += WARN_UNMATCHED(p); } });
  if (cmd.flags.limit && !hosts.length) return `${out}[ERROR]: Specified inventory, host pattern and/or --limit leaves us with no hosts to target.\n`;
  if (!hosts.length) out += '[WARNING]: No hosts matched, nothing to do\n';
  if (cmd.flags['list-hosts']) return `${out}  hosts (${hosts.length}):\n${hosts.map((h) => `    ${h}\n`).join('')}`;
  if (cmd.noArg) { // adhoc.py: a pattern ending in .yml is probably a playbook
    return `${out}[ERROR]: No argument passed to ${cmd.mod} module${cmd.pattern.endsWith('.yml') ? ' (did you mean to run ansible-playbook?)' : ''}\n`;
  }
  if (!hosts.length) return out;

  const { mod } = cmd;
  const each = (line) => hosts.map(line).join('');
  const fatal = (msg) => each((h) => `${h} | FAILED! => ${dump({ changed: false, msg })}\n`);
  const task = shorten(`{'action': ${pyRepr(mod)}, 'args': ${pyRepr(cmd.typedArgs)}, 'timeout': 0, 'async_val': 0, 'poll': 15}`); // golden: adhoc-invalid-choice
  // A removed name: an action is refused before the task runs, a module fails at run time. Golden: adhoc-include-tombstone, adhoc-module-tombstone.
  if (cmd.tombstone) {
    const { kind, message } = cmd.tombstone;
    if (kind === 'action') return `${out}[ERROR]: ${message}\n`;
    return `${out}[ERROR]: Task failed: ${message}\nOrigin: <adhoc '${mod}' task>\n\n${task}\n\n${fatal(`Task failed: ${message}`)}`;
  }
  // Golden: adhoc-unknown-module, adhoc-raw-params. Raised while preparing the task, so Ansible wraps it as "Task failed." caused by the -m option.
  const why = !cmd.known ? `Cannot resolve '${mod}' to an action or module.` : cmd.rawParams && `Action '${cmd.module}' does not support raw params.`;
  if (why) {
    return `${out}[ERROR]: Task failed: ${why}\n\nTask failed.\nOrigin: <adhoc '${mod}' task>\n\n${task}\n\n<<< caused by >>>\n\n${why}\n`
      + `Origin: <CLI option '-m'>\n\n${mod}\n\n${fatal(`Task failed: ${why}`)}`;
  }
  // Golden: adhoc-unsupported-param (short and FQCN spelling), adhoc-missing-required, adhoc-copy-no-src, adhoc-template-no-src.
  if (cmd.unsupported) {
    return `${out}[ERROR]: Task failed: ${FAILED_BY[cmd.via] ?? 'Module failed: '}${cmd.unsupported}\nOrigin: <adhoc '${mod}' task>\n\n${task}\n\n${fatal(cmd.unsupported)}`;
  }
  switch (cmd.module) {
    case 'ansible.builtin.ping': return out + each((h) => `${h} | SUCCESS => ${dump({ changed: false, ping: String(cmd.args.data ?? 'pong') })}\n`);
    case 'ansible.builtin.command': case 'ansible.builtin.shell': return out + each((h) => `${h} | CHANGED | rc=0 >>\n${stdout.replace(/\n+$/, '')}\n`);
    default: return out;
  }
}

/**
 * What `ansible-inventory --graph` prints for an inventory (cli/inventory.py _graph_group): each group's child groups, then its
 * own hosts, indented by "  |" per level; `all` lists no hosts of its own. Goldens: tests/golden/inv-*.txt.
 * @param groups Map name → { hosts: [names], children: [names] }, from checker.js's parseInventory
 */
export function renderGraph(groups) {
  const line = (text, depth) => (depth ? `${'  |'.repeat(depth)}--${text}` : text);
  const walk = (name, depth) => [line(`@${name}:`, depth), ...groups.get(name).children.flatMap((c) => walk(c, depth + 1)),
    ...(name === 'all' ? [] : groups.get(name).hosts.map((h) => line(h, depth + 1)))];
  return `${walk('all', 0).join('\n')}\n`;
}

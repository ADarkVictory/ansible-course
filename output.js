// Pure ES module, no DOM: the browser and Node run the same code.
// render prints what ansible-core 2.21.4's ansible-playbook prints (default callback, ANSIBLE_NOCOLOR=1, COLUMNS=80,
// forks=1) for plays from checker.js's parsePlaybook. Formats are copied from tests/golden/run-*.txt and unsupported-param.txt.
// renderAdhoc prints what `ansible <pattern> -m ...` prints (tests/golden/adhoc-*.txt); both share resolveHosts.
import { format, excerpt, pyRepr } from './checker.js';

const NEVER_CHANGES = new Set(['ansible.builtin.ping', 'ansible.builtin.debug', 'ansible.builtin.setup']);
const RECAP = ['ok', 'changed', 'unreachable', 'failed', 'skipped', 'rescued', 'ignored'];

// Display.banner: the message, a space, then stars to column 79 (never fewer than three), after a blank line.
const banner = (msg) => `\n${msg} ${'*'.repeat(Math.max(3, 79 - msg.length))}\n`;

// json.dumps(indent=4, sort_keys=True, ensure_ascii=False), as the callback prints module results.
const dump = (v) => JSON.stringify(v, (_, x) => x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a > b) - (a < b))) : x, 4);

const WARN_UNMATCHED = (p) => `[WARNING]: Could not match supplied host pattern, ignoring: ${p}\n`;
const LOCALHOST = ['localhost', '127.0.0.1', '::1'];

/**
 * Hosts a pattern selects, as ansible's inventory manager does (list order, never sorted).
 * @param patterns  a pattern string or an array of them (a play's `hosts:`); each is split on `,`, or else on `:`
 * @param inventory { group: [host, ...] }
 * @returns { hosts, unmatched } unmatched: names that are neither a group nor a host (real Ansible warns once per name, per run)
 * Patterns: plain host or group names, `all`, `*`/`?` globs, `a:b` union, `a:&b` intersection, `a:!b` exclusion.
 * Evaluation order is Ansible's: plain patterns, then every `&`, then every `!`; with no plain pattern it starts from `all`.
 * ponytail: `web[0]` subscripts, `~regex` patterns and nested groups are not resolved.
 */
export function resolveHosts(patterns, inventory) {
  const everyone = [...new Set(Object.values(inventory).flat())];
  const groups = { all: everyone, ungrouped: [], ...inventory };
  groups.all = everyone;
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

// ponytail: templating covers bare {{ name }} only (no filters or expressions); a lone {{ name }} keeps its type, as Ansible's does.
function tpl(v, vars) {
  if (typeof v !== 'string') return v;
  const whole = /^\{\{\s*(\w+)\s*\}\}$/.exec(v);
  if (whole && whole[1] in vars) return vars[whole[1]];
  return v.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

// Free-form "k=v" module args (debug: msg=hi, command: creates=/x touch /x) merged with the `args` keyword.
function argsOf(task) {
  if (typeof task.args !== 'string') return task.args;
  const kv = [...task.args.matchAll(/(\w+)=("[^"]*"|'[^']*'|\S+)/g)].map(([, k, v]) => [k, v.replace(/^(["'])(.*)\1$/, '$2')]);
  const extra = task.keywords.args;
  return { ...Object.fromEntries(kv), ...(typeof extra === 'object' && extra) };
}

// First run: every module changes except the ones that never do. Second run: only what real modules change again.
function isChanged(task, a, second) {
  const cw = task.keywords.changed_when;
  if (typeof cw === 'boolean') return cw;
  if (/^(true|false)$/i.test(cw)) return /^true$/i.test(cw);
  if (NEVER_CHANGES.has(task.module)) return false;
  if (!second) return true;
  // ponytail: a changed_when expression (usually over a registered result) is taken to settle on ok once things are in place.
  if (cw !== undefined) return false;
  switch (task.module) {
    case 'ansible.builtin.command': case 'ansible.builtin.shell': return !('creates' in a || 'removes' in a);
    case 'ansible.builtin.file': return a.state === 'touch';
    case 'ansible.builtin.service': case 'ansible.builtin.systemd_service': return a.state === 'restarted' || a.state === 'reloaded';
    default: return false;
  }
}

function debugResult(a, vars) {
  if (!('var' in a)) return { msg: tpl(a.msg ?? 'Hello world!', vars) };
  // ponytail: Ansible also prints a "[WARNING]: Encountered 1 template error." block with the var's Origin; not reproduced.
  return { [a.var]: a.var in vars ? vars[a.var] : `<< error 1 - '${a.var}' is undefined >>` };
}

/**
 * @param plays     parsePlaybook(...).plays
 * @param inventory { group: [host, ...] }
 * @param opts      { second?: run the playbook again over the first run's state, source?: the playbook text (for Origin) }
 */
export function render(plays, inventory, { second = false, source = '' } = {}) {
  const stats = {};
  const warned = new Set(); // Display.warning prints a given message once per run
  let out = '';

  run: for (const play of plays) {
    const { hosts, unmatched } = resolveHosts([play.hosts].flat(), inventory);
    for (const p of unmatched) if (!warned.has(p)) { warned.add(p); out += WARN_UNMATCHED(p); }
    out += banner(`PLAY [${play.name || [play.hosts].flat().join(',')}]`);
    if (!hosts.length) {
      out += 'skipping: no hosts matched\n';
      continue;
    }
    for (const h of hosts) stats[h] ??= {};
    const varsFor = (h, task) => ({ ...play.vars, ...task.keywords.vars, inventory_hostname: h });
    const notified = new Set();

    // Prints one task (or handler) on every host; returns 'failed' or 'error' when the run stops there.
    const exec = (task, kind) => {
      const label = (h) => (task.keywords.delegate_to ? `${h} -> ${task.keywords.delegate_to}` : h);
      out += banner(`${kind} [${tpl(task.name, varsFor(hosts[0], task)) || task.action}]`);
      // Golden: unsupported-param, raw-params. The [ERROR] block shows once, then a fatal line per host.
      const raw = task.rawParams && `Action '${task.module}' does not support raw params.`;
      if (task.unsupported || raw) {
        const msg = raw ? `Task failed: ${raw}` : task.unsupported;
        out += raw
          // Ansible wraps this one (raised while preparing the task) as "Task failed." caused by the error at the action key.
          ? format(msg, `\nTask failed.\n${excerpt(source, task.line, task.col)}\n\n<<< caused by >>>\n\n${raw}\n${excerpt(source, task.rawParams.line, task.rawParams.col)}`)
          : format(`Task failed: Module failed: ${msg}`, excerpt(source, task.line, task.col));
        for (const h of hosts) {
          out += `fatal: [${label(h)}]: FAILED! => {"changed": false, "msg": ${JSON.stringify(msg)}}\n`;
          stats[h].failed = 1;
        }
        return 'failed';
      }
      const a = argsOf(task);
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
  const resolve = (pattern) => {
    const r = resolveHosts(pattern, inventory);
    for (const p of r.unmatched) if (!warned.has(p)) { warned.add(p); out += WARN_UNMATCHED(p); }
    return r.hosts;
  };
  let hosts = resolve(cmd.pattern);
  if (cmd.flags.limit) {
    const keep = resolve(cmd.flags.limit);
    hosts = hosts.filter((h) => keep.includes(h));
    if (!hosts.length) return `${out}[ERROR]: Specified inventory, host pattern and/or --limit leaves us with no hosts to target.\n`;
  }
  if (!hosts.length) out += '[WARNING]: No hosts matched, nothing to do\n';
  if (cmd.flags['list-hosts']) return `${out}  hosts (${hosts.length}):\n${hosts.map((h) => `    ${h}\n`).join('')}`;
  if (cmd.noArg) return `${out}[ERROR]: No argument passed to ${cmd.mod} module\n`;
  if (!hosts.length) return out;

  const { mod } = cmd;
  const each = (line) => hosts.map(line).join('');
  const fatal = (msg) => each((h) => `${h} | FAILED! => ${dump({ changed: false, msg })}\n`);
  const task = `{'action': ${pyRepr(mod)}, 'args': ${pyRepr(cmd.typedArgs)}, 'timeout': 0, 'async_val': 0, 'poll': 15}`;
  // Golden: adhoc-unknown-module, adhoc-raw-params. Raised while preparing the task, so Ansible wraps it as "Task failed." caused by the -m option.
  const why = !cmd.known ? `Cannot resolve '${mod}' to an action or module.` : cmd.rawParams && `Action '${cmd.module}' does not support raw params.`;
  if (why) {
    return `${out}[ERROR]: Task failed: ${why}\n\nTask failed.\nOrigin: <adhoc '${mod}' task>\n\n${task}\n\n<<< caused by >>>\n\n${why}\n`
      + `Origin: <CLI option '-m'>\n\n${mod}\n\n${fatal(`Task failed: ${why}`)}`;
  }
  // Golden: adhoc-unsupported-param (short and FQCN spelling).
  if (cmd.unsupported) return `${out}[ERROR]: Task failed: Module failed: ${cmd.unsupported}\nOrigin: <adhoc '${mod}' task>\n\n${task}\n\n${fatal(cmd.unsupported)}`;
  switch (cmd.module) {
    case 'ansible.builtin.ping': return out + each((h) => `${h} | SUCCESS => ${dump({ changed: false, ping: String(cmd.args.data ?? 'pong') })}\n`);
    case 'ansible.builtin.command': case 'ansible.builtin.shell': return out + each((h) => `${h} | CHANGED | rc=0 >>\n${stdout.replace(/\n+$/, '')}\n`);
    default: return out;
  }
}

// Pure ES module, no DOM: the browser and Node run the same code.
// render prints what ansible-core 2.21.4's ansible-playbook prints (default callback, ANSIBLE_NOCOLOR=1, COLUMNS=80,
// forks=1) for plays from checker.js's parsePlaybook. Formats are copied from tests/golden/run-*.txt and unsupported-param.txt.
import { format, excerpt } from './checker.js';

const NEVER_CHANGES = new Set(['ansible.builtin.ping', 'ansible.builtin.debug', 'ansible.builtin.setup']);
const RECAP = ['ok', 'changed', 'unreachable', 'failed', 'skipped', 'rescued', 'ignored'];

// Display.banner: the message, a space, then stars to column 79 (never fewer than three), after a blank line.
const banner = (msg) => `\n${msg} ${'*'.repeat(Math.max(3, 79 - msg.length))}\n`;

// json.dumps(indent=4, sort_keys=True, ensure_ascii=False), as the callback prints module results.
const dump = (v) => JSON.stringify(v, (_, x) => x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a > b) - (a < b))) : x, 4);

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
  const all = [...new Set(Object.values(inventory).flat())];
  const stats = {};
  let out = '';

  run: for (const play of plays) {
    const hosts = [];
    for (const p of [play.hosts].flat().flatMap((x) => String(x).split(',')).map((x) => x.trim())) {
      const found = p === 'all' ? all : inventory[p] ?? (all.includes(p) || p === 'localhost' ? [p] : []);
      if (!found.length) out += `[WARNING]: Could not match supplied host pattern, ignoring: ${p}\n`;
      for (const h of found) if (!hosts.includes(h)) hosts.push(h);
    }
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

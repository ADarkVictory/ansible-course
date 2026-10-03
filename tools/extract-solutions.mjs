// Writes every `write` solution so CI can run real Ansible on it: playbooks to build/solutions/<id>.yml (ansible-playbook
// --syntax-check, ansible-lint), inventories (kind: inventory) to build/inventories/<id>.yml (ansible-inventory --list).
// Each test-only `right` answer goes beside it as <id>-right-<n>.yml: the course accepts it, so real Ansible must too.
// Fails unless the files on disk equal the write exercises in course.yaml (a duplicate id would overwrite a file and skip a check).
// Run: node tools/extract-solutions.mjs
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as yaml from '../vendor/js-yaml.mjs';

const root = new URL('../', import.meta.url);
const dirs = { playbook: new URL('build/solutions/', root), inventory: new URL('build/inventories/', root) };
const eligible = { playbook: 0, inventory: 0 };
for (const d of Object.values(dirs)) {
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
}
for (const m of yaml.load(readFileSync(new URL('course.yaml', root), 'utf8')).modules) {
  for (const l of m.lessons) {
    for (const e of yaml.load(readFileSync(new URL(`lessons/${m.dir}/${l.file}.ex.yaml`, root), 'utf8'))) {
      if (e.type !== 'write') continue;
      const kind = e.kind === 'inventory' ? 'inventory' : 'playbook';
      [e.solution, ...(e.right ?? [])].forEach((code, n) => {
        eligible[kind]++;
        writeFileSync(new URL(`${e.id}${n ? `-right-${n}` : ''}.yml`, dirs[kind]), code);
      });
    }
  }
}
let ok = true;
for (const [kind, d] of Object.entries(dirs)) {
  const written = readdirSync(d).length;
  console.log(`extract-solutions: ${written} ${kind} file(s) written of ${eligible[kind]} expected (solutions and right answers) in ${d.pathname.slice(root.pathname.length)}`);
  if (written !== eligible[kind]) ok = false;
}
if (!ok) {
  console.error('extract-solutions: counts differ (duplicate exercise ids?)');
  process.exit(1);
}

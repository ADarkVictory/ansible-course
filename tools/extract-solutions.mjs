// Writes every `write` solution to build/solutions/<id>.yml so CI can run real ansible-playbook and ansible-lint on it.
// Run: node tools/extract-solutions.mjs
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as yaml from '../vendor/js-yaml.mjs';

const root = new URL('../', import.meta.url);
const out = new URL('build/solutions/', root);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
let n = 0;
for (const m of yaml.load(readFileSync(new URL('course.yaml', root), 'utf8')).modules) {
  for (const l of m.lessons) {
    for (const e of yaml.load(readFileSync(new URL(`lessons/${m.dir}/${l.file}.ex.yaml`, root), 'utf8'))) {
      if (e.type !== 'write' || e.kind === 'inventory') continue; // inventory solutions are not playbooks
      writeFileSync(new URL(`${e.id}.yml`, out), e.solution);
      n++;
    }
  }
}
console.log(`extract-solutions: wrote ${n} solution(s) to build/solutions/`);

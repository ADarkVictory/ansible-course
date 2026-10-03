# Engine and Module 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Ponytail applies to every task (see `CLAUDE.md`).

**Goal:** A working, published-ready course site with the full simulation engine and Module 1 (Foundations).

**Architecture:** Static files served by GitHub Pages from `main` / root. A DOM-free engine (`checker.js`, `output.js`) checks learner input and renders Ansible output; `app.js` is the only file that touches the DOM. Every error string and output format is copied from real `ansible-core` runs captured into `tests/golden/`.

**Tech Stack:** Vanilla ES modules, vendored `js-yaml` 5.4.2 and `marked` 18.0.14, `node --test` (Node 22), `ansible-core` 2.21.4 and `ansible-lint` 26.9.0 on Python 3.13 (capture tooling and CI only).

**Spec:** `docs/superpowers/specs/2026-10-03-ansible-course-design.md`

## Global Constraints

- No build step. No runtime CDN. No npm dependencies; `package.json` exists only for `"type": "module"` and `"test": "node --test"`.
- Only `app.js` touches the DOM. `checker.js` and `output.js` must import in Node unchanged.
- URLs are hash routes: `#/<module-dir>/<lesson-file-stem>`.
- Simulated file path in every error message: `/home/student/playbook.yml` (inventory exercises: `/home/student/inventory.yml`).
- Module names resolve short → `ansible.builtin.<name>` unless the exercise sets `fqcn: true`.
- Every displayed Ansible error or output format matches a file in `tests/golden/` byte-for-byte (after the generator's substitutions).
- `localStorage` access is wrapped in try/catch; the site must fully work when it throws.
- Hint after first failure; **Show solution** after 3 failed attempts; `solutionShown` recorded in progress.
- All work happens on branch `engine-and-module-1`, delivered as one pull request into `main`; CI green before merge.
- Commit trailer on every commit: `Co-Authored-By` and `Claude-Session` lines as given in the session.

## Review Focus

1. **Tab characters** (pasted code, some keyboards): real Ansible rejects them with a YAML scanner error. Learner must see that exact error, plus the hint "Replace tabs with spaces." → test in Task 3.
2. **Curly quotes** (`“ ” ‘ ’` from phone smart punctuation): YAML accepts them as literal characters, so the learner's `name: “nginx”` silently means a package called `“nginx”`. Checker must fail with the hint "Your keyboard inserted curly quotes; use straight quotes." → test in Task 3.
3. **Free-form `k=v` arguments** (`ansible.builtin.dnf: name=nginx state=present`, `command: uptime`): valid Ansible, so a correct answer written this way must pass the same checks as the mapping form. → test in Task 4.
4. **Not a list of plays / empty editor:** a top-level mapping or empty input must produce Ansible's real errors, not a JS exception. → test in Task 3.
5. **Parameter aliases** (`pkg` for `name`, `dest` for `path` on `file`): accepted by real Ansible, so accepted and normalised to the canonical name before checks run. → test in Task 4.

---

### Task 1: Skeleton, vendored libraries, CI running tests

**Files:**
- Create: `package.json`, `vendor/js-yaml.mjs`, `vendor/marked.esm.js`, `vendor/LICENSES.md`, `.github/workflows/ci.yml`, `tests/vendor.test.mjs`

**Interfaces:**
- Produces: `import yaml from './vendor/js-yaml.mjs'` (default export with `load`), `import { marked } from './vendor/marked.esm.js'`.

- [ ] **Step 1: Write the failing test** `tests/vendor.test.mjs`: `yaml.load('a: 1').a === 1`; `marked.parse('# x')` contains `<h1`.
- [ ] **Step 2: Run** `npm test` → FAIL (modules missing).
- [ ] **Step 3: Vendor** via `npm pack js-yaml@5.4.2 marked@18.0.14`, copy the ESM builds into `vendor/`, record versions and MIT licence text in `vendor/LICENSES.md`.
- [ ] **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: CI** `ci.yml` on `push` and `pull_request`: job `test` (Node 22, `npm test`). The `ansible` job is added in Task 7.
- [ ] **Step 6: Commit** `chore: skeleton, vendored libs, CI`.

### Task 2: Golden captures and module registry from real Ansible

**Files:**
- Create: `tools/capture.sh`, `tools/gen-modules.py`, `tools/fixtures/*.yml`, `tests/golden/*.txt`, `modules.yaml`

**Interfaces:**
- Produces: `modules.yaml` shaped `{ "ansible.builtin.<m>": { params: [..canonical..], aliases: { alias: canonical }, freeform: bool } }` and golden files named below.

- [ ] **Step 1:** `tools/capture.sh` creates a venv (`uv venv -p 3.13`, `ansible-core==2.21.4`), copies each fixture to `/home/student/playbook.yml`, runs it with `ANSIBLE_NOCOLOR=1 ANSIBLE_FORCE_COLOR=0 COLUMNS=80`, inventory `web1 ansible_connection=local` / `web2 ansible_connection=local` in group `web`, and writes stdout+stderr to `tests/golden/<fixture>.txt`.
- [ ] **Step 2: Fixtures** (one file each): `yaml-indent` (bad indentation), `yaml-tab`, `empty`, `not-a-list`, `unknown-module` (`ansible.builtin.serivce`), `unsupported-param` (`ansible.builtin.file` with `pathh`), `unknown-play-keyword`, `unknown-task-keyword`, `run-sample` and `run-sample-second` (same playbook, run twice: `file` under `/tmp/{{ inventory_hostname }}`, `copy` notifying a `debug` handler, a bare `command`), `run-no-facts` (`gather_facts: false`), `adhoc-ping` (`ansible web -m ansible.builtin.ping`).
- [ ] **Step 3:** `tools/gen-modules.py` runs `ansible-doc --json` for: `ping command shell copy file user group dnf apt package service systemd_service lineinfile template debug setup` and writes `modules.yaml` (params, aliases, `freeform: true` for `command`/`shell`).
- [ ] **Step 4: Verify** each golden file is non-empty and `run-sample-second.txt` shows `ok` for `file`/`copy`, `changed` for `command`, no handler.
- [ ] **Step 5: Commit** `test: golden captures and module registry from ansible-core 2.21.4`.

### Task 3: Parse and structure layer

**Files:**
- Create: `checker.js`, `tests/checker-structure.test.mjs`

**Interfaces:**
- Consumes: `modules.yaml` (parsed object passed in), golden files.
- Produces: `parsePlaybook(source: string, registry): { plays: Play[] } | { error: string, hint?: string }` where `Play = { name?, hosts, become?, gather_facts?, tasks: Task[], handlers: Task[] }` and `Task = { name?, module: string /* FQCN */, args: object /* canonical names */, keywords: object /* notify, when, register, changed_when, creates… */ }`.

- [ ] **Step 1: Write failing tests**: for each error fixture, `parsePlaybook(fixtureSource, registry).error === golden` (golden text with the leading `[WARNING]`/inventory noise stripped by a documented rule); tab fixture also returns `hint: 'Replace tabs with spaces.'`; source containing `“` or `”` returns `hint` "Your keyboard inserted curly quotes; use straight quotes."; empty and not-a-list match their goldens; a valid playbook returns `plays` with short names expanded to FQCN.
- [ ] **Step 2: Run** `npm test` → FAIL.
- [ ] **Step 3: Implement `parsePlaybook`**: js-yaml `load`, map its `mark.line/column` onto Ansible's error template from the golden file; the task's module is its single key found in `registry`; anything else not in the task-keyword list is an unknown keyword/module.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: playbook parsing with authentic Ansible errors`.

### Task 4: Exercise checks

**Files:**
- Modify: `checker.js`
- Create: `tests/checker-checks.test.mjs`

**Interfaces:**
- Produces: `checkWrite(exercise, source, registry): { ok: boolean, output: string, hint?: string, failedCheck?: number }` (1-based). On `ok`, `output` comes from `render` (Task 5); `checkWrite` takes an optional `{ second: boolean }`.

- [ ] **Step 1: Write failing tests** using the spec's `handlers-1` exercise: solution → `ok`; template task without `notify` → `failedCheck: 1` with its hint; handler with `state: started` → `failedCheck: 2`; `forbid: { module: ansible.builtin.shell }` fails on a shell task; `dnf: name=nginx state=present` (free-form) passes a check `has: { name: nginx, state: present }`; `package: { pkg: nginx }` passes `has: { name: nginx }`; `play: { become: true }` check fails when absent; `fqcn: true` exercise rejects `copy:`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** check types `play`, `task`, `handler`, `forbid` (`has` matches args and keywords with deep equality on the given keys only); parse `k=v` strings for any module (and the bare command for `freeform` modules into `_raw_params`).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: exercise checks`.

### Task 5: Output generator

**Files:**
- Create: `output.js`, `tests/output.test.mjs`

**Interfaces:**
- Produces: `render(plays: Play[], inventory: { [group]: string[] }, opts: { second?: boolean }): string`.

- [ ] **Step 1: Write failing tests**: `render` of the parsed `run-sample` fixture equals `tests/golden/run-sample.txt` exactly; `{ second: true }` equals `run-sample-second.txt`; `run-no-facts` equals its golden; a `command` with `creates:` is `ok` on the second run; handlers appear only on the first run.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** header padding with `*` to the golden width, per-host status lines, `RUNNING HANDLER`, and the `PLAY RECAP` column layout copied from the golden.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: output generator matching ansible-core output`.

### Task 6: Command and choice exercises

**Files:**
- Modify: `checker.js`
- Create: `tests/checker-command.test.mjs`

**Interfaces:**
- Produces: `checkCommand(exercise, line, registry): { ok, output, hint?, failedCheck? }` with checks over `{ program, pattern, module, args, flags }`; `checkChoice(exercise, index): { ok: boolean, why: string }`.

- [ ] **Step 1: Write failing tests**: `ansible web -m ping` and `ansible web -m ansible.builtin.ping` both pass a check `{ program: ansible, pattern: web, module: ansible.builtin.ping }`, and the output equals `adhoc-ping.txt`; `-a "name=nginx state=present"` parses into args; quoted arguments with spaces survive; an unknown module produces the golden unknown-module error; `checkChoice` returns the chosen option's `why`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** a shell-word splitter (quotes and backslashes only) and the checks.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: command and choice exercises`.

### Task 7: Content tests and real-Ansible CI

**Files:**
- Create: `course.yaml`, `tests/content.test.mjs`, `tools/extract-solutions.mjs`, `.ansible-lint`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: `course.yaml` shaped `modules: [{ dir, title, lessons: [{ file, title }] }]`; content rules every lesson task relies on.

- [ ] **Step 1: Write failing tests** in `content.test.mjs`, iterating `course.yaml`: each lesson `.md` exists; each `.ex.yaml` parses; ids unique course-wide; each `write`/`command` solution is `ok`; each `wrong` fails at exactly `fails`; each `choice` has exactly one `correct: true` and every option has `why`. Seed `course.yaml` with Module 1 and a stub `lessons/01-foundations/01-what-is-ansible.md` + one `choice` exercise so the suite runs.
- [ ] **Step 2: Run** → FAIL until the stub lesson exists, then PASS. `course.yaml` lists only lessons that exist; Tasks 9–14 add the rest.
- [ ] **Step 3:** `tools/extract-solutions.mjs` writes every `write` solution to `build/solutions/<id>.yml`.
- [ ] **Step 4: CI job `ansible`** (Python 3.13, `ansible-core==2.21.4`, `ansible-lint==26.9.0`): extract, then `ansible-playbook --syntax-check -i web1,web2, <file>` and `ansible-lint` per file. Also rerun `tools/capture.sh` and `git diff --exit-code tests/golden` so drift in Ansible's output fails CI.
- [ ] **Step 5: Run locally** with the venv from Task 2 → all green.
- [ ] **Step 6: Commit** `test: content rules and real-Ansible CI`.

### Task 8: Site shell and exercise UI

**Files:**
- Create: `index.html`, `style.css`, `app.js`, `ui.js`, `tests/ui.test.mjs`

**Interfaces:**
- Consumes: `checkWrite`, `checkCommand`, `checkChoice`, `render`, `course.yaml`.
- Produces: `ui.js` (DOM-free): `parseRoute(hash): { module, lesson } | null`; `applyKey(text, start, end, key): { text, cursor }` for keys `indent`, `outdent`, `-`, `:`, `"`, `{{ }}`; `loadProgress(storage)` / `saveProgress(storage, data)` returning `{}` / no-op when `storage` throws.

- [ ] **Step 1: Write failing tests** for `ui.js`: `parseRoute('#/01-foundations/02-inventories')`; `parseRoute('')` → `null`; `applyKey` indent adds two spaces at the line start (also for multi-line selections), outdent removes up to two, `{{ }}` puts the cursor between the braces with a space each side; `loadProgress` with a throwing storage returns `{}`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** `ui.js`. **Step 4: Run** → PASS.
- [ ] **Step 5: Implement** `index.html` / `style.css` / `app.js` per spec §4: lesson Markdown rendered by `marked`, exercise blocks placed where the lesson contains `<!-- exercise: <id> -->`; a **Try it** button on each lesson code block copies it into the next editor below it; editor `<textarea>` with `autocapitalize="off" autocorrect="off" spellcheck="false"` and line gutter; sticky key bar and **Run**; **Run again** after success; hint/solution rules from Global Constraints; syllabus drawer with ticks; Previous/Next; `prefers-color-scheme` tokens.
- [ ] **Step 6: Verify in Chromium** (Playwright, `executablePath: '/opt/pw-browsers/chromium'`, served by `python3 -m http.server`) at 390×844 and 1280×800: open lesson 1, answer the choice wrongly then rightly, reload and see the tick persist, then repeat with `localStorage` blocked. Save screenshots to the scratchpad and send them to the user.
- [ ] **Step 7: Commit** `feat: site shell and exercise UI`.

### Tasks 9–14: Module 1 lessons

One task per lesson. Each task: write `lessons/01-foundations/<file>.md` and `.ex.yaml`, add the lesson to `course.yaml`, extend `modules.yaml`/check types only if an exercise needs it (with a test), run `npm test` and the Task 7 Ansible checks → green, commit `content: <lesson title>`. Each lesson has ≥ 3 exercises, ≥ 1 `wrong` per `write`/`command` exercise, and explains every term before an exercise uses it.

| Task | File | Teaches | Exercises (minimum) |
|---|---|---|---|
| 9 | `01-what-is-ansible` | control vs managed nodes, agentless SSH + Python, push model, idempotency, declarative vs imperative | 4 `choice` (incl. "which of these is idempotent?") |
| 10 | `02-inventories` | INI vs YAML inventory, groups, `children`, `all`/`ungrouped`, host vars inline | 2 `choice` on INI; 2 `write` YAML inventories (adds an `inventory` check type: `{ group, hosts?, children? }`, path `/home/student/inventory.yml`) |
| 11 | `03-ansible-cfg` | config file lookup order, `inventory`, `remote_user`, `become`, `forks`, `host_key_checking` | 3 `choice` (lookup order; which setting fixes a scenario) |
| 12 | `04-ad-hoc-commands` | `ansible <pattern> -m <module> -a <args>`, `-b`, `--limit`, patterns (`web:&prod`, `!db`), when ad-hoc is appropriate | 4 `command`, 1 `choice` |
| 13 | `05-modules-and-fqcn` | what a module is, FQCN and collections, `ansible-doc`, idempotent modules vs `command`/`shell`, return values `changed`/`ok` | 2 `command` (`ansible-doc`), 2 `choice`, 1 `write` (replace `shell: yum install` with `ansible.builtin.dnf`, `forbid` shell, `fqcn: true`) |
| 14 | `06-checkpoint` | Module 1 review | 5 `choice` + 1 larger `write` (inventory) + 1 `command` |

### Task 15: Publish readiness

**Files:**
- Create: `README.md`

- [ ] **Step 1:** `README.md`: what the course is, how to run it locally (`python3 -m http.server`), how to run tests, how to enable Pages (spec §8).
- [ ] **Step 2: Verify** a fresh clone served with `python3 -m http.server` loads `#/01-foundations/01-what-is-ansible` with no console errors (Playwright).
- [ ] **Step 3: Commit** `docs: README`.

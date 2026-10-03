# Ansible Course Site: Design

Date: 2026-10-03 · Status: awaiting review

## 1. Goal

A static, mobile-first course site that takes a learner with **no Ansible knowledge** (but working Linux knowledge) to the point where they can **start work on an enterprise Ansible codebase**.

- Audience: the repo owner first; the site is public once published.
- Scope: Linux managed nodes only. Windows, network devices, cloud and AWX/AAP are out of scope for now.
- Linux itself is not taught; only Ansible's way of doing Linux tasks (`ansible.builtin.user`, `systemd_service`, `dnf`/`apt`, `template`, `lineinfile`, `firewalld`, …).
- Enterprise practice (roles, collections, multi-environment inventories, Vault, ansible-lint, Molecule, CI) is in scope: it is part of "Linux" as practised professionally.
- Hosting: GitHub Pages, served straight from `main` / root. No server, no build step.
- Working rules: Superpowers workflow, with Ponytail applied at every stage (see `CLAUDE.md`).

## 2. Architecture

Plain static files. The browser fetches lesson Markdown and exercise YAML at runtime.

```
index.html              shell: top bar, syllabus drawer, lesson view
app.js                  hash router, lesson loading/rendering, progress (the only file that touches the DOM)
checker.js              pure ES module: parsePlaybook, parseInventory, parseCommand, checkWrite, checkCommand
                        (checkWrite and checkCommand → { ok, output, hint?, failedCheck? })
output.js               pure ES module: render, renderAdhoc, renderGraph, resolveHosts (Ansible's output for a run)
ui.js                   DOM-free helpers for app.js (routes, key bar, progress storage)
style.css
course.yaml             syllabus: ordered modules → lessons
modules.yaml            generated: modules the course simulates, their parameters, choices and argument checks
keywords.yaml           generated: play and task keywords, reserved variable names
lessons/<NN-module>/<NN-lesson>.md        lesson text
lessons/<NN-module>/<NN-lesson>.ex.yaml   lesson exercises
vendor/js-yaml.mjs, vendor/marked.esm.js  vendored, MIT, shared by site and tests
tests/*.test.mjs        node --test suites
tests/golden/           real ansible-core output; also served to the site for `output_golden`
tools/                  capture.sh (goldens), gen-modules.py (modules.yaml, keywords.yaml), extract-solutions.mjs,
                        fixtures/ (the playbooks, inventories and ansible.cfg the goldens come from)
.github/workflows/ci.yml
```

- **Routing:** hash URLs (`#/03-variables/02-precedence`). GitHub Pages cannot serve deep links otherwise.
- **Dependencies:** `js-yaml` and `marked`, vendored. No npm, no CDN at runtime.
- **Progress:** `localStorage`, wrapped in try/catch; the site works without it. Per device, no sync.
- `checker.js` has no DOM access, so the browser and Node run the identical code.

## 3. Exercises

### 3.1 Types

| Type | Input | Used for |
|---|---|---|
| `write` | multi-line YAML editor | writing or fixing playbooks, roles, vars (a "fix it" exercise is `write` with a broken `starter`) |
| `command` | single-line command box | ad-hoc commands, `ansible-playbook` flags, `ansible-vault`, `ansible-lint`, `molecule` |
| `choice` | tap one option | predict-the-output, spot-the-bug, code review; every option carries an explanation |

### 3.2 Exercise file format

```yaml
- id: handlers-1
  type: write
  task: Deploy nginx.conf from a template and restart nginx only when it changes.
  inventory: { web: [web1, web2] }
  starter: |
    - hosts: web
      become: true
      tasks:
  solution: |
    …
  checks:
    - task: { module: ansible.builtin.template }
      has: { notify: Restart nginx }
      hint: The template task never tells anything to restart.
    - handler: { name: Restart nginx, module: ansible.builtin.systemd_service }
      has: { state: restarted }
      hint: The handler must restart nginx.
  wrong:                       # test-only: typical mistakes and the check they must fail
    - code: |
        …
      fails: 1                 # 1-based index into checks; or fqcn, error, hint (below)
  right:                       # test-only: other correct answers; they must pass, and CI lints them
    - |
      …
```

- Every check carries a non-empty `hint`.
- `fails`: the 1-based check index; `fqcn` for the FQCN rule; `error` for input real Ansible stops on (its `[ERROR]` is the feedback, with no hint); `hint` for what the course does not simulate (its hint, with no output).
- `fqcn: true` requires every module named by FQCN (a runtime redirect such as `ansible.builtin.yum` fails it); `fqcn_hint` is the feedback, with a built-in default. The FQCN rule runs before the checks.
- `write` with `kind: inventory`: the learner writes the inventory, so there is no `inventory` key. Checks are `{ group, hosts?, children?, hint }`: the group is reachable from `all` and directly holds exactly those hosts and child groups, compared as sets; a key left out means none.
- `command`: checks are any of `program`, `pattern`, `hosts` (the hosts the pattern and `--limit` select, in any order), `module`, `args`, `flags` (long option names), plus `hint`. `inventory` is required except for `ansible-doc`, which reads none. `stdout` is what a `command` or `shell` module prints on each host. `output_golden: <stem>` shows `tests/golden/<stem>.txt` on success, for output the engine does not render (`ansible-doc`). `wrong` entries use `code` too.
- `choice`: `question`, optional `code`, and `options: [{ text, correct, why }]`; each option's `why` is its feedback.

### 3.3 Check pipeline (`write`)

Stops at the first failure.

1. **YAML parse** (js-yaml). On error: Ansible's own syntax-error text with file, line, column and the `^ here` marker.
2. **Structure** against `modules.yaml`: unknown module → `couldn't resolve module/action '…'`; bad arguments → the module's own failure, in ansible-core's order (mutually exclusive, required, choices, required_one_of/if/by, unsupported parameters), or the action plugin's for `copy` and `template`; unknown play/task keyword → Ansible's corresponding error. Short module names resolve to `ansible.builtin.*` unless an exercise requires FQCN. A real keyword or module the course does not model yet, or a template beyond `{{ name }}` of a play or task variable, gets a course hint ("This course doesn't simulate `when` yet."), never an invented error or a plain run.
3. **Exercise checks**, in order. The first failing check's `hint` is shown. Check vocabulary, extended only when a lesson needs it:
   - `play`: the play has the given keys/values.
   - `task` / `handler`: a task matching `{ module, name? }` exists, optionally with `has` parameters/keywords.
   - `forbid`: no task matches (for example `shell`/`command` where a module exists; plain-text secrets).
4. **Success output**, generated from the learner's playbook and the exercise inventory: `PLAY [...]`, `TASK [Gathering Facts]` (unless `gather_facts: false`), one `TASK [...]` per task with `changed:` per host, handlers under `RUNNING HANDLER`, then `PLAY RECAP`.
   - **Run again** renders the second run of the playbook that passed: modules report `ok`; bare `command`/`shell` still report `changed` unless `creates`, `removes` or `changed_when` is set; handlers fire only when a notifying task changes.

### 3.4 Help

The first failure shows the hint. After three failed attempts a **Show solution** button appears; using it is recorded in progress. A real Ansible `[ERROR]` shows no extra hint: the error is the feedback. `choice` exercises have no Show solution: each tapped option shows its `why`.

### 3.5 Error-text authenticity

Every simulated error message is taken from a real `ansible-core` run, not paraphrased. Exceptions:

- YAML errors outside the captured kinds keep Ansible's frame around js-yaml's reason.
- Whatever the course does not simulate shows a course hint, not Ansible text.
- A command exercise's `stdout` is hand-written host output inside Ansible's real frame.

## 4. Mobile lesson format

- One column; on wider screens it widens only to a comfortable reading width.
- Read → see → do: short prose, example, exercise; an exercise roughly every 3–5 minutes.
- Code blocks scroll sideways and never wrap. **Try it** copies an example into the nearest editor.
- Editor: `<textarea>`, monospaced, line-number gutter matching error line numbers, `autocapitalize/autocorrect/spellcheck` off.
- Key bar above the keyboard: indent, outdent (2 spaces), `-`, `:`, `{{ }}` (cursor placed inside), `"`.
- **Run** is sticky at the bottom. Output appears in a terminal-style pane that scrolls into view.
- Top bar: ☰ syllabus drawer with completion ticks, lesson title, lesson progress. Previous/Next at the foot. Nothing is locked.
- Each module ends with a checkpoint (choice questions + one larger `write` exercise). It reports readiness but does not gate.
- Light/dark follows the system setting.
- Deferred (YAGNI): offline mode, spaced repetition, editor syntax highlighting.

## 5. Syllabus

Targets current `ansible-core` and modern practice (FQCN, `loop`); legacy forms (`with_*`, short names) are taught for recognition only.

| # | Module | Content |
|---|---|---|
| 1 | Foundations | control/managed nodes, agentless SSH, idempotency, `ansible.cfg`, INI and YAML inventories, ad-hoc commands, modules and FQCN |
| 2 | Playbooks | plays, tasks, `become`, core modules (`dnf`/`apt`, `systemd_service`, `user`, `file`, `copy`, `lineinfile`), check mode and `--diff`, `changed_when`/`failed_when` |
| 3 | Variables and facts | `group_vars`/`host_vars`, facts, `register`, `set_fact`, magic variables, variable precedence |
| 4 | Jinja2 and templates | `template`, filters (`default`, `mandatory`, `selectattr`, `map`), tests, lookups, whitespace control |
| 5 | Control flow | `when`, loops, handlers, `block`/`rescue`/`always`, tags, `delegate_to`, `run_once`, `serial` |
| 6 | Roles | structure, `defaults` vs `vars`, dependencies, `argument_specs`, `import_*` vs `include_*` |
| 7 | Collections | Galaxy, `requirements.yml`, version pinning, `ansible-core` vs the `ansible` package |
| 8 | Secrets | Vault, `encrypt_string`, vault IDs, multiple vaults, `no_log` |
| 9 | Inventory at scale | per-environment inventories, group hierarchy, dynamic inventory concepts |
| 10 | Quality | `ansible-lint`, `yamllint`, Molecule scenarios, idempotency testing |
| 11 | Enterprise workflow | repository layout, CI pipelines, debugging (`-vvv`, `debug`, `assert`, `--start-at-task`), code review |
| 12 | Capstone | refactor a legacy, shell-heavy, plaintext-secret repository to enterprise standard; finish with a code-review round |

Build order: engine and module 1 first, then one module at a time. The course is usable after module 1 ships.

## 6. Testing

`node --test`, no dependencies beyond `vendor/`.

- Every `write`/`command` solution passes all checks.
- Every `wrong` entry fails at exactly its `fails` check.
- Every `write`/`command` exercise has at least one `wrong` entry; every lesson has at least three exercises.
- Lesson `output`/`fixture` blocks equal their golden or fixture; no other lesson or exercise text looks like Ansible output.
- Every `choice` exercise has exactly one correct option, and every option has a `why`.
- Every lesson in `course.yaml` has its `.md`; every `.ex.yaml` parses; exercise ids are unique.
- Output generator: unit tests for first run, second run (idempotency), handlers, `gather_facts: false`.

### CI (GitHub Actions, on push and pull request)

1. `node --test`
2. Install `ansible-core` and `ansible-lint`. Regenerate the goldens, `modules.yaml` and `keywords.yaml` from real ansible-core and fail on any drift.
3. Write each `write` solution and `right` entry to a file and run `ansible-playbook --syntax-check` and `ansible-lint` (production profile, `.ansible-lint`) on it. A solution that real Ansible rejects fails the build.
4. Parse each inventory solution with `ansible-inventory --list`; any stderr output fails the build.

## 7. Delivery

- One branch and one pull request per unit of work (engine, then each module). CI must be green before merging to `main`.
- GitHub Pages publishes `main` / root as-is; no deploy job.
- Site URL: `https://adarkvictory.github.io/ansible-course/`.

## 8. Open decision

The repository is private. GitHub Pages publishes private repositories only on paid plans. Before publishing, the owner must either make the repository public or use a paid plan, then enable Pages (Settings → Pages → Deploy from a branch → `main` / root). This does not block building.

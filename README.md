# Ansible course

Ansible from zero to enterprise-ready, taught in the browser on a phone-sized screen. Learners write playbooks, inventories and commands into a simulator, and every output and error it shows is real ansible-core 2.21.4 output, byte for byte. Module 1 (Foundations) is published; modules 2 to 12 are planned.

Modules: 1 Foundations, 2 Playbooks, 3 Variables and facts, 4 Jinja2 and templates, 5 Control flow, 6 Roles, 7 Collections, 8 Secrets, 9 Inventory at scale, 10 Quality, 11 Enterprise workflow, 12 Capstone.

Static site, no build step, no runtime CDN, no npm dependencies.

## Run it locally

```sh
python3 -m http.server
```

Open <http://localhost:8000/>. Lessons are hash routes, for example `http://localhost:8000/#/01-foundations/01-what-is-ansible`.

## Tests

```sh
npm test
```

Needs Node 22 and no install. It runs the engine, golden-output and lesson-content tests (`node --test`).

### Checks against real Ansible

CI also regenerates everything derived from real Ansible and lints every solution. To run them locally:

```sh
python3.13 -m venv .venv
.venv/bin/pip install ansible-core==2.21.4 ansible-lint==26.9.0
sudo mkdir -p /home/student && sudo chown "$USER" /home/student   # the simulated file paths live here
export PATH="$PWD/.venv/bin:$PATH"
```

Then run the `run:` steps of the `ansible` job in `.github/workflows/ci.yml`.

The drift check is its `git diff --exit-code`: after regenerating, any difference from the committed files means the simulated course no longer matches real ansible-core, so the change is a bug in the engine, the lesson or the fixtures. Commit regenerated files only when the drift is understood.

## Publish

1. Make the repository public, or use a paid plan: GitHub Pages serves private repositories only on paid plans.
2. Settings → Pages → Deploy from a branch → `main` / root.
3. The site is then at <https://adarkvictory.github.io/ansible-course/>.

No deploy job: Pages publishes `main` as is. CI must be green before merging to `main`.

## Writing lessons

The learner knows Linux well and has zero Ansible. Teach Ansible, not Linux. Teach current practice (FQCN, `loop`); show legacy forms only so they can be recognised. The simulated managed nodes are RHEL-family with systemd (`dnf`, `firewalld`).

Add a lesson as `lessons/<NN-module>/<NN-lesson>.md` plus `<NN-lesson>.ex.yaml`, and list it in `course.yaml`. Extend `modules.yaml` or a check type only when an exercise needs it, with a test. Run `npm test`, then the real-Ansible checks above.

### Accuracy

- Every claim about Ansible must hold for ansible-core 2.21.4. Verify against the real thing (`ansible-doc`, `ansible-config`, the source), not memory.
- Every output or error a learner sees comes from the engine or a captured golden. Never paste output by hand, including in prose. The one exception is a command exercise's `stdout`: the host's own output inside Ansible's real frame.
- What the engine does not model (a keyword, a module, a template beyond `{{ name }}`) gets a course hint such as "This course doesn't simulate `when` yet.", never Ansible text the engine made up.
- Simulated errors name `/home/student/playbook.yml` (inventory exercises: `/home/student/inventory.yml`).
- A short module name resolves to `ansible.builtin.<name>` unless the exercise sets `fqcn: true`.

### Lesson text

Short paragraphs, H2 sections, one idea per section, code blocks for YAML (` ```yaml `) and commands (` ```bash `; those two get a Try it button). If a sentence does not teach, cut it. Explain every term before an exercise uses it. Read, see, do: an exercise every few minutes, at least three per lesson (the tests enforce it). Place each exercise with `<!-- exercise: <id> -->`, exactly once. Ids are `<lesson-slug>-<n>`, unique course-wide.

### Output and fixture markers

- `<!-- output: <stem> -->` right before an ` ```output ` block: it must equal `tests/golden/<stem>.txt`. Capture new goldens by adding them to `tools/capture.sh`.
- `<!-- fixture: <stem> -->` right before the playbook block that produced a shown output: it must equal `tools/fixtures/<stem>.yml` (or `.ini`).
- A code block that looks like Ansible output and has no output marker fails the tests.

### Exercises

Each `.ex.yaml` is a list. Common keys: `id`, `type` (`choice`, `write` or `command`).

**`choice`**: `question`, optional `code` (shown as a code block), `options` (`text`, `why`, `correct`). Exactly one `correct: true`. Every `why` teaches: wrong options name the misconception, the right one says why. Distractors are plausible mistakes.

**`write`**: the learner writes a playbook.
- `task`, `starter`, `solution`, `inventory` (`{ group: [hosts] }`, the hosts the simulated run uses)
- `checks`, each with one of `play`, `task`, `handler` or `forbid`, plus optional `has`, and a non-empty `hint` (required; the tests enforce it) that nudges without giving the answer. `task`, `handler` and `forbid` take `{ module, name? }` (short names mean `ansible.builtin`). `has` lists parameters or keywords the task must carry, by their canonical names (`forbid` plus `has` forbids that combination); the free-form text of `command` and `shell` is `_raw_params`, and `mode` is a quoted octal string such as `"0644"`. `play` takes the keywords the play must carry.
- `fqcn: true` requires every module to be an FQCN, with `fqcn_hint` as the feedback. It runs before the checks, and a runtime redirect such as `ansible.builtin.yum` counts as a failure.

**`write` with `kind: inventory`**: the learner writes `/home/student/inventory.yml`. No `inventory` key. Each check is `{ group, hosts?, children?, hint }`: the group must be reachable from `all` and directly hold exactly those hosts and child groups; leaving `hosts` or `children` out means none. An inventory Ansible warns about never passes.

**`command`**: the learner types an `ansible` or `ansible-doc` line.
- `task`, `solution`, `inventory` (not for `ansible-doc`, which reads none).
- `checks`, each any of `program`, `pattern`, `hosts` (the hosts the pattern and `--limit` select, in any order), `module`, `args`, `flags` (long option names), plus `hint`.
- `stdout`: what a `command` or `shell` module prints on each host. `output_golden: <stem>`: show `tests/golden/<stem>.txt`, for what the engine cannot render (`ansible-doc`).

**Test-only keys**, never shown to the learner:
- `wrong`: a list of `{ code, fails }` mistakes. `fails` is the 1-based index of the check that must catch it, `fqcn` for the FQCN rule, `error` for a playbook or command on which real Ansible stops (its `[ERROR]` is the feedback, with no hint), or `hint` for input whose real output the course does not simulate or cannot print byte for byte (a course hint, with no output). Every `write` and `command` exercise has at least one `wrong` (the tests enforce it).
- `right`: other correct answers that real Ansible and ansible-lint accept. They must pass the checks. Use for alternative spellings, such as `k=v` arguments or parameter aliases.

The UI gives the hint after the first failed attempt and **Show solution** after three.

### Solutions

Every `write` solution and `right` entry must pass `ansible-playbook --syntax-check` and `ansible-lint` (production profile: FQCN, every play and task named). Inventory solutions must parse with `ansible-inventory` without a warning. CI checks all of them.

## Layout

- `index.html`, `style.css`: the single page and its styles.
- `app.js`: router, lesson rendering, exercise UI, progress in `localStorage`. The only file that touches the DOM.
- `ui.js`: DOM-free helpers for `app.js` (route parsing and the like), so Node can test them.
- `checker.js`: parses and checks learner input (`write`, `command`, inventory; `app.js` checks `choice` itself). Pure, runs in Node.
- `output.js`: renders Ansible's output for a run. Pure, runs in Node.
- `course.yaml`: syllabus, the ordered modules and lessons.
- `modules.yaml`, `keywords.yaml`: modules, their parameters and argument checks, play and task keywords and reserved variable names, generated from ansible-core by `tools/gen-modules.py`.
- `lessons/<NN-module>/`: lesson `.md` and `.ex.yaml` files.
- `vendor/`: vendored `js-yaml` and `marked` (licences in `vendor/LICENSES.md`).
- `tests/`: `node --test` suites; `tests/golden/` holds real Ansible output.
- `tools/`: `capture.sh`, the generators, `extract-solutions.mjs`, and `fixtures/` (playbooks, inventories and `ansible.cfg` the goldens come from).
- `docs/superpowers/`: design spec and implementation plan.
- `.github/workflows/ci.yml`: CI (`npm test`; regenerate-and-drift check; solution lint).
- `CLAUDE.md`, `.claude/`: working rules and skills for Claude Code.
- `.ansible-lint`: the production profile every solution must pass.

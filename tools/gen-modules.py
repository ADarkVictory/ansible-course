#!/usr/bin/env python3
"""Writes modules.yaml (from ansible-doc and real module runs) and keywords.yaml (from ansible-core's classes). Run: python tools/gen-modules.py, with the Python that has ansible-core 2.21.4 (.venv/bin/python locally; after tools/capture.sh made the venv)."""
import json, operator, os, re, subprocess, sys
from pathlib import Path
import yaml
from ansible.parsing.mod_args import ModuleArgsParser
from ansible.playbook.block import Block
from ansible.playbook.play import Play

MODULES = "ping command shell copy file user group dnf apt package service systemd_service lineinfile template debug setup".split()
FREEFORM = {"command", "shell"}
root = Path(__file__).resolve().parent.parent
doc = Path(sys.executable).parent / "ansible-doc"  # not resolved: keep the venv's bin dir

# Args that get each module past required-arg checks so the real "Unsupported parameters" message appears.
# Simulated nodes are RHEL-family + systemd, so `use` pins package and service to the backend such a host picks.
VALID = {
    "ping": {}, "apt": {}, "debug": {}, "setup": {},
    "command": {"cmd": "x"}, "shell": {"cmd": "x"},
    "copy": {"content": "x", "dest": "/tmp/x"}, "file": {"path": "/tmp/x"},
    "user": {"name": "x"}, "group": {"name": "x"}, "dnf": {"name": "x", "use_backend": "dnf4"},
    "lineinfile": {"path": "/tmp/x"}, "template": {"src": "/dev/null", "dest": "/tmp/x"},
    "systemd_service": {"name": "x"},
    "package": {"name": "x", "use": "dnf", "use_backend": "dnf4"}, "service": {"name": "x", "use": "systemd"},
}
env = {**os.environ, "ANSIBLE_NOCOLOR": "1", "ANSIBLE_FORCE_COLOR": "0", "ANSIBLE_FORKS": "1", "COLUMNS": "80", "LC_ALL": "C.UTF-8"}
inventory = root / "tools/fixtures/inventory.ini"

def unsupported(m, name):
    """(module name the message reports, text after 'Supported parameters include: ' through the final '.'),
    from the real module run as `name` with a bogus param."""
    args = json.dumps({**VALID[m], "zz_bogus": 1})
    run = subprocess.run([doc.with_name("ansible"), "web1", "-i", inventory, "-m", name, "-a", args],
                         capture_output=True, text=True, env=env, cwd=root / "tools")
    found = re.search(r"Unsupported parameters for \((.+?)\) module: zz_bogus\. Supported parameters include: (.+\.)$", run.stdout + run.stderr, re.M)
    if not found:
        sys.exit(f"gen-modules: no 'Supported parameters' message for {name}:\n{run.stdout}{run.stderr}")
    return found.groups()

# Parameters with `choices` whose bad value the module itself rejects; these skip it: the action plugin acts on the value first.
CHOICE_SKIP = {("dnf", "use_backend"): "picks the dnf backend (and fails on a host without dnf)",
               ("package", "use_backend"): "picks the backend", ("template", "newline_sequence"): "prints its own message"}

def choices(m, p, documented):
    """The module's own choices for p, in argument-spec order: the order 'value of p must be one of: ...' prints (ansible-doc may
    list them in another order), from the real module run with a bad value."""
    run = subprocess.run([doc.with_name("ansible"), "web1", "-i", inventory, "-m", "ansible.builtin." + m, "-a",
                          json.dumps({**VALID[m], p: "zz_bogus"})], capture_output=True, text=True, env=env, cwd=root / "tools")
    found = re.search(rf'"msg": "value of {p} must be one of: (.+), got: zz_bogus"', run.stdout + run.stderr)
    if not found or set(found[1].split(", ")) != {str(c) for c in documented}:
        sys.exit(f"gen-modules: no choices message for {m} {p} matching {documented}:\n{run.stdout}{run.stderr}")
    return found[1].split(", ")

docs = json.loads(subprocess.check_output([doc, "--json", *("ansible.builtin." + m for m in MODULES)], text=True))
out = {}
for m in MODULES:
    fq = "ansible.builtin." + m
    opts = docs[fq]["doc"].get("options") or {}
    # free_form is a doc-only pseudo-option for command/shell; the real arg is the free-form string, flagged by freeform below.
    names = sorted(n for n in opts if n != "free_form")
    out[fq] = {
        "params": names,
        "aliases": {a: n for n in names for a in sorted(opts[n].get("aliases") or [])},
        "freeform": m in FREEFORM,
    }
    # The message names the module that actually ran (action plugins run e.g. ansible.legacy.copy), which also differs
    # between the short and the FQCN spelling, so both are recorded.
    (short, _), (long, out[fq]["supported"]) = unsupported(m, m), unsupported(m, fq)
    out[fq]["reports_as"] = {"short": short, "fqcn": long}
    # package runs dnf, which checks the values (package documents no choices of its own).
    spec_opts = docs["ansible.builtin." + ("dnf" if m == "package" else m)]["doc"].get("options") or {}
    out[fq]["choices"] = {p: choices(m, p, o["choices"]) for p, o in spec_opts.items() if "choices" in o and (m, p) not in CHOICE_SKIP}
# package and service are action plugins that run dnf / systemd_service (reports_as, and the borrowed "supported" text), so
# they accept those modules' aliases too: `package: pkg=nginx` is `name`. Checks compare canonical names.
for m, backend in {"package": "dnf", "service": "systemd_service"}.items():
    out["ansible.builtin." + m]["aliases"] |= out["ansible.builtin." + backend]["aliases"]
# Every real ansible.builtin module (short names), so a module the course does not simulate yet is told apart from a typo.
#   twins:      real names whose module file is byte-identical to a simulated module's (systemd is systemd_service); they run as it and
#               are named as typed in "Unsupported parameters".
#   redirects:  ansible_builtin_runtime.yml action routing to another ansible.builtin name (yum -> dnf); they run as the target.
#   tombstones: removed names and the exact text ansible-core 2.21.4 prints for them; `kind` is the routing section they come from
#               (action: raised before the task runs, module: a failure at run time).
import ansible, ansible.modules
listed = json.loads(subprocess.check_output([doc, "-l", "-t", "module", "--json", "ansible.builtin"], text=True))
known = sorted(n.removeprefix("ansible.builtin.") for n in listed)
module_dir = Path(ansible.modules.__path__[0])
twins = {}
for n in known:
    for m in MODULES:
        if n != m and (module_dir / f"{n}.py").read_bytes() == (module_dir / f"{m}.py").read_bytes():
            twins["ansible.builtin." + n] = "ansible.builtin." + m
routing = yaml.safe_load((Path(ansible.__file__).parent / "config/ansible_builtin_runtime.yml").read_text())["plugin_routing"]
redirects = {"ansible.builtin." + n: e["redirect"] for n, e in routing["action"].items() if e.get("redirect", "").startswith("ansible.builtin.")}
tombstones = {}
for section, kind, label in (("action", "action", "action plugin"), ("modules", "module", "module")):
    for n, e in routing[section].items():
        t = e.get("tombstone")
        if t and "ansible.builtin." + n not in tombstones:
            when = f"after {t['removal_date']}" if "removal_date" in t else sys.exit(f"gen-modules: tombstone {n} has no removal_date")
            tombstones["ansible.builtin." + n] = {"kind": kind, "message": f"The 'ansible.builtin.{n}' {label} has been removed. {t['warning_text']} This feature was removed from ansible-core in a release {when}."}
out["known"] = known
out["twins"] = twins
out["redirects"] = redirects
out["tombstones"] = tombstones
(root / "modules.yaml").write_text(yaml.safe_dump(out, sort_keys=False, width=1000))

# Keyword sets, read from the real classes (2.21.4), not from memory. Written to keywords.yaml.
#   play:  Play fields in Base.load_data's load order (sorted by FieldAttribute priority); the task lists load in this order.
#   task:  the keys ModuleArgsParser treats as task keywords (Task + Handler fields, local_action, static); any other key is an action candidate.
#   block: Block fields.
keywords = {
    "play": [n for n, _ in sorted(Play.fattributes.items(), key=operator.itemgetter(1))],
    "task": sorted(ModuleArgsParser({})._task_attrs),
    "block": sorted(Block.fattributes),
}
(root / "keywords.yaml").write_text(yaml.safe_dump(keywords, sort_keys=False, width=1000))

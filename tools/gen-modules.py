#!/usr/bin/env python3
"""Writes modules.yaml (from ansible-doc and real module runs) and keywords.yaml (from ansible-core's classes). Run: .venv/bin/python tools/gen-modules.py (after tools/capture.sh made the venv)."""
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
# package and service are action plugins that run dnf / systemd_service (reports_as, and the borrowed "supported" text), so
# they accept those modules' aliases too: `package: pkg=nginx` is `name`. Checks compare canonical names.
for m, backend in {"package": "dnf", "service": "systemd_service"}.items():
    out["ansible.builtin." + m]["aliases"] |= out["ansible.builtin." + backend]["aliases"]
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

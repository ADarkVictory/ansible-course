#!/usr/bin/env python3
"""Writes modules.yaml from ansible-doc. Run: .venv/bin/python tools/gen-modules.py (after tools/capture.sh made the venv)."""
import json, os, re, subprocess, sys
from pathlib import Path
import yaml

MODULES = "ping command shell copy file user group dnf apt package service systemd_service lineinfile template debug setup".split()
FREEFORM = {"command", "shell"}
root = Path(__file__).resolve().parent.parent
doc = Path(sys.executable).parent / "ansible-doc"  # not resolved: keep the venv's bin dir

# Args that get each module past required-arg checks so the real "Unsupported parameters" message appears.
# package and service are absent: they delegate to a host-dependent backend, handled after the loop below.
VALID = {
    "ping": {}, "apt": {}, "debug": {}, "setup": {},
    "command": {"cmd": "x"}, "shell": {"cmd": "x"},
    "copy": {"content": "x", "dest": "/tmp/x"}, "file": {"path": "/tmp/x"},
    "user": {"name": "x"}, "group": {"name": "x"}, "dnf": {"name": "x", "use_backend": "dnf4"},
    "lineinfile": {"path": "/tmp/x"}, "template": {"src": "/dev/null", "dest": "/tmp/x"},
    "systemd_service": {"name": "x"},
}
env = {**os.environ, "ANSIBLE_NOCOLOR": "1", "ANSIBLE_FORCE_COLOR": "0", "ANSIBLE_FORKS": "1", "COLUMNS": "80", "LC_ALL": "C.UTF-8"}
inventory = root / "tools/fixtures/inventory.ini"

def supported(m):
    """Text after 'Supported parameters include: ' through the final '.', from the real module run with a bogus param."""
    args = json.dumps({**VALID[m], "zz_bogus": 1})
    run = subprocess.run([doc.with_name("ansible"), "web1", "-i", inventory, "-m", "ansible.builtin." + m, "-a", args],
                         capture_output=True, text=True, env=env, cwd=root / "tools")
    found = re.search(r"Supported parameters include: (.+\.)$", run.stdout + run.stderr, re.M)
    if not found:
        sys.exit(f"gen-modules: no 'Supported parameters' message for {m}:\n{run.stdout}{run.stderr}")
    return found.group(1)

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
    if m in VALID:
        out[fq]["supported"] = supported(m)
# Simulated nodes are RHEL-family + systemd; the real text depends on the host's backend, so package borrows dnf's and service systemd_service's.
for m, backend in (("package", "dnf"), ("service", "systemd_service")):
    out["ansible.builtin." + m]["supported"] = out["ansible.builtin." + backend]["supported"]
(root / "modules.yaml").write_text(yaml.safe_dump(out, sort_keys=False, width=1000))

#!/usr/bin/env python3
"""Writes modules.yaml from ansible-doc. Run: .venv/bin/python tools/gen-modules.py (after tools/capture.sh made the venv)."""
import json, subprocess, sys
from pathlib import Path
import yaml

MODULES = "ping command shell copy file user group dnf apt package service systemd_service lineinfile template debug setup".split()
FREEFORM = {"command", "shell"}
root = Path(__file__).resolve().parent.parent
doc = Path(sys.executable).parent / "ansible-doc"  # not resolved: keep the venv's bin dir

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
(root / "modules.yaml").write_text(yaml.safe_dump(out, sort_keys=False, width=1000))

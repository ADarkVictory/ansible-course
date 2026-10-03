#!/usr/bin/env bash
# Regenerates tests/golden/*.txt from real ansible-core 2.21.4 (stdout+stderr together).
# Each golden is what a learner sees after, from /home/student:
#   ansible-playbook -i tools/fixtures/inventory.ini /home/student/playbook.yml   (every fixture but adhoc-ping)
#   ansible web -i tools/fixtures/inventory.ini -m ansible.builtin.ping           (adhoc-ping)
#   ansible-playbook -i tools/fixtures/inventory-multi.ini playbook.yml           (run-hosts-patterns)
#   ansible <args> -i tools/fixtures/inventory-multi.ini                          (adhoc-*, see the adhoc calls below)
#   list-hosts.json: ansible <pattern> --list-hosts over inventory-multi.ini      (tools/gen-hosts.py)
#   ansible-inventory -i inventory.yml --graph                                    (inv-*: the fixture as /home/student/inventory.yml)
#   ansible-inventory -i inventory.ini --graph                                    (inventory-lesson: the INI fixture)
#   ansible --version, ansible-config dump --only-changed with ansible.cfg        (cfg-*: tools/fixtures/ansible-cfg.ini)
# ANSIBLE_FORKS=1 keeps host order deterministic (web1 before web2); default forks=5 races.
# <name>-second is <name>.yml run a second time with no cleanup in between.
# Needs: ansible-core 2.21.4 (the .venv, an active environment, or uv + python3.13 to make the .venv) and a writable /home/student (CI: sudo mkdir -p /home/student && sudo chown $USER /home/student).
set -u
root=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p /home/student 2>/dev/null
[ -w /home/student ] || { echo "capture.sh: /home/student must exist and be writable (sudo mkdir -p /home/student && sudo chown \$USER /home/student)" >&2; exit 1; }

# Which Python environment: the repo's .venv, else the already-active one (CI: setup-python + pip install ansible-core==2.21.4), else make .venv with uv.
if [ -x "$root/.venv/bin/ansible" ]; then bin="$root/.venv/bin"
elif command -v ansible >/dev/null; then bin=$(dirname "$(command -v ansible)")
else
  uv venv -p 3.13 "$root/.venv" && uv pip install -p "$root/.venv/bin/python" ansible-core==2.21.4 || exit 1
  bin="$root/.venv/bin"
fi

# PYTHONUNBUFFERED: Ansible writes stdout and stderr with no flush of its own, so into one file the order of [WARNING] lines against
# stdout depends on buffering (it differed between machines). Unbuffered, the file holds them in emission order.
export PATH="$bin:$PATH" PYTHONUNBUFFERED=1 ANSIBLE_NOCOLOR=1 ANSIBLE_FORCE_COLOR=0 ANSIBLE_FORKS=1 COLUMNS=80 LC_ALL=C.UTF-8
inv="$root/tools/fixtures/inventory.ini"
out="$root/tests/golden"
mkdir -p "$out"
cd /home/student || exit 1

for f in yaml-indent yaml-tab empty not-a-list unknown-module unsupported-param unknown-play-keyword task-keyword-typo \
         yaml-colon yaml-unclosed-quote yaml-dedent yaml-mapping-values no-action task-not-a-dict hosts-missing args-unbalanced-quote raw-params missing-handler tombstone-include tombstone-module yum-unsupported \
         run-sample run-sample-second run-no-facts run-idempotency run-idempotency-second run-intro run-intro-second adhoc-ping; do
  src=${f%-second}
  [ "$src" != "$f" ] || rm -rf /tmp/web1 /tmp/web2 /tmp/app   # fresh hosts; the second run must see the first run's state
  if [ "$f" = adhoc-ping ]; then
    ansible web -i "$inv" -m ansible.builtin.ping > "$out/$f.txt" 2>&1
  else
    cp "$root/tools/fixtures/$src.yml" /home/student/playbook.yml
    ansible-playbook -i "$inv" /home/student/playbook.yml > "$out/$f.txt" 2>&1
  fi
done

# Multi-group inventory (web1 web2 | db1 | prod = web1 db1 | staging = web2): host patterns, ad-hoc runs.
invm="$root/tools/fixtures/inventory-multi.ini"
cp "$root/tools/fixtures/hosts-patterns.yml" /home/student/playbook.yml
ansible-playbook -i "$invm" /home/student/playbook.yml > "$out/run-hosts-patterns.txt" 2>&1 < /dev/null
rm -f /home/student/playbook.yml
adhoc() { f=$1; shift; ansible "$@" -i "$invm" > "$out/$f.txt" 2>&1 < /dev/null; }
adhoc adhoc-command web -m command -a 'echo hello'
adhoc adhoc-command-empty web -m ansible.builtin.command -a true
adhoc adhoc-shell web -m shell -a 'echo hi; echo there'
adhoc adhoc-ping-data web -m ping -a 'data="a b"'
adhoc adhoc-unknown-module web -m ansible.builtin.serivce
adhoc adhoc-unsupported-param web -m ping -a bogus=x
adhoc adhoc-unsupported-param-fqcn web -m ansible.builtin.ping -a bogus=x
adhoc adhoc-raw-params web -m ping -a hello
adhoc adhoc-no-hosts nosuch -m ping
adhoc adhoc-no-command-arg web
adhoc adhoc-no-hosts-no-arg nosuch -m shell
adhoc adhoc-yml-pattern playbook.yml
adhoc adhoc-include-tombstone web -m include
adhoc adhoc-module-tombstone web -m bigip_facts
adhoc adhoc-yum-unsupported web -m yum -a 'name=x use_backend=dnf4 bogus=1'
adhoc adhoc-unsupported-param-redirect web -m systemd -a 'name=x bogus=1'
adhoc adhoc-limit 'web:db' -m ping --limit prod
adhoc adhoc-limit-empty web -m ping --limit db
adhoc adhoc-limit-unmatched nosuch -m ping --limit nosuch
# Inventory exercises: what the learner's inventory.yml makes ansible-inventory print (stdout and stderr together).
for src in "$root"/tools/fixtures/inv-*.yml; do
  f=$(basename "$src" .yml)
  cp "$src" /home/student/inventory.yml
  ansible-inventory -i inventory.yml --graph > "$out/$f.txt" 2>&1 < /dev/null
done
rm -f /home/student/inventory.yml
cp "$root/tools/fixtures/inventory-lesson.ini" /home/student/inventory.ini
ansible-inventory -i inventory.ini --graph > "$out/inventory-lesson.txt" 2>&1 < /dev/null
rm -f /home/student/inventory.ini
# ansible.cfg lesson (cfg-*): the lesson's project config as /home/student/ansible.cfg. The capture's own ANSIBLE_* variables are
# unset, or ansible-config would list them as changed settings. cfg-world-writable: the warning alone (stderr), from a 0777 directory.
cp "$root/tools/fixtures/ansible-cfg.ini" /home/student/ansible.cfg
cfg() { env -u ANSIBLE_NOCOLOR -u ANSIBLE_FORCE_COLOR -u ANSIBLE_FORKS "$@" 2>&1 < /dev/null; }
cfg ansible --version | sed -n 1,2p > "$out/cfg-version.txt"
cfg ansible-config dump --only-changed > "$out/cfg-dump.txt"
cfg ANSIBLE_FORKS=50 ansible-config dump --only-changed | grep FORKS > "$out/cfg-dump-env.txt"
mkdir -p /home/student/shared && chmod 0777 /home/student/shared && cp /home/student/ansible.cfg /home/student/shared/
(cd /home/student/shared && ansible --version 2>&1 > /dev/null < /dev/null) > "$out/cfg-world-writable.txt"
rm -rf /home/student/shared /home/student/ansible.cfg
"$bin/python" "$root/tools/gen-hosts.py" "$invm" > "$out/list-hosts.json"
"$bin/python" "$root/tools/gen-kv.py" > "$out/kv.json"
exit 0

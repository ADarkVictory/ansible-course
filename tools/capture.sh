#!/usr/bin/env bash
# Regenerates tests/golden/*.txt from real ansible-core 2.21.4 (stdout+stderr together).
# Each golden is what a learner sees after, from /home/student:
#   ansible-playbook -i tools/fixtures/inventory.ini /home/student/playbook.yml   (every fixture but adhoc-ping)
#   ansible web -i tools/fixtures/inventory.ini -m ansible.builtin.ping           (adhoc-ping)
# ANSIBLE_FORKS=1 keeps host order deterministic (web1 before web2); default forks=5 races.
# <name>-second is <name>.yml run a second time with no cleanup in between.
# Needs: uv, python3.13, and a writable /home/student (CI: sudo mkdir -p /home/student && sudo chown $USER /home/student).
set -u
root=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p /home/student 2>/dev/null
[ -w /home/student ] || { echo "capture.sh: /home/student must exist and be writable (sudo mkdir -p /home/student && sudo chown \$USER /home/student)" >&2; exit 1; }

[ -x "$root/.venv/bin/ansible" ] || {
  uv venv -p 3.13 "$root/.venv" && uv pip install -p "$root/.venv/bin/python" ansible-core==2.21.4
} || exit 1

export PATH="$root/.venv/bin:$PATH" ANSIBLE_NOCOLOR=1 ANSIBLE_FORCE_COLOR=0 ANSIBLE_FORKS=1 COLUMNS=80 LC_ALL=C.UTF-8
inv="$root/tools/fixtures/inventory.ini"
out="$root/tests/golden"
mkdir -p "$out"
cd /home/student || exit 1

for f in yaml-indent yaml-tab empty not-a-list unknown-module unsupported-param unknown-play-keyword task-keyword-typo \
         yaml-colon yaml-unclosed-quote yaml-dedent yaml-mapping-values no-action task-not-a-dict hosts-missing args-unbalanced-quote \
         run-sample run-sample-second run-no-facts run-idempotency run-idempotency-second adhoc-ping; do
  src=${f%-second}
  [ "$src" != "$f" ] || rm -rf /tmp/web1 /tmp/web2   # fresh hosts; the second run must see the first run's state
  if [ "$f" = adhoc-ping ]; then
    ansible web -i "$inv" -m ansible.builtin.ping > "$out/$f.txt" 2>&1
  else
    cp "$root/tools/fixtures/$src.yml" /home/student/playbook.yml
    ansible-playbook -i "$inv" /home/student/playbook.yml > "$out/$f.txt" 2>&1
  fi
done
rm -f /home/student/playbook.yml
"$root/.venv/bin/python" "$root/tools/gen-kv.py" > "$out/kv.json"
exit 0

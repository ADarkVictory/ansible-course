# Prints tests/golden/list-hosts.json: what `ansible <pattern> --list-hosts` prints (stdout and stderr together) over
# the inventory file in argv[1]. output.js's host-pattern resolver must agree. Run by capture.sh.
import json, subprocess, sys
patterns = [
 'all', '*', 'web', 'web:&prod', 'web:!db', 'web1:web2', 'web2:web1', 'db:web', 'prod:!web1', 'web,db', 'prod:&web:!staging',
 'db1', 'nosuch', 'web:nosuch', 'web:&nosuch', 'nosuch:web', '!db', '&prod', 'web:!prod', 'db:web1:web', 'prod:staging',
 'ungrouped', 'localhost', 'web1,nosuch', 'web:!nosuch', 'web1:&web', 'web:&prod:&db', 'all:!web1', '*:!db', 'web,db:!db1',
 'web;db', 'web2:web2', 'web*', '*1', '*b*', 'w?b1', 'db*:web1', 'web:prod:&staging',
]
out = []
for p in patterns:
    r = subprocess.run(['ansible', p, '-i', sys.argv[1], '--list-hosts'], capture_output=False, stdout=subprocess.PIPE,
                       stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, text=True)
    out.append({'pattern': p, 'output': r.stdout})
json.dump(out, sys.stdout, indent=1, ensure_ascii=False)

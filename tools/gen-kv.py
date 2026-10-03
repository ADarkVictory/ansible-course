# Prints tests/golden/kv.json: what ansible-core's own parse_kv makes of each k=v string, with and without the
# free-form (command/shell) handling. checker.js's port must agree. Run by capture.sh.
import json, sys
from ansible.parsing.splitter import parse_kv
from ansible.errors import AnsibleParserError
samples = [
 'name=nginx state=present', 'msg="hello world"', "msg='a b' x=1", 'echo hi', 'echo hi creates=/x', 'uptime',
 'a=b=c', 'msg="a \\"b\\" c"', 'cmd=x  y=2', 'x={{ foo }} y="{{ a b }}"', 'echo  two  spaces', 'k=', '=v', 'a\\=b c=d',
 'chdir=/tmp ls -l', 'path="/tmp/a b" mode=0644', "msg=it's", 'msg="hello world', 'x={{ foo', 'echo "a b" c=d', 'ls\n-l\ncreates=/x',
 'a=1 \\\n b=2', "msg='it''s'", 'k="v"x', 'name = nginx', 'echo hi > /tmp/x', 'cmd="echo \\x41\\n"', 'x=\'a "b" c\'', 'say "hi there" now',
 'removes=/a b=c d', 'k={% if x %}a b{% endif %}', 'msg="tab\\there"',
]
out = []
for s in samples:
    row = {'in': s}
    for raw in (False, True):
        try: row['freeform' if raw else 'kv'] = parse_kv(s, check_raw=raw)
        except AnsibleParserError: row['freeform' if raw else 'kv'] = None
    out.append(row)
json.dump(out, sys.stdout, indent=1, ensure_ascii=False)

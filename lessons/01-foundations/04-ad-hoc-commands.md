# Ad-hoc commands

The `ansible` command runs one module on a set of hosts, straight from the command line, with no playbook. Engineers use it to check that hosts answer, to look something up on many servers at once, and for the occasional one-off fix.

## The command line

```
ansible <pattern> -m <module> -a '<arguments>'
```

- `<pattern>`: the hosts to run on. A group, a host, or a combination (see below).
- `-m`: the module. On the command line most people type the short name, `ping` for `ansible.builtin.ping`. The next lesson explains the full name.
- `-a`: the module's arguments as one string, usually `key=value` pairs separated by spaces. Put it in single quotes, so your shell passes it to Ansible in one piece.

This lesson's inventory, set in `ansible.cfg` so the commands need no `-i`:

<!-- fixture: inventory-adhoc -->

```ini
[web]
web1
web2
web3

[db]
db1
db2

[lb]
lb1

[prod]
web1
web2
db1
lb1

[staging]
web3
db2
```

## Can Ansible reach them? ping

`ansible web -m ping` prints:

<!-- output: adhoc-lesson-ping -->

```output
web1 | SUCCESS => {
    "changed": false,
    "ping": "pong"
}
web2 | SUCCESS => {
    "changed": false,
    "ping": "pong"
}
web3 | SUCCESS => {
    "changed": false,
    "ping": "pong"
}
```

- `ping` is not ICMP. Ansible logs in over SSH and runs a small Python module that answers `pong`. `SUCCESS` proves that login and Python work, which every other module needs.
- After `=>` comes the module's result, as JSON. `"changed": false`: ping changes nothing.
- On real hosts whose inventory does not set `ansible_python_interpreter`, the result also carries `ansible_facts.discovered_interpreter_python`: the Python that Ansible found on the node.
- A host Ansible cannot log in to is reported `UNREACHABLE!` instead.

<!-- exercise: ad-hoc-commands-1 -->

## command and shell

With no `-m`, Ansible runs the `command` module, and `-a` is the command line:

```bash
ansible web -a 'df -h /var'
```

`command` starts the program directly, without a shell. `|`, `>`, `<`, `;`, `&` and `*` reach the program as plain arguments. (Environment variables such as `$HOME` are still expanded.)

`ansible web -a 'echo hello | tr a-z A-Z'` prints:

<!-- output: adhoc-lesson-command-pipe -->

```output
web1 | CHANGED | rc=0 >>
hello | tr a-z A-Z
web2 | CHANGED | rc=0 >>
hello | tr a-z A-Z
web3 | CHANGED | rc=0 >>
hello | tr a-z A-Z
```

`echo` printed all its arguments, the pipe included. The `shell` module runs the line through `/bin/sh` on the host, so the pipe works. `ansible web -m shell -a 'echo hello | tr a-z A-Z'` prints:

<!-- output: adhoc-lesson-shell-pipe -->

```output
web1 | CHANGED | rc=0 >>
HELLO
web2 | CHANGED | rc=0 >>
HELLO
web3 | CHANGED | rc=0 >>
HELLO
```

- `rc=0` is the exit code; the command's output follows `>>`.
- When the command runs and exits 0, both modules report `CHANGED`, whatever it did (lesson 1). A non-zero exit code is reported `FAILED`.
- Use `shell` only for what needs a shell: pipes, redirects, wildcards, `;` and `&&`.

<!-- exercise: ad-hoc-commands-2 -->

## Facts: setup

The `setup` module collects **facts**: what Ansible can find out about a host, such as its OS version, IP addresses, memory and disks. `ansible db1 -m setup` prints hundreds of lines. `filter` keeps only the facts whose names match a wildcard:

```bash
ansible db -m setup -a 'filter=ansible_distribution*'
```

A playbook gathers the same facts at the start of each play, unless it sets `gather_facts: false`.

## Running as root: -b

`-b` (`--become`) turns on become, from the last lesson: Ansible logs in as usual, then runs the module through `sudo` as root.

```bash
ansible web -b -a 'ss -tlnp'
```

- `-b` asks for no password. When sudo needs one, add `-K` (`--ask-become-pass`): Ansible prompts once, `BECOME password:`, and uses the answer on every host.
- `-K` alone does not turn become on. Ansible asks for the password, then runs the module as the login user anyway.
- `--become-user postgres` becomes `postgres` instead of root, but it too needs `-b`.
- If the project's `ansible.cfg` sets `become = True`, become is already on.

<!-- exercise: ad-hoc-commands-3 -->

## Host patterns

A pattern can combine groups and hosts. With the inventory above:

- `web` is a group, `web1` a host, `all` (or `*`) every host.
- `web:db`: in `web` or `db`. That is `web1`, `web2`, `web3`, `db1`, `db2`.
- `web:&prod`: in `web` and in `prod`. That is `web1`, `web2`.
- `prod:!db`: in `prod` but not in `db`. That is `web1`, `web2`, `lb1`.
- `web*`: every host or group whose name starts with `web`.

Ansible applies the plain names first, then every `&`, then every `!`, wherever they stand. A pattern with only `!db` starts from `all`: every host but the databases, staging included.

A comma works like a colon: `web,&prod`. Prefer it when a pattern holds IPv6 addresses, which contain colons themselves.

## Quote patterns in single quotes

Your shell reads the pattern before Ansible does:

- `&` ends a command. `ansible web:&prod -m ping` runs `ansible web:` in the background, then a command named `prod`.
- `!` starts bash's history expansion, even inside double quotes. In `"prod:!db"`, bash replaces `!db` with your last command that starts with `db`, or stops with `event not found`.

Single quotes stop both: `ansible 'prod:!db' -m ping`. Quote every pattern that contains a symbol.

<!-- exercise: ad-hoc-commands-4 -->

<!-- exercise: ad-hoc-commands-5 -->

<!-- exercise: ad-hoc-commands-6 -->

## See the hosts first: --list-hosts

`--list-hosts` prints the hosts a command would run on, and runs nothing. `ansible 'prod:!db' --list-hosts` prints:

<!-- output: adhoc-lesson-exclude -->

```output
  hosts (3):
    web1
    web2
    lb1
```

Before a command that changes anything, add `--list-hosts` to the exact line you will run. Check the list, then run the line without it.

## --limit

`--limit` (`-l`) narrows a run to the hosts that match both the pattern and the limit. `ansible web -m ping --limit staging` prints:

<!-- output: adhoc-lesson-limit -->

```output
web3 | SUCCESS => {
    "changed": false,
    "ping": "pong"
}
```

That is the same as `'web:&staging'`. `--limit` is for when you leave the pattern alone: a command copied from a runbook, or a playbook, whose hosts are written in the play. `ansible-playbook` takes the same `--limit`; it is how you try a change on one server, or on staging, first.

When the limit leaves no hosts, Ansible stops before it connects anywhere. `ansible web -m ping --limit db` prints:

<!-- output: adhoc-limit-empty -->

```output
[ERROR]: Specified inventory, host pattern and/or --limit leaves us with no hosts to target.
```

Your team's runbook restarts nginx with:

```bash
ansible web -b -m systemd_service -a 'name=nginx state=restarted'
```

<!-- exercise: ad-hoc-commands-7 -->

## Ad-hoc or playbook?

An ad-hoc command leaves no record but your shell history: no file, no review, nothing that applies it to the next server.

Ad hoc is right for:

- read-only checks: reachability, versions, disk space, logs, facts
- one-off actions that leave no state to keep, such as restarting a hung service

Anything that must stay true belongs in a playbook: packages, configuration files, users, kernel settings. A setting made ad hoc is missing from every server built after it, and a playbook that manages the same file puts its own version back on its next run.

Many teams allow only read-only ad-hoc commands in production and make every change through a reviewed playbook.

<!-- exercise: ad-hoc-commands-8 -->

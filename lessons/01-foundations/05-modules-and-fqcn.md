# Modules and FQCN

Every task runs one module. This lesson covers how modules are named, how to read their documentation, why a module beats `shell`, and what a module reports back.

## What a module is

A module is a small program that does one job: install a package, manage a file, start a service. Lesson 1 showed the mechanics: Ansible copies the module to the node, runs it with the task's arguments, and reads the JSON result it prints.

A module takes named parameters, such as `name` and `state`. Most modules check the node before they act, which is what makes a task declarative. `command` and `shell` cannot: they only run what you give them.

## FQCN: the module's full name

`ansible.builtin.dnf` is a **fully qualified collection name** (FQCN):

- `ansible`: the namespace, usually the author or project
- `builtin`: the collection
- `dnf`: the module

A **collection** is a package of modules and other plugins, installed and versioned on its own. `ansible.builtin` ships inside ansible-core, so it is always there. Everything else comes in other collections, such as `ansible.posix` (`firewalld`, `mount`) or `community.general`, installed from Ansible Galaxy or Red Hat Automation Hub. Lesson 7 covers collections.

## Short names are ambiguous

`ping:` is a short name. Ansible looks it up as `ansible.legacy.ping`, not `ansible.builtin.ping`:

- a module of that name in a `library/` directory next to the playbook, or in another configured module path, comes first
- only then the built-in module

A colleague's `library/ping.py` silently replaces the real module for every `ping:` task, and the playbook gives no sign of it. `ansible.builtin.ping:` still runs the real one.

Never name your own modules after built-in ones. A few built-ins, such as `dnf`, hand the work to `ansible.legacy.dnf` themselves, so a `library/dnf.py` replaces even `ansible.builtin.dnf`. That is also why dnf's error messages name `ansible.legacy.dnf`, however you spell the task.

Some short names point outside ansible-core: `firewalld` redirects to `ansible.posix.firewalld`. With ansible-core alone, a playbook with a `firewalld:` task stops with `couldn't resolve module/action 'firewalld'`. With the `ansible` package, which bundles many collections, the same task runs `ansible.posix.firewalld`. The meaning depends on what is installed.

An FQCN names exactly one module. ansible-lint, Ansible's linter and a common CI gate, fails short module names under its `production` profile (rule `fqcn`). Write FQCNs in playbooks. On the ad-hoc command line, short names are fine.

<!-- exercise: modules-and-fqcn-1 -->

## ansible-doc

`ansible-doc` shows the documentation of the modules you have installed, offline, for exactly your version:

```bash
ansible-doc ansible.builtin.dnf
```

That prints the full page, in a pager such as `less` on a terminal: a description, `OPTIONS` (`=` marks a required parameter), `EXAMPLES`, and `RETURN VALUES`. Short names work here too: `ansible-doc dnf`.

`-s` (`--snippet`) prints only a task skeleton: each parameter, with its description as a comment. `ansible-doc -s ansible.builtin.ping` prints:

<!-- output: doc-snippet-ping -->

```output
- name: Try to connect to host, verify a usable python and return `pong' on success
  ping:
      data:                  # Data to return for the `ping' return value. If
                             # this parameter is
                             # set to `crash', the
                             # module will cause
                             # an exception.
```

The snippet writes the short name. Change it to the FQCN when you paste it into a playbook.

<!-- exercise: modules-and-fqcn-2 -->

## Listing modules

`-l` (`--list`) lists modules with a one-line description each. How much it lists depends on the install:

- ansible-core alone: the 71 modules of `ansible.builtin`, after a warning about `ansible._protomatter`, an internal collection. Ignore the warning.
- the `ansible` package (14.4.0): over 8,800 modules from 90 collections.

Give `-l` a collection name to list only that collection:

```bash
ansible-doc -l community.general
```

It must be a full `namespace.collection`: `ansible-doc -l community` stops with `Invalid collection name`.

Modules are one plugin type among several. `-t` picks another, such as `-t lookup`; later lessons use them.

<!-- exercise: modules-and-fqcn-3 -->

## Use a module, not shell

These two tasks both install nginx:

```yaml
- name: Install nginx
  ansible.builtin.shell: yum install -y nginx

- name: Install nginx
  ansible.builtin.dnf:
    name: nginx
    state: present
```

- `dnf` first checks which packages are installed. If nginx is, it does nothing and reports `ok`.
- `shell` runs the command on every run and reports `changed` every time (lesson 1). Ansible cannot see that yum had nothing to do.

A `changed` that means nothing hides the changes that matter. ansible-lint flags the shell task with `command-instead-of-module` and `no-changed-when`. "Use the module" is one of the most common review comments on Ansible code.

`dnf`'s `state`:

- `present` (or its alias `installed`): installed, at any version. Leaving `state` out does the same.
- `latest`: installed and upgraded whenever a newer package appears, so any run can upgrade it without warning. ansible-lint's `package-latest` rule rejects it.
- `absent` (alias `removed`): not installed.

Old playbooks use `yum:`. The yum backend was removed in ansible-core 2.17, and `yum` is now only a redirect to `ansible.builtin.dnf`: `ansible-doc yum` finds nothing, and ansible-lint asks for `ansible.builtin.dnf`.

Keep `command` and `shell` for jobs no module does. Later lessons show how to make them report honestly.

<!-- exercise: modules-and-fqcn-4 -->

## Return values

Every module returns a JSON result. Keys you will meet everywhere:

- `changed`: whether the module altered the node
- `failed`: whether the task failed
- `msg`: a message, usually explaining a failure
- `rc`: the exit code, from `command` and `shell` (with `stdout` and `stderr`)

Each module documents its own keys under `RETURN VALUES` in `ansible-doc`. `ping` returns `ping`, which you saw as `"ping": "pong"` in lesson 4.

The status Ansible prints comes from the result: `failed` true is `FAILED!`, otherwise `changed` true is `changed`, otherwise `ok`. There is no `ok` key; `ok` only means the task succeeded and changed nothing. Later lessons save results with `register` and act on them.

<!-- exercise: modules-and-fqcn-5 -->

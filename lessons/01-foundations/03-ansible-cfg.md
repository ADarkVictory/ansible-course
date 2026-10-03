# ansible.cfg

Ansible has over 200 settings, each with a built-in default. A project changes them in an INI file called `ansible.cfg`, kept at the root of the repository next to the inventory and playbooks. Most company Ansible repositories have one.

## A project ansible.cfg

<!-- fixture: ansible-cfg -->

```ini
[defaults]
inventory = inventory.ini
remote_user = deploy
forks = 20
host_key_checking = False

[privilege_escalation]
become = True
become_method = sudo
become_user = root
```

- `[defaults]` and `[privilege_escalation]` are sections. Most settings belong to one section, and Ansible reads them only there: `become = True` under `[defaults]` is ignored without a warning. So is a misspelt key.
- A line starting with `#` or `;` is a comment. After a value, only `;` starts a comment: `remote_user = deploy # ops` sets the user to `deploy # ops`.

`ansible-config list` documents every setting, with its default and where it can be set: section and key, environment variable.

## inventory, remote_user, forks

- `inventory`: the inventory used when you give no `-i`, instead of `/etc/ansible/hosts`. A relative path is relative to the directory holding `ansible.cfg`, not to where you run Ansible.
- `remote_user`: the user SSH logs in as. When it is unset, Ansible passes no user to `ssh`, so the `User` from `~/.ssh/config` or your local user name applies.
- `forks`: how many hosts Ansible works on at once (default 5). Each is a separate process on the control node, so raise it for large inventories as far as the control node's CPU and memory allow.

## host_key_checking

With the default, `True`, Ansible leaves host keys to your SSH settings (`known_hosts`, `StrictHostKeyChecking`).

`False` makes Ansible pass `-o StrictHostKeyChecking=no` to `ssh`, so host keys SSH has not seen before no longer stop the connection. That also drops the check that you reached the right machine. It is common for labs and throwaway VMs; in production, put the real host keys in `known_hosts` instead.

<!-- exercise: ansible-cfg-1 -->

## Privilege escalation: become

Ansible logs in as `remote_user`. With **become** on, it then runs each task as another user, through `sudo` by default. `[privilege_escalation]` holds three settings:

- `become`: `True` turns it on. Default `False`.
- `become_method`: how to switch user. Default `sudo`; `su` is another.
- `become_user`: the user to become. Default `root`.

The file above restates the defaults of the last two, as many projects do. Neither has any effect while `become` is off.

`become = True` here makes every task of every play run as root, including tasks that do not need it. Many projects leave it off and turn it on per play or per task instead; a later lesson shows how.

<!-- exercise: ansible-cfg-2 -->

## Which file wins

Ansible looks for a config file in this order and uses the first one that exists and is readable:

1. the file named by the environment variable `ANSIBLE_CONFIG`
2. `ansible.cfg` in the current directory
3. `~/.ansible.cfg` (with a dot)
4. `/etc/ansible/ansible.cfg`

It reads that one file and no other. Files are not merged: when `./ansible.cfg` exists, a setting it does not mention takes the built-in default, even if your `~/.ansible.cfg` sets it.

What follows from that:

- "Current directory" is where you run the command, not where the playbook is. Ansible does not search parent directories. Run from the repository root.
- A personal `~/.ansible.cfg` silently stops applying inside a project that has its own file: a classic "works on my machine".
- If `ANSIBLE_CONFIG` names a file that does not exist, Ansible moves on down the list without a warning.

<!-- exercise: ansible-cfg-3 -->

## Which file is in use?

`ansible --version` names it on its second line. Run from `/home/student`, which holds the file above:

<!-- output: cfg-version -->

```output
ansible [core 2.21.4]
  config file = /home/student/ansible.cfg
```

`config file = None` means Ansible found no file and runs on built-in defaults.

`ansible-config dump --only-changed` lists every setting that does not come from a built-in default, with its origin in brackets:

<!-- output: cfg-dump -->

```output
CONFIG_FILE() = /home/student/ansible.cfg
DEFAULT_BECOME(/home/student/ansible.cfg) = True
DEFAULT_BECOME_METHOD(/home/student/ansible.cfg) = sudo
DEFAULT_BECOME_USER(/home/student/ansible.cfg) = root
DEFAULT_FORKS(/home/student/ansible.cfg) = 20
DEFAULT_HOST_LIST(/home/student/ansible.cfg) = ['/home/student/inventory.ini']
DEFAULT_REMOTE_USER(/home/student/ansible.cfg) = deploy
HOST_KEY_CHECKING(/home/student/ansible.cfg) = False

GALAXY_SERVERS:
```

- The names are Ansible's internal ones: `DEFAULT_HOST_LIST` is `inventory`, `DEFAULT_REMOTE_USER` is `remote_user`. `ansible-config list` gives the mapping.
- `DEFAULT_HOST_LIST` shows `inventory.ini` resolved against the config file's directory.
- `become_method` and `become_user` are listed although their values equal the defaults: a value set in the file counts as changed.
- `GALAXY_SERVERS:` starts a separate list, empty here.

`ansible-config view` prints the file in use. When a run behaves differently for you and a colleague, compare these outputs first.

<!-- exercise: ansible-cfg-4 -->

## World-writable directories

Ansible skips `ansible.cfg` in the current directory when that directory is world-writable. Anyone could have put the file there, and a config file can point Ansible at plugin code to run. It warns and moves on to the next file in the list:

<!-- output: cfg-world-writable -->

```output
[WARNING]: Ansible is being run in a world writable directory (/home/student/shared), ignoring it as an ansible.cfg source. For more information see https://docs.ansible.com/ansible/devel/reference_appendices/config.html#cfg-in-world-writable-dir
```

You meet this on shared checkouts with mode `777`. Remove write access for others, or name the file in `ANSIBLE_CONFIG`: a file named there is used wherever it is.

<!-- exercise: ansible-cfg-5 -->

## Environment variables and the command line

The config file is the weakest layer. From weakest to strongest:

1. `ansible.cfg`
2. environment variables: almost every setting has one, shown by `ansible-config list`. For the settings above: `ANSIBLE_INVENTORY`, `ANSIBLE_REMOTE_USER`, `ANSIBLE_FORKS`, `ANSIBLE_HOST_KEY_CHECKING`, `ANSIBLE_BECOME`, `ANSIBLE_BECOME_METHOD`, `ANSIBLE_BECOME_USER`
3. command-line options: `-i`, `-u`, `-f` (forks), `-b` (become), `--become-user`
4. keywords in a play, such as `remote_user:` and `become:`
5. variables, such as `ansible_user` in the inventory

`ANSIBLE_FORKS=50 ansible-config dump --only-changed`, run next to the file above, now shows forks coming from the environment:

<!-- output: cfg-dump-env -->

```output
DEFAULT_FORKS(env: ANSIBLE_FORKS) = 50
```

What this means in practice:

- A CI pipeline can set `ANSIBLE_*` variables and behave differently from your laptop with the same `ansible.cfg`. `dump --only-changed` shows them with `env:` as their origin.
- `-u admin` does not change the login for a host whose inventory sets `ansible_user`: the variable is stronger.
- `-b` turns become on, but a play with `become: false` stays off. No option turns become off.

<!-- exercise: ansible-cfg-6 -->

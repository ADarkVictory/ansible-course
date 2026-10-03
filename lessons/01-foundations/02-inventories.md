# Inventories

An inventory tells Ansible which managed nodes exist and sorts them into groups. Plays and commands then target a group by name instead of listing hosts.

You pass it with `-i`, as in `ansible-playbook -i inventory.ini site.yml`. Without `-i`, Ansible reads `/etc/ansible/hosts`. The next lesson shows how a project sets its own default.

## Hosts and groups

The classic format is INI:

<!-- fixture: inventory-lesson -->

```ini
bastion1

[web]
web1 ansible_host=10.0.0.11
web2 ansible_host=10.0.0.12

[db]
db1 ansible_host=10.0.0.21

[prod:children]
web
db
```

- `[web]` starts a group named `web`. Each line below it, up to the next heading, is a host in that group.
- `bastion1` comes before any heading, so it is in no group of its own.
- A host can be in any number of groups.

Group names use letters, digits and underscores, and do not start with a digit. Ansible accepts other names, such as `web-servers`, but warns about them.

`ansible-inventory` shows what Ansible made of a file. `ansible-inventory -i inventory.ini --graph` prints:

<!-- output: inventory-lesson -->

```output
@all:
  |--@ungrouped:
  |  |--bastion1
  |--@prod:
  |  |--@web:
  |  |  |--web1
  |  |  |--web2
  |  |--@db:
  |  |  |--db1
```

`@` marks a group, and each `|--` is one level down the tree. (`--list` prints the same inventory as JSON, variables included.)

## all and ungrouped

Two groups always exist:

- `all` holds every host. A play with `hosts: all` targets the whole inventory.
- `ungrouped` holds the hosts that are in no group other than `all`. Here that is `bastion1`.

<!-- exercise: inventories-1 -->

## Groups of groups: children

`[prod:children]` lists groups, not hosts. `web` and `db` become **child groups** of `prod`, and `prod` holds every host in them: `web1`, `web2` and `db1`.

Child groups give the same hosts several views: by role (`web`, `db`) and by environment (`prod`). A play with `hosts: prod` reaches all of production; one with `hosts: web` reaches only the web servers.

A child group can have children of its own, to any depth.

<!-- exercise: inventories-2 -->

## Host variables inline

`key=value` pairs after a host name are **host variables** for that host. A few built-in variables, all starting with `ansible_`, tell Ansible how to connect:

- `ansible_host`: the address SSH connects to. Without it, Ansible connects to the inventory name itself, so that name must resolve (DNS, `/etc/hosts` or `~/.ssh/config`).
- `ansible_user`: the user to log in as.
- `ansible_port`: the SSH port.

Everywhere else the host keeps its inventory name: in `hosts:`, in group lists and in output.

A `[web:vars]` section sets variables for every host in a group. In larger projects, variables live in `group_vars/` and `host_vars/` files (module 3); inline, keep to connection details.

<!-- exercise: inventories-3 -->

## The same inventory in YAML

<!-- fixture: inv-lesson -->

```yaml
all:
  hosts:
    bastion1:
  children:
    prod:
      children:
        web:
          hosts:
            web1:
              ansible_host: 10.0.0.11
            web2:
              ansible_host: 10.0.0.12
        db:
          hosts:
            db1:
              ansible_host: 10.0.0.21
```

- A group is a mapping with up to three keys: `hosts`, `children` and `vars`.
- `hosts` and `children` are mappings, not lists. Each host or child group is a key ending in `:`. A host's value holds its variables, or is left empty.
- `bastion1` is in the `hosts` of `all` itself, so it ends up in `ungrouped`.
- `web` and `db` are defined where `prod` lists them. A group can also be defined elsewhere and only named under `children:`, with an empty value; it is the same group.
- Any group that is not a child of another group ends up under `all`. So you will also meet files with no `all:` key, where groups start at the top level.

`ansible-inventory --graph` prints the same tree for this file as for the INI one.

Ansible works out the format itself. You will meet both: YAML reads better once groups nest, INI is shorter for flat lists.

<!-- exercise: inventories-4 -->

## When Ansible cannot read the file

The most common YAML mistake is writing hosts as a list:

<!-- fixture: inv-hosts-list -->

```yaml
web:
  hosts:
    - web1
    - web2
```

`ansible-inventory -i inventory.yml --graph` prints:

<!-- output: inv-hosts-list -->

```output
[WARNING]: Failed to parse inventory with 'auto' plugin: no root 'plugin' key found, '/home/student/inventory.yml' is not a valid YAML inventory plugin config file

Failed to parse inventory with 'auto' plugin.

<<< caused by >>>

no root 'plugin' key found, '/home/student/inventory.yml' is not a valid YAML inventory plugin config file
Origin: <inventory plugin 'auto' with source '/home/student/inventory.yml'>

[WARNING]: Failed to parse inventory with 'yaml' plugin: Invalid "hosts" entry for "web" group, requires a dictionary, found "<class 'ansible.module_utils._internal._datatag._AnsibleTaggedList'>" instead.

Failed to parse inventory with 'yaml' plugin.

<<< caused by >>>

Invalid "hosts" entry for "web" group, requires a dictionary, found "<class 'ansible.module_utils._internal._datatag._AnsibleTaggedList'>" instead.
Origin: <inventory plugin 'yaml' with source '/home/student/inventory.yml'>

[WARNING]: Failed to parse inventory with 'ini' plugin: Failed to parse inventory: Invalid host pattern 'web:' supplied, ending in ':' is not allowed, this character is reserved to provide a port.

Failed to parse inventory with 'ini' plugin.

<<< caused by >>>

Failed to parse inventory: Invalid host pattern 'web:' supplied, ending in ':' is not allowed, this character is reserved to provide a port.
Origin: /home/student/inventory.yml

[WARNING]: Unable to parse /home/student/inventory.yml as an inventory source
[WARNING]: No inventory was parsed, only implicit localhost is available
@all:
  |--@ungrouped:
```

How to read it:

- Ansible tried its inventory plugins on the file one after another: `auto`, `yaml`, then `ini`. When none can read it, it prints why each failed.
- The `yaml` plugin's message is the one about your file: `hosts` must be a dictionary (a mapping), not a list.
- Ansible then carried on with what it had read before the error: here, no hosts at all. A play with `hosts: web` would match nothing.
- These are warnings: the command still exits with status 0.

Other mistakes cost a single `[WARNING]: Skipping ...` line, and that part of the file is ignored. Some cost nothing visible: `web1:` and `web2:` placed directly under `web:`, without `hosts:`, leave `web` an empty group with no warning at all. Check every new inventory with `ansible-inventory --graph`.

<!-- exercise: inventories-5 -->

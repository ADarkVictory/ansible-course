# What is Ansible?

Ansible configures servers from one machine over SSH. You write down the state you want in YAML. Ansible connects to each server, and its modules change only what differs from that state.

## Control node and managed nodes

The **control node** is the machine where Ansible is installed and where you run it: your laptop, a bastion host, a CI runner. It must be Unix-like (Linux, macOS, BSD); Windows works only through WSL.

The **managed nodes** are the servers Ansible configures. Ansible finds them in an **inventory**, usually a file listing hosts and groups. You will write one in the next lesson.

Ansible (the `ansible-core` Python package) is installed on the control node only.

## Agentless: SSH and Python

Nothing Ansible-specific is installed or left running on a managed node: no agent, no daemon, no extra port. A managed node needs:

- SSH access for the user Ansible logs in as
- Python 3.9 or newer

Ansible drives your OpenSSH client (`ssh`), so your keys, `ssh-agent`, `~/.ssh/config` and jump hosts work as they are.

To run a task on a node, Ansible by default:

1. bundles a **module** (the code that does one job, such as managing a file) with its arguments into a small Python program
2. copies it over SSH into a temporary directory on the node
3. runs it with the node's Python
4. reads the JSON result the module prints, then deletes the temporary files

<!-- exercise: what-is-ansible-1 -->

## Push, not pull

You start a run on the control node. It connects out to the managed nodes, does the work and exits. Between runs, nothing happens on the nodes.

Ansible runs each task on all targeted nodes, 5 at a time by default, before it starts the next task.

What push means in practice:

- A node that cannot be reached is reported `UNREACHABLE!` and dropped for the rest of the run. The other nodes carry on.
- Nothing catches that node up later. It stays as it was until you run again.

In companies, runs often start from a CI pipeline or from Ansible Automation Platform (upstream project: AWX) rather than a laptop. The model is the same. (`ansible-pull` turns it around, with each node pulling a Git repository and running it locally, but you will rarely meet it.)

<!-- exercise: what-is-ansible-2 -->

## Declarative tasks, run in order

A shell script is **imperative**: it lists steps. `mkdir /tmp/app` means "create it", and fails if it exists.

An Ansible task is **declarative**: it states a result. "`/tmp/app` is a directory with mode `0755`" is either true or not. The module checks, and acts only if it is not.

A **playbook** is a YAML file holding a list of **plays**. Each play names its hosts and the tasks to run on them. A complete playbook with one play:

<!-- fixture: run-intro -->

```yaml
- name: Prepare the app server
  hosts: web1
  gather_facts: false
  tasks:
    - name: Ensure the app directory exists
      ansible.builtin.file:
        path: /tmp/app
        state: directory
        mode: "0755"
    - name: Log the deployment
      ansible.builtin.shell: echo deployed >> /tmp/app/deploy.log
```

- `hosts: web1`: the managed node to configure.
- `gather_facts: false`: skips collecting details about each node first; this playbook does not need them.
- Each task here has a `name` (a label for the output) and one module: `ansible.builtin.file` manages files and directories, `ansible.builtin.shell` runs a shell command.

Tasks run top to bottom, in the order written. Each task declares a state, but Ansible never reorders tasks for you.

The second task is not declarative: it is a command, not a state.

<!-- exercise: what-is-ansible-3 -->

## Idempotency

An operation is **idempotent** if repeating it changes nothing once the result is reached. A well-written playbook can run any number of times with the same result.

First run of the playbook above:

<!-- output: run-intro -->

```output
PLAY [Prepare the app server] **************************************************

TASK [Ensure the app directory exists] *****************************************
changed: [web1]

TASK [Log the deployment] ******************************************************
changed: [web1]

PLAY RECAP *********************************************************************
web1                       : ok=2    changed=2    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
```

Second run, nothing changed in between:

<!-- output: run-intro-second -->

```output
PLAY [Prepare the app server] **************************************************

TASK [Ensure the app directory exists] *****************************************
ok: [web1]

TASK [Log the deployment] ******************************************************
changed: [web1]

PLAY RECAP *********************************************************************
web1                       : ok=2    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
```

- `changed`: the task altered the node. `ok`: the node was already in the declared state.
- The directory task is now `ok`: the `file` module found `/tmp/app` already a directory with mode `0755`.
- The shell task reports `changed` on every run. Ansible cannot know what a command does, so it assumes it changed something. Here it did: `deploy.log` gains a line per run.
- In `PLAY RECAP`, `ok` counts every task that succeeded, changed or not.

Ansible keeps no record of earlier runs. Every run checks the node's real state.

The rule that follows: use a module that declares state. Treat `command` and `shell` as a last resort; later lessons show how to keep them honest.

<!-- exercise: what-is-ansible-4 -->

<!-- exercise: what-is-ansible-5 -->

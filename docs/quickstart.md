# Create your first remote development environment

Run the included API and Postgres database on AWS, open the application, then run its checks. This example creates real cloud resources. Destroy the environment when you finish.

## Before you start

Use macOS or Linux with Git, SSH and rsync available. Runo uses Bun; the installer can install it. Choose one access path:

- **Direct AWS:** configure AWS credentials in your shell. Check access with `aws sts get-caller-identity` if you use the AWS CLI. Your identity needs permission to manage the EC2 resources used by Runo.
- **Team control plane:** obtain `RUNO_SERVER` and `RUNO_TOKEN` from your operator. You do not need local AWS credentials for this path.

Do not paste credentials into a repository. The demo itself does not require a coding agent. Agent authentication is needed when you run `runo agent`; see [coding agents](agents.md).

## Install the CLI

```bash
git clone https://github.com/kodustech/runo.git
cd runo
./install.sh
```

The installer links `runo` and runs `runo setup`. The checker may report missing agent credentials or a project recipe at this point. Set up cloud or control-plane access before continuing. The example below includes its own recipe.

If the shell cannot find `runo`, add Bun's binary directory to your path:

```bash
export PATH="$HOME/.bun/bin:$PATH"
```

## Prepare the demo repository

Run this from the Runo checkout. Pick a fresh destination if `~/runo-demo` already exists.

```bash
cp -R examples/demo-app ~/runo-demo
cd ~/runo-demo
git init -b main
git add -A
git commit -m "Initialize Runo demo"
```

The example recipe configures Postgres and an API. It defines migration and seed commands, plus lint and test steps. Inspect `.kodus/workspace.yaml` before provisioning.

## Start the environment

```bash
runo new first-env
runo url --open --branch task/first-env
```

Runo creates the `task/first-env` branch and a separate local worktree, then provisions the VM. Your shell stays in the original checkout, so subsequent commands explicitly select the branch.

Open `/health` on the returned URL to check the API. Open `/items` to see the seeded records. Initial provisioning takes time and depends on your AWS configuration; wait for the health check to complete.

## Run the configured checks

```bash
runo validate --branch task/first-env
```

Runo executes the recipe's lint and test commands on the VM. It saves JSON and Markdown results, plus logs, under `.kodus/evidence/` in the generated worktree. Its location is printed during environment creation and validation.

## Finish and clean up

For this disposable demo:

```bash
runo destroy --branch task/first-env
```

This terminates the environment and removes its managed worktree. Pull and save any remote edits before destroying an environment you have worked in. Suspending an environment keeps its storage, which can still incur charges.

## Use your own project

In your project, run `runo init`, review `.kodus/workspace.yaml`, and commit it. Configure services and development credentials deliberately. Add migration/seed commands only if your project needs them. Use the [reference](reference.md) for Docker Compose and validation options.

## If something fails

- Missing access: run `runo setup` and follow the relevant AWS or control-plane checks.
- Environment not found: use `--branch task/first-env` from the original demo checkout.
- Health check failure: run `runo logs --branch task/first-env` and inspect the failing service.
- A previous attempt left resources: inspect `runo ls`, then destroy the specific demo environment after saving anything you need.

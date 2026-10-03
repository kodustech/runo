# Run Claude Code or Codex on AWS with Runo

Runo starts your coding agent inside the remote environment that runs your application. Start with a working environment from the [quickstart](quickstart.md).

## Configure agent access

For Claude Code, Runo accepts `CLAUDE_CODE_OAUTH_TOKEN`, generated with `claude setup-token`, or `ANTHROPIC_API_KEY`. For Codex, the current launcher requires `OPENAI_API_KEY`.

Set credentials in your shell or in `~/.kodus/agent.env` with `KEY=value` entries and file permissions of `600`. Use your own credentials and never commit them. Your local interactive login is not automatically transferred to the VM.

Agent subscriptions and API usage follow the provider's terms and can incur charges separately from AWS.

## Start a session

From the original project checkout, choose the agent you use:

```bash
runo agent claude --branch task/first-env
```

```bash
runo agent codex --branch task/first-env
```

Replace the branch with your environment's branch. In an interactive terminal, Runo uses a remote tmux session. Press `Ctrl+B`, then `D`, to detach. Running the command again reattaches. A working session can continue after you disconnect, subject to the VM's lifecycle and idle policy.

## Inspect and validate the change

```bash
runo url --open --branch task/first-env
runo validate --branch task/first-env
runo pull --branch task/first-env
```

The agent works against the services and data configured for that environment. Validation runs the commands in the recipe; it does not invent tests or replace review. Pull downloads remote changes to the environment's local worktree.

## Prepare a PR

After reviewing the work, `runo ship "your commit message" --validate --branch task/first-env` runs the shipping workflow. It commits and pushes changes and can open a PR with GitHub CLI. Use it only when you intend to publish the branch to the remote.

## Limits

Credentials are present on the remote VM while the environment exists. Use development credentials and data. The interactive control-plane TTY tunnel is experimental; see the [reference](reference.md) for deployment-specific behavior. Runo currently provisions AWS environments. It does not promise isolation for arbitrary hostile code.

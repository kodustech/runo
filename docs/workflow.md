# How Runo environments work

Runo connects a Git branch to a remote environment on AWS. Your repository recipe defines how the application starts and which services it needs. The [interactive diagram](https://runo.sh/#walkthrough) illustrates the flow.

## Create the environment

Run `runo new checkout-fix` from a repository with a reviewed and committed recipe. Runo creates the task branch and worktree, then provisions its remote environment. Database services and seed data depend on the recipe.

## Work with your agent

Enter the worktree printed by Runo, then run `runo agent claude` or `runo agent codex`. The agent runs on the remote VM alongside your application's services. You provide the agent credentials. See [coding agents](agents.md).

## Open the application

Run `runo url --open` from the environment's worktree. Inspect the application yourself or share the URL. The preview does not add authentication; use development data and credentials.

## Validate and bring changes back

Run `runo validate` to execute the recipe's checks remotely. Results and logs are downloaded to the local worktree. Use `runo pull` to download remote code changes, then save them before destroying an environment.

When you intend to publish a branch, `runo ship` can commit, push and open a PR. Configured checks and human review still determine whether the change is ready.

The diagram is an explanation, not a live view of infrastructure. The [quickstart](quickstart.md) covers setup and cleanup. AWS resources and agent usage can incur charges.

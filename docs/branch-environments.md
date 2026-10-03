# Run Git branches with separate application environments

Git worktrees give branches separate working directories. Runtime services still need their own ports and data configuration when you run them on the same machine.

If two checkouts both start an API on port 3000, one process can fail to bind. If both point at the same development database, changes to the data can affect both applications.

## Start with the simplest option for your project

For a small application, separate ports and database names may be enough. Docker Compose projects can also separate services when configured appropriately. Those options keep compute local.

A remote environment is useful when each branch needs its own running stack or your laptop is already busy running agents. Runo gives each environment a dedicated AWS VM and reads service configuration from a repository recipe.

## Two branches, two environments

From a repository with a reviewed and committed `.kodus/workspace.yaml`:

```bash
runo new checkout-fix
runo new search-fix
runo url --branch task/checkout-fix
runo url --branch task/search-fix
```

The same application ports can be used on different VMs. Each environment has its own services when the recipe provisions them locally on that VM.

## Be explicit about the database

Pointing both environments at the same external database still shares data. Configure a database service per environment, or supply separate external databases. Seeding only runs when you define it in the recipe.

## Work locally or remotely

Use `runo push --branch task/checkout-fix` to send local worktree changes to its environment. Use `runo agent claude --branch task/checkout-fix` to work remotely. `runo pull` brings remote edits back to the local worktree.

The preview URL lets another person inspect the running application. It does not add access control; use development data and configure authentication when your application needs it.

## Clean up after the work

Pull and save your changes before destroying an environment. Run `runo destroy --branch task/checkout-fix` for the selected branch. Suspending keeps the disk and may still incur storage charges.

See the [quickstart](quickstart.md) for a complete example and [Git's worktree documentation](https://git-scm.com/docs/git-worktree) for the underlying checkout model.

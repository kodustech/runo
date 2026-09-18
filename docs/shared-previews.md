# QA access to shared previews

For Kodus, follow the [isolated Ohio deployment](../deploy/README.md): only
`kodus-devops-agent`, `us-east-2`, new previews and no instance profile.
The generic examples below do not authorize access to the old fleet.

The control plane owns the AWS credentials, SSH key and environment registry.
CI creates environments through it; agents use their own token to discover and
attach to environments explicitly shared with their identity.

## Server

Run the server behind TLS on a host reachable by CI and QA:

```bash
RUNO_HOME=/var/lib/runo \
RUNO_SERVER_TOKENS='preview-ci:<ci-token>,qa:<qa-token>' \
RUNO_SERVER_ADMINS=preview-ci \
bun server/main.ts
```

Provision AWS credentials on that host. Keep its RUNO_HOME persistent: it
contains the SSH key and server registry. Admin membership allows shared
infrastructure changes (security-group ports, pool and base images).
The creator owns each environment and controls membership and lifecycle.

Sharing grants **full command execution, upload and download on that VM**,
including database writes and access to application credentials. It is intended
for trusted QA agents on isolated development/preview data, not read-only SQL
access. Blocking lifecycle RPCs does not sandbox commands executed inside the VM.
Tokens are not returned by discovery. SSH keys stay on the server.

## kodus-ai CI migration

Deploy this Runo version before changing CI. In both preview-deploy.yml and
preview-cleanup.yml, configure the Runo invocation with:

```yaml
env:
  RUNO_SERVER: ${{ vars.PREVIEW_RUNO_SERVER }}
  RUNO_TOKEN: ${{ secrets.PREVIEW_RUNO_TOKEN }}
```

Use the same `preview-ci` identity for deploy and cleanup. Remove the AWS and
PREVIEW_RUNO_SSH_KEY credentials from those steps once migrated. Keep the current
local RUNO_HOME stable. Existing up/push/url/destroy commands remain valid;
fresh runners discover the server's environments by repository and branch.
After `runo up` succeeds, grant access explicitly:

```bash
$RUNO share qa --branch "$HEAD_REF"
```

`share` replaces the entire collaborator list; `runo share` with no users
revokes all collaborators. A later deploy preserves membership unless CI calls
share again. Server discovery lists only owned/shared environments.

The existing preview-bake workflow uses a callback to prepare a warm image;
remote warm-image baking is not supported. Keep it on the operator host using
the server's RUNO_HOME, or use the server's generic base image instead. A bake
in the old CI fleet will not warm the new server fleet.

Existing previews created directly by AWS are not automatically imported:
their key and fleet identity belong to the old CI configuration. Retire them
through the old cleanup path before switching that path, or keep the old cleanup
available until those PRs close. New control-plane previews use the server key.
Do not remove the old key before its environments have been cleaned up.

## QA agent

In a separate checkout/worktree of kodus-ai with the preview recipe present:

```bash
export RUNO_SERVER=https://runo.example.com
export RUNO_TOKEN='<qa-token>'
runo environments
runo attach <env-name>
runo logs kodus-api
runo logs worker
runo exec -- docker ps
```

Attach records a local connection without synchronizing files, provisioning a
VM or changing branches. Check out the PR revision to inspect matching source.
The environment name comes from `runo environments`; PR-number lookup is not
implemented. The checkout must not already point to a different environment.

For kodus-ai's PostgreSQL container, use credentials already inside the container:

```bash
runo exec -- 'docker exec db_postgres sh -c '\''psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT current_database();"'\'''
```

The same `runo exec` transport can run mongosh, scenario setup scripts, or
application commands. Database ports need not be public. There is no new
`runo db` abstraction in this change.

Revocation is checked on each new request; already-running commands/TTY sessions
are not forcibly terminated. Logs and execution use the VM's live address
resolved by the server, ignoring client-supplied addresses.

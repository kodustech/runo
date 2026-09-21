# Isolated Runo deployment — Ohio

Only `arn:aws:iam::611816806956:user/kodus-devops-agent` in `us-east-2`
is authorized for this migration. Never use the default AWS profile.

Server deployed: `i-0361a0dacfffae9b9`, t3.micro, encrypted 12 GiB gp3,
Elastic IP `3.14.180.98` (`eipalloc-0f5f6524591ee0ae2`).
HTTPS endpoint: https://runo.kodus.io (Cloudflare A record, DNS only, → the
Elastic IP; Caddy issues the certificate). The old sslip.io name was retired
once CI and QA moved. The process runs as ubuntu under
systemd, using about 37 MiB idle at the initial check. SSH is restricted to the
operator's IP in `sg-06c6ce2083d7594d8`; there is no instance profile.

The Preview environment in GitHub has PREVIEW_RUNO_SERVER and a dedicated
PREVIEW_RUNO_TOKEN. Integration is staged on kodus-ai branch
`infra/runo-ohio-control-plane`; manual validation targets PR #1936.
Validation run: https://github.com/kodustech/kodus-ai/actions/runs/35289191624
completed successfully. The new PR #1936 preview is
https://3-138-125-33.sslip.io (instance i-0a9b399e9671405d8).
All seven containers were healthy; HTTP returned 200. QA attach/exec/logs,
PostgreSQL transactional write/read with rollback, and MongoDB authenticated
ping passed. Default-branch cutover is the next deployment step.

Run `bash deploy/check-isolated-access.sh` before cloud administration. It
refuses other identities and never falls back to environment credentials or
the default profile. Operator key and local QA configuration live in ignored
`.runo-deploy/` with restricted permissions. Do not commit or print them.

## Panel, login and updates

People sign in at https://runo.kodus.io with GitHub (OAuth App "runo" in the
kodustech org, callback `/auth/github/callback`); only active kodustech members
get in. `RUNO_GITHUB_*`, `RUNO_PUBLIC_URL` and `RUNO_SERVER_ADMINS` live in
/etc/runo-server.env. `preview-ci` and `qa` remain token identities in
`RUNO_SERVER_TOKENS`; humans mint personal CLI tokens in the panel. History,
users, sessions and hashed tokens are in /var/lib/runo-ohio/server.db. A cron
job (`/etc/cron.d/runo-backup`, 03:17 UTC) keeps 14 consistent daily copies in
/var/lib/runo-ohio/backups, and every `update-server.sh` run pulls one into
`.runo-deploy/backups/`. Both are on-host or manual: losing the volume between
deploys loses up to that much history. An automatic off-host copy needs an S3
bucket (or EBS snapshots) the isolated identity is allowed to write — not set up. How the panel works:
[docs/control-plane-panel.md](../docs/control-plane-panel.md).

Code-only updates: `bash deploy/update-server.sh` from the repo root. It runs
the server tests, ships the working tree, keeps the env files and RUNO_HOME
untouched, and restores the previous build if the new one does not come up.

Offboarding: remove the person from the org AND disable them in settings →
people (ends sessions and every token they minted).

## New server and environments

1. Resolve a Canonical Ubuntu 24.04 amd64 AMI using EC2 DescribeImages in Ohio.
   Pin RUNO_AWS_AMI to avoid the SSM permission the isolated user lacks.
2. Provision a t3.micro server with encrypted gp3 storage and
   control-plane-cloud-init.yaml. Do not request an instance profile or IAM role.
3. Deploy the Runo code and configure HTTPS through Caddy. Port 7777 stays on
   loopback. Generate separate preview-ci and qa tokens.
4. Install isolated.env.example as /etc/runo-server.env, populated with the AMI
   and tokens, and isolated-policies.yaml in /var/lib/runo-ohio/policies.yaml.
5. Provision the dedicated user's AWS key in /etc/runo-aws.env (root-owned, 0600)
   over an encrypted administrative connection. Never put credentials in
   user-data, Git, logs or chat. The server verifies the exact ARN and region
   before listening. No role or privilege escalation is used.
6. Create fresh previews in Ohio, using t3.xlarge in the kodus-ai recipes to
   preserve 16 GiB RAM within the allowed family. Measure build performance.
   Do not use t4g until the runtime/image provisioning supports ARM.
7. Migrate deploy and cleanup together to RUNO_SERVER and RUNO_TOKEN; remove
   their direct AWS/SSH credentials. Run `runo share qa` after up.
8. Disable the nightly warm bake during migration. Remote warm bake callbacks
   are unsupported; the old scheduled job must not keep creating old-fleet VMs.
9. Validate application, logs, PostgreSQL, MongoDB and a QA scenario before
   retiring old Runo resources. New previews do not migrate database data;
   explicitly preserve any necessary fixtures before cleanup.

The initial policy caps running previews at three. The USD 150 budget is an
alert, not an automatic spending limit. Monitor runtime and CPU credit charges.

## Old Runo resources

Old previews are outside the authorized region. An administrator must inventory
and remove only confirmed Runo resources after cutover: instances, volumes,
images/snapshots, keys and security groups. Do not touch production services.

Earlier in this session, the wrong identity created the IAM role
`runo-control-plane` and attached the inline policy `preview-fleet`. No instance
profile or EC2 was created. An administrator should remove those two IAM
resources. `control-plane-policy.json` is retained solely as an audit record of
that applied policy; never apply it for the Ohio deployment.

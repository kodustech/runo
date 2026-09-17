# Isolated Runo deployment — Ohio

Only `arn:aws:iam::611816806956:user/kodus-devops-agent` in `us-east-2`
is authorized for this migration. Never use the default AWS profile.

Status: local preparation only. No EC2 has been provisioned and CI has not been
changed. Configure the named profile and run
`bash deploy/check-isolated-access.sh`. The script refuses other identities
and never falls back to environment credentials or the default profile.

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

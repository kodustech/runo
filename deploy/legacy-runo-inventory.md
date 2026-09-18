# Legacy Runo cleanup handoff

Historical inventory from this session, **not a current-state assertion**.
These resources were observed in sa-east-1 before the user restricted all agent
AWS access to kodus-devops-agent/us-east-2. Do not query or mutate that region
with another identity. An authorized administrator must revalidate ownership,
preserve any necessary work/data, and remove only Runo resources after cutover.

| Instance | Runo environment / repository | Fleet |
| --- | --- | --- |
| i-0e9c2bdd1eca318eb | kodus-ai / malinosqui/rules-ui (#1936) | 466023 |
| i-006b347862d65a242 | kodus-ai / feat/evals-nightly-deepseek-friday-tier0 | 466023 |
| i-05ef3115e76c0b442 | kodus-ai / fix/logger-credential-redaction | 466023 |
| i-01119598c531754e8 | rules-ui / malinosqui/rules-ui | a7f3a1 |
| i-09cd52023bde37c95 | grunt / feat/kodus-provider-credits | a7f3a1 |
| i-0b5a0aaac10bc3e6b | brendi / task/brendi-smoke | 88784e |

After instance cleanup, inventory related Runo EBS volumes, AMIs and snapshots,
security groups, keys, and any pools by their Runo tags. Preserve unrelated
production/QA infrastructure and generic AWS secrets used by its workflows.

Also remove the mistakenly-created IAM role `runo-control-plane` and its inline
policy `preview-fleet`; no instance profile was created for it. The new Ohio
control plane does not use this role.

Disable the legacy preview-bake schedule and migrate preview-deploy/cleanup
together. Remove PREVIEW_RUNO_SSH_KEY only once no legacy Runo workflow needs it.
Never delete shared AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY repository secrets:
non-Runo production/QA workflows may still use them.

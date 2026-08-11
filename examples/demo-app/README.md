# demo-app

Minimal Bun API used to exercise runo end to end:

- `GET /health` — liveness
- `GET /items` — reads from Postgres (3 rows after `db:seed`)

Full recipe in `.kodus/workspace.yaml`. To try it, copy this folder outside the
runo repo and `git init` it (runo targets git repositories):

```bash
cp -R examples/demo-app ~/demo-app && cd ~/demo-app && git init -b main && git add -A && git commit -m init
runo new test-a      # branch task/test-a + remote EC2 environment
curl $(runo url)/items
runo validate        # lint + test on the VM, evidence in .kodus/evidence/
runo destroy
```

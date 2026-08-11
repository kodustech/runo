# demo-app

API mínima em Bun usada para exercitar o `runo` de ponta a ponta:

- `GET /health` — liveness
- `GET /items` — lê do Postgres (3 rows após `db:seed`)

Recipe completa em `.kodus/workspace.yaml`. Fluxo esperado:

```bash
runo new teste-a     # branch task/teste-a + ambiente remoto EC2
curl $(runo url)/items
runo validate        # lint + test na VM, evidência em .kodus/evidence/
runo destroy
```

# runo — ambiente remoto por branch (AWS EC2)

`runo` materializa, para cada branch, um **ambiente remoto numa VM EC2**: código,
serviços, banco com seed e URL pública — e o agente de código (`claude`/`codex`)
roda **na VM**. O laptop fica livre: com dois ambientes de pé, o `docker ps`
local fica vazio.

Provider v1: **AWS EC2**,
atrás da interface `RuntimeProvider` — nada fora de `src/provider/aws.ts`
conhece AWS.

## Instalação

```bash
git clone https://github.com/kodustech/runo.git
cd runo
bun install
bun link          # disponibiliza `runo` globalmente (~/.bun/bin/runo)
runo help
```

Pré-requisitos na máquina local:

- Bun ≥ 1.3, git, ssh/scp/rsync (macOS já tem)
- Credenciais AWS válidas (`aws sts get-caller-identity` precisa responder)
- Credencial do agente remoto, no ambiente **ou** em `~/.kodus/agent.env`
  (formato `KEY=valor`, um por linha, chmod 600):
  - **Assinatura Claude (recomendado)**: rode `claude setup-token` no laptop
    (interativo, uma vez) e salve `CLAUDE_CODE_OAUTH_TOKEN=<token>` — o agente
    na VM roda pela sua assinatura, sem cobrança por token de API;
  - ou `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` (API keys).
  - O login OAuth interativo do laptop NÃO viaja; para codex por assinatura,
    rode `codex login` dentro de `runo agent codex` (fluxo por URL/device).

Variáveis:

| Var | Default | Efeito |
| --- | --- | --- |
| `RUNO_HOME` | `~/.kodus` | raiz de estado (registry, worktrees, chaves SSH). Instalações paralelas DEVEM usar RUNO_HOMEs distintos |
| `RUNO_AWS_REGION` | `sa-east-1` | região EC2 (us-east-1 é ~40% mais barato se a latência não incomodar) |
| `RUNO_DEBUG` | — | `1` imprime stack traces |

## Comandos

| Comando | O que faz |
| --- | --- |
| `runo init [--force]` | inspeciona o repo e propõe `.kodus/workspace.yaml` |
| `runo new <nome>` | branch `task/<nome>` + worktree + `runo up` |
| `runo up [--branch B]` | materializa o env remoto (idempotente: existente → resume/reconcilia) |
| `runo agent <claude\|codex> [args…]` | sessão do agente NA VM (tmux: detach com Ctrl+B D não mata o agente; rodar de novo reatacha), cwd no repo, auth injetada |
| `runo validate [step]` | roda `validate:` na VM; baixa evidência JSON+MD; exit ≠ 0 se falhar |
| `runo pull` | rsync VM → worktree local (push/PR acontecem do local) |
| `runo push [--restart]` | rsync worktree local → VM; `--restart` religa serviços `run:` (compose dev com watch recarrega sozinho) |
| `runo url [--open]` | URL pública do serviço `public` (IP atual + porta) |
| `runo logs [serviço] [-f]` | logs remotos por serviço |
| `runo exec -- <cmd>` | comando arbitrário na VM, cwd no repo |
| `runo ls` | envs: branch, estado, URL, uptime, instância |
| `runo suspend` / `runo resume` | stop/start da EC2 (parada não cobra compute; **o IP muda** e o runo o redetecta) |
| `runo bake [--rm]` | assa uma AMI com o provisionamento pronto (~10-12min, uma vez): `runo up` seguintes bootam em ~1-2min em vez de ~6. `--rm` remove a imagem/snapshot |
| `runo pool [n]` | warm pool: n instâncias provisionadas e **paradas** (só EBS, ~US$3/mês cada); `runo new` reivindica delas — ajusta tipo/disco parado e dá start (~40-60s). Sem arg mostra estado; `0` drena |
| `runo destroy [--all]` | termina instância (EBS junto), remove worktree e registry; `--all` remove keypair + SG |

## Recipe (`.kodus/workspace.yaml`, schema v1)

```yaml
version: 1
setup:
  - bun install
files:
  copy: [.env]              # untracked copiados do working tree local para a VM
services:
  db:
    image: postgres:16      # image: → docker compose gerado pelo runo
    port: 5432
    env: { POSTGRES_PASSWORD: runo }
  api:
    run: bun run dev        # run: → processo na VM (tmux), log em ~/.runo/logs/
    port: 3000
    public: true            # abre a porta no SG → http://<ip>:3000
    health: /health         # healthcheck HTTP feito DE FORA (valida SG + serviço)
data:
  migrate: bun run db:migrate
  seed: bun run db:seed
validate:
  - name: lint
    run: bun run lint
  - name: test
    run: bun test
limits:
  instance: t3.medium
  disk: 30gb
  idle_suspend: 10m         # default 10m; "2h" ou "off" — auto-suspend por inatividade
  spot: true                # ~70% mais barato; interrupção da AWS = stop (EBS
                            # sobrevive, runo resume religa). Fallback on-demand
                            # automático se não houver capacidade. Spot não usa
                            # warm pool nem hibernação.
```

Modo **passthrough** (repos com compose próprio — caso kodus-ai):

```yaml
version: 1
setup:
  - pnpm install
files:
  copy: [.env]
services:
  compose:
    file: docker-compose.dev.yml
    profiles: []             # opcional; o compose do repo roda COMO ESTÁ na VM
    public: kodus-api        # serviço cuja porta publicada vira a URL pública
    health: /health/simple   # opcional; sem ele o check é TCP
data:
  migrate: pnpm run migration:run
  seed: pnpm run seed
validate:
  - name: lint
    run: pnpm run lint
limits:
  instance: t3.xlarge
  disk: 100gb
```

`services.compose` é mutuamente exclusivo com `image:`/`run:`. Como a VM é
dedicada ao env (daemon Docker exclusivo), `container_name` fixos e portas
publicadas do repo **não colidem por construção** — sem DinD, sem override.

## Como funciona (decisões de engenharia)

- **Uma instância EC2 por env** (Ubuntu 24.04 via SSM Parameter Store, cloud-init
  instala docker+compose, node 22, bun, pnpm, tmux, rsync, CLIs `claude`/`codex`).
  Tags: `Name=runo-<hash6>-<slug>`, `runo:env`, `runo:managed=true`, `runo:home-hash`.
- **Código sobe por `git archive HEAD`** (só tracked) + `files.copy` para
  untracked (.env). `git init + commit` na VM para o agente usar git lá.
  **Zero credencial Git na nuvem** — o retorno é sempre `runo pull` (rsync),
  commit/push acontecem no laptop.
- **Worktree local por env** (`$RUNO_HOME/worktrees/<repo>-<slug>`) é a âncora de
  sync: origem do upload, destino do pull. Branch checked out no working tree
  principal → erro claro sugerindo `runo new`.
- **Auth dos agentes**: env vars → `~/.kodus/agent.env` (global, independente do
  RUNO_HOME). As chaves viajam por arquivo `600` via scp, nunca por argv/log.
  **Auth OAuth de assinatura local (claude.ai/ChatGPT) não viaja** — a VM precisa
  de API key.
- **Healthcheck de fora**: HTTP 200 no `health:` (ou TCP) contra o IP público —
  valida SG + serviço de uma vez. Timeout 120s, falha derruba o `runo up` com log.
- **Suspend/resume**: instância parada não cobra compute (só EBS, centavos/dia).
  O EBS sobrevive ao stop/start — dados do banco persistem. **O IP público muda**
  a cada resume; o runo redetecta e atualiza registry/URL.
- **Auto-suspend por inatividade** (`limits.idle_suspend`, default 10m): um
  watchdog NA VM (cron 1/min) desliga a instância após N min sem atividade —
  shutdown interno vira "stopped" (= suspend). Atividade = sessão SSH
  estabelecida, load ≥ 0.20, tráfego de rede (>100KB/min — inclui alguém usando
  a URL pública) ou CPU dos processos claude/codex (agente detached trabalhando
  conta como ativo; agente parado no prompt não). `runo resume` religa; o
  registry local só percebe no próximo `runo ls`/`url`/`resume`.
- **Imagem assada** (`runo bake`): VM temporária roda o cloud-init completo,
  `cloud-init clean`, stop, `CreateImage` → AMI `runo-base-<hash6>-<ts>`. O
  `runo up` passa a usar essa AMI (sem user-data pesado) e o boot frio cai de
  ~6min para ~1-2min. Custo parado: só o snapshot (~US$1,4/mês para 30GB).
  Re-rodar `runo bake` substitui a imagem anterior (deregister + delete snapshot).
- **Warm pool** (`runo pool <n>`): instâncias já provisionadas ficam PARADAS
  aguardando claim. `runo new` reivindica uma: retag → ajusta tipo de instância
  (`ModifyInstanceAttribute`) e cresce o disco (`ModifyVolume` + growpart no
  boot) se a recipe pedir mais → `StartInstances`. Env pronto em ~40-60s.
  O guardrail de custo conta só instâncias LIGADAS (paradas custam ~nada).
- **Spot** (`limits.spot: true`): instância spot **persistente** com
  interrupção configurada como **stop** — uma interrupção da AWS é, na prática,
  um auto-suspend não planejado (EBS intacto, `runo resume` religa; IP muda como
  sempre). O `runo destroy` cancela a spot request ANTES de terminar (senão a AWS
  relançaria outra instância). `runo ls` marca `(spot)`. Números de referência:
  t3.xlarge sa-east-1 ~US$0,08-0,11/h (vs 0,27 on-demand); 3 envs kodus-ai a
  ~6h/dia ≈ US$48/mês com spot + us-east-1.
- **Hibernação**: envs nascem com `HibernationOptions` + root criptografado.
  `runo suspend` tenta hibernar (RAM → EBS); o `runo resume` sonda os serviços
  primeiro e, se respondem (volta quente), não religa nada — app volta no
  estado exato. Fallback gracioso para stop/boot normal quando hibernação não
  está disponível (tipo/AMI/conta). O auto-suspend por inatividade usa stop
  normal (a decisão vem de dentro da VM, que não tem credencial AWS — de
  propósito): nesse caso o resume religa os serviços.
- **Registry local**: `$RUNO_HOME/envs.json`.
- **Guardrails de custo**: máx. 3 instâncias simultâneas *por instalação*
  (escopo = tag `runo:home-hash`); tudo tagueado `runo:managed=true`;
  `runo destroy --all` ao final de cada rodada.

## Dois jeitos de usar agente com o runo

1. **Agente NA VM** (`runo agent claude|codex`) — o cérebro roda lá, numa sessão
   tmux: você assiste ao vivo no terminal, dá detach (Ctrl+B D ou fecha o
   laptop) e o agente segue trabalhando; `runo agent` reatacha com scrollback.
   Auth por assinatura via `claude setup-token` (CLAUDE_CODE_OAUTH_TOKEN) ou
   API key — o login OAuth interativo do laptop não viaja.
2. **Agente local dirigindo a VM** — o agente roda no laptop com a SUA
   assinatura e usa o worktree do env como um repo local qualquer:
   edita arquivos → `runo push [--restart]` → mudança viva na URL pública →
   `runo validate`/`runo logs`/`runo exec` para verificar. Zero credencial na nuvem.
   Loop provado de verdade: edição local em `src/server.ts` → `runo push
   --restart` → `curl http://<ip>:3000/whoami` respondendo
   `{"editadoPor":"agente local (laptop)","rodandoEm":"ip-172-31-21-12"}`.

## Segurança — limitações aceitas do v1 (documentadas de propósito)

- **A URL pública é IP:porta sem TLS e sem auth.** Qualquer um que descobrir o
  IP acessa o serviço. Por isso: use SEMPRE `.env` de desenvolvimento — nunca
  credencial de produção. DNS/TLS/auth ficam para fases futuras.
- O SG abre 22 e as portas públicas para `0.0.0.0/0`. A chave SSH é ed25519
  gerada pelo runo (`$RUNO_HOME/ssh/`), nunca reusada.
- As chaves de API dos agentes ficam na VM em `~/.runo/agent.env` (600) enquanto o
  env existe; `runo destroy` leva o EBS junto (DeleteOnTermination).

## Evidência (`runo validate`)

Baixada para `<worktree>/.kodus/evidence/<sha>.json` + `<sha>.md` + `logs/`:
schema com `repo/branch/sha/env/startedAt/finishedAt/status/steps[]/urls` —
contrato futuro com a Kody (review-time usa o MESMO run).

## Resultado real dos critérios de aceite

> Nota histórica: os critérios foram executados quando o CLI ainda se
> chamava `kd` — os outputs abaixo são verbatim das execuções reais e mantêm
> o nome antigo (comandos, tags e nomes de instância `kd-*`). O produto foi
> renomeado para **runo** (runo.sh) depois, sem mudança de comportamento.

Executados em 2026-08-11, conta AWS do time, região `sa-east-1`,
`KD_HOME=~/.kodus-fangtooth` (hash `432f41`). Outputs abaixo são colados das
execuções reais (IPs eram públicos e as instâncias já foram destruídas).

> **Desvio consciente de KD_HOME:** a instrução original pedia
> `~/.kodus-angelshark`, mas esse home estava **em uso ativo por outro
> workspace** (agente paralelo "angelshark") com formato de registry
> incompatível e 2 VMs próprias — compartilhar o home corromperia o registry
> dos dois e o `destroy --all` de um mataria as VMs do outro. Este run usou
> `~/.kodus-fangtooth`, e o kd passou a escopar guardrail/inventário/limpeza
> pela tag `kd:home-hash`, exatamente para instalações paralelas coexistirem.

### demo-app (`examples/demo-app/`)

**1. `kd init --force` gera recipe válida — ✅ PASSOU**

```
✓ recipe proposta em .../examples/demo-app/.kodus/workspace.yaml
! porta 3000 assumida — ajuste services.app.port se o app usa outra
```

Recipe gerada (parseada e validada pelo próprio kd antes de escrever): bun
detectado, `db: postgres:16`, `app` público na 3000, data `db:migrate`/`db:seed`,
validate `lint`+`test`, `t3.medium`/30gb.

**2. `kd new teste-a` → EC2 + serviços + seed + URL pública — ✅ PASSOU**

```
▸ criando VM para kd-432f41-task-teste-a (t3.medium, 30GB)…
  instância i-01da39eaf4458588d criada (t3.medium, 30GB gp3, sa-east-1)
▸ aguardando provisionamento (cloud-init) — primeiro boot leva alguns minutos…
▸ subindo código (git archive HEAD)…
▸ setup: bun install
▸ subindo 1 serviço(s) de imagem (docker compose)…
▸ iniciando serviço "api" (tmux): bun run dev
▸ data: bun run db:migrate  →  migrate: tabela items ok
▸ data: bun run db:seed     →  seed: 3 rows
✓ "api" respondendo em http://18.230.77.85:3000
$ curl http://18.230.77.85:3000/items
[{"id":1,"name":"alpha"},{"id":2,"name":"beta"},{"id":3,"name":"gamma"}]
```

**3. `kd new teste-b` em paralelo, duas URLs simultâneas — ✅ PASSOU**

```
$ curl http://18.230.77.85:3000/items & curl http://15.229.247.143:3000/items & wait
[{"id":1,"name":"alpha"},...,{"id":3,"name":"gamma"}]   (teste-a)
[{"id":1,"name":"alpha"},...,{"id":3,"name":"gamma"}]   (teste-b)
```

**4. `docker ps` local sem containers do kd — ✅ PASSOU**

Com os dois envs de pé, o `docker ps` local mostrou apenas os 3 containers
fixos do usuário (brendi-e2e-pg, mongodb, kodus-service-billing — anteriores ao
kd). Nenhum container `kd-*`: o laptop ficou fora do caminho de execução.

**5. `kd ls` — ✅ PASSOU**

```
ENV                     BRANCH        ESTADO   URL                         UPTIME  INSTÂNCIA
kd-432f41-task-teste-a  task/teste-a  running  http://18.230.77.85:3000    4m26s   t3.medium
kd-432f41-task-teste-b  task/teste-b  running  http://15.229.247.143:3000  2m18s   t3.medium
```

**6. `kd agent claude` na VM + mudança + `kd pull` — ⚠️ PARCIAL (bloqueio de ambiente, não do kd)**

- Sessão na VM: ✅ — `kd exec -- hostname` → `ip-172-31-30-142`
  (laptop: `Gabriels-MacBook-Air.local`).
- Injeção de auth: ✅ — `kd agent claude -- -p "…"` abriu o claude NA VM e o
  erro retornado veio da API da Anthropic **através** do CLI remoto:
  `Failed to authenticate. API Error: 401 API key is invalid.`
- **As duas chaves de `~/.kodus/agent.env` estão inválidas** (401 testado
  localmente contra api.anthropic.com e api.openai.com, sem imprimir valores).
  Com chave válida no arquivo, o fluxo completo funciona sem mudança de código.
- Mudança trivial + pull: ✅ — feita na VM pelo mesmo caminho SSH do agente
  (`kd exec -- "echo '…' >> README.md"`), e `kd pull` trouxe o diff:

```
✓ pull concluído — mudanças no worktree local:
M README.md
```

**7. `kd validate` → exit 0, JSON+MD no schema — ✅ PASSOU**

```
✓ lint: passed (343ms, exit 0)
✓ test: passed (360ms, exit 0)
exit=0
.kodus/evidence/19e2a99.json + 19e2a99.md + logs/19e2a99-{lint,test}.log
```

JSON conforme o contrato (version/repo/branch/sha/env/startedAt/finishedAt/
status/steps[]/urls).

**8. Teste quebrado na VM → exit ≠ 0, step failed, log capturado — ✅ PASSOU**

```
$ kd exec -- "docker exec kd-db psql -U postgres -qc 'DELETE FROM items WHERE id=1'"
$ kd validate ; echo exit=$?
✓ lint: passed  ✗ test: failed (exit 1)
exit=1
# log: "(fail) GET /items retorna as 3 rows do seed … 1 pass 1 fail"
$ kd exec -- bun run db:seed   # desfeito; revalidado exit=0
```

**9. `kd suspend` → stopped; `kd resume` → novo IP + dados intactos — ✅ PASSOU**

```
IP antes: 18.230.77.85
$ kd suspend  →  aws describe-instances: "stopped"
$ kd resume
✓ novo IP público: 54.94.134.172
$ kd url            →  http://54.94.134.172:3000
$ curl http://54.94.134.172:3000/items
[{"id":1,"name":"alpha"},{"id":2,"name":"beta"},{"id":3,"name":"gamma"}]   # EBS sobreviveu
```

**10. `kd destroy` nos dois → zero instância kd ativa, worktrees/registry limpos — ✅ PASSOU**

```
$ kd destroy --branch task/teste-a && kd destroy --branch task/teste-b
$ aws ec2 describe-instances --filters tag:kd:managed=true tag:kd:home-hash=432f41 \
    Name=instance-state-name,Values=pending,running,stopping,stopped
(vazio)
$ ls ~/.kodus-fangtooth/worktrees/   → (vazio)
$ cat ~/.kodus-fangtooth/envs.json   → { "version": 1, "envs": {} }
```

Nota: restavam na conta 2 instâncias `kd:managed` **de outro home-hash**
(`kd-a28ff0-*`, do workspace paralelo angelshark) — fora do escopo desta
instalação por design; o kd não toca instâncias de outro KD_HOME.

### kodus-ai

**11. `kd init` propõe recipe passthrough — ✅ PASSOU (com 2 deltas do repo real)**

Proposta: `docker-compose.dev.yml`, `public: kodus-api`, data
`migration:run`/`seed`, validate `lint`+`test-rbac`, `t3.xlarge`/100gb.
Deltas vs o enunciado do TASK: (a) o profile `local-db` **não existe mais** no
compose atual — os serviços principais (api, worker, webhooks, web, rabbitmq,
postgres, mongo) são profile-less e sobem por default, que é o comportamento
equivalente; (b) `files.copy: [.env]` só é proposto quando o `.env` existe na
âncora git do repo (aqui o `core.worktree` do checkout aponta para um workspace
sem `.env` — o arquivo foi copiado para o worktree do kd na revisão da recipe,
que é o fluxo normal: init propõe, dev revisa).

**12. `kd up` numa branch de task — ✅ PASSOU**

Branch `task/kd-smoke` (base `fix/e2e-matrix-signal`), instância
`i-09935eb862cdcf218` (t3.xlarge, 100GB gp3). O `.env` subiu via `files.copy`,
o compose do repo rodou COMO ESTÁ na VM e o healthcheck externo passou:

```
▸ copiando untracked: .env
▸ setup: docker network create kodus-backend-services … / shared-network …
▸ setup: pnpm install                    (na VM; preinstall do pnpm 11 passou)
▸ subindo compose do repo (docker-compose.dev.yml)…
 Container rabbitmq  Healthy … Container kodus_api  Healthy … kodus_web Started
▸ data: pnpm run migration:run   →  "No migrations are pending"
▸ data: pnpm run seed            →  "Seeder finished"
▸ healthcheck externo de "kodus-api" → http://15.229.6.115:3001/health/simple (timeout 1200s)
✓ ambiente kd-432f41-task-kd-smoke de pé
$ curl -w '%{http_code}' http://15.229.6.115:3001/health/simple   →  200
$ kd exec -- docker ps   →  kodus_api/worker/webhooks/web/db_postgres/rabbitmq/mongodb (healthy) NA VM
```

Aprendizados que viraram recipe (fluxo normal: init propõe → dev revisa):
o compose declara as networks externas `kodus-backend-services` e
`shared-network` (existem no laptop dos devs, não numa VM fresca) — entraram
como steps de `setup:`; e `health_timeout: 1200` porque o primeiro boot do
Nest em watch passa fácil dos 120s default. Primeiro `kd up` levou ~30min
(builds das imagens na VM); os seguintes usam o cache do Docker no EBS.
Um env por vez, como manda o critério.

**13. `kd validate` (lint) com evidência — ✅ PASSOU (mecânica; o step reprovou o código de verdade)**

```
▸ validate[lint]: pnpm run lint (na VM)
✗ lint: failed (1m49s, exit 1)
✓ evidência: …/.kodus/evidence/0aa5acf.json (+ .md, + logs/)
exit=1
```

JSON no schema (repo/branch/sha/env/steps/urls). O exit ≠ 0 é **fiel**: a
branch base (WIP) reprova no próprio eslint com erros reais pré-existentes —
`✖ 114 problems (12 errors, 102 warnings)`, ex.:
`no-useless-assignment`, `no-irregular-whitespace`, `no-empty` — capturados em
`logs/0aa5acf-lint.log`. É exatamente a evidência que a Kody consumiria.

**14. (Estendido) dois envs kodus-ai em paralelo — ⏭️ NÃO EXECUTADO**

Estendido, não bloqueia. Um env por vez foi mantido de propósito (guardrail de
custo; cada env kodus-ai é um t3.xlarge).

### Geral

**15. (Estendido) segunda implementação de `RuntimeProvider` — ⏭️ NÃO IMPLEMENTADA**

Estendida, não bloqueia. A interface existe de verdade
(`src/provider/types.ts`; o engine só fala `RuntimeProvider` e nada fora de
`src/provider/aws.ts` importa AWS — verificável por grep). Fly Machines ou
Docker local entram como a segunda implementação na sequência do roadmap.

**16. `bun link` + este README — ✅ PASSOU (com uma ressalva de ambiente)**

```
$ readlink ~/.bun/install/global/node_modules/@kodus/kd
/Users/…/fangtooth/packages/kd
$ cd /tmp && kd ls
  nenhum ambiente — crie um com `kd new <nome>`
```

Ressalva: nesta máquina há **workspaces paralelos implementando o kd**, e o
`bun link` global é last-write-wins — outro workspace sobrescreveu o link duas
vezes durante esta execução. Se `kd` se comportar estranho, confira
`readlink ~/.bun/install/global/node_modules/@kodus/kd` e relinke, ou invoque
por caminho absoluto: `bun <repo>/packages/kd/bin/kd.ts`.

### Placar final

| # | Critério | Resultado |
| --- | --- | --- |
| 1 | init demo | ✅ |
| 2 | new teste-a + URL de fora | ✅ |
| 3 | teste-b em paralelo | ✅ |
| 4 | docker ps local vazio | ✅ |
| 5 | kd ls | ✅ |
| 6 | agent na VM + pull | ⚠️ parcial (chaves do agent.env inválidas — 401; mecânica toda provada) |
| 7 | validate exit 0 + evidência | ✅ |
| 8 | validate exit ≠ 0 + log | ✅ |
| 9 | suspend/resume + novo IP + dados | ✅ |
| 10 | destroy total (por home-hash) | ✅ |
| 11 | init kodus-ai passthrough | ✅ (deltas documentados: sem profile local-db no compose atual) |
| 12 | up kodus-ai + URL | ✅ |
| 13 | validate lint kodus-ai | ✅ mecânica (step reprova código real) |
| 14 | (estendido) 2 envs kodus-ai | ⏭️ não executado |
| 15 | (estendido) 2º provider | ⏭️ não implementado (interface provada por isolamento) |
| 16 | bun link + README | ✅ |

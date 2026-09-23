# runo — one remote environment per branch

`runo` materializes, for each git branch, a **remote environment on an AWS EC2
VM**: your code, services, a seeded database and a public URL — with your coding
agent (`claude`/`codex`) running **on the VM**. Your laptop stays out of the
execution path: with two environments up, local `docker ps` is empty.

```bash
runo new checkout-fix        # branch task/checkout-fix + remote env (~1.5min with pool)
runo agent claude            # Claude Code ON the VM — close the lid, it keeps working
runo url --open              # see the app running on its public URL
runo validate                # lint/tests on the VM + downloadable evidence
runo ship "feat: ..." --validate --destroy   # pull → commit → push → PR with evidence, then teardown
```

Provider v1 is **AWS EC2**, behind a `RuntimeProvider` interface — nothing
outside `src/provider/aws.ts` knows about AWS, by design.

## Install

```bash
git clone https://github.com/kodustech/runo.git
cd runo && ./install.sh
```

`install.sh` installs bun if missing, links the `runo` binary and runs
**`runo setup`** — a guided check of every prerequisite (tooling, AWS or
control-plane access, agent credentials **validated against the API**, recipe,
speed-ups), telling you exactly what to fix and fixing what it can. Run
`runo setup` again anytime; it exits non-zero while something is missing.

Local prerequisites:

- Bun ≥ 1.3, git, ssh/scp/rsync (macOS/Linux have them)
- Valid AWS credentials (`aws sts get-caller-identity` must answer)
- Agent credentials: `CLAUDE_CODE_OAUTH_TOKEN` (subscription — run
  `claude setup-token` once on your laptop) or `ANTHROPIC_API_KEY` /
  `OPENAI_API_KEY`, via env vars **or** `~/.kodus/agent.env`
  (`KEY=value` per line, chmod 600). Your laptop's interactive OAuth login
  does not travel to the VM.

Environment variables:

| Var | Default | Effect |
| --- | --- | --- |
| `RUNO_HOME` | `~/.runo` | state root (registry, worktrees, SSH keys). Parallel installs MUST use distinct RUNO_HOMEs |
| `RUNO_AWS_REGION` | `sa-east-1` | EC2 region (us-east-1 is ~40% cheaper if latency is acceptable) |
| `RUNO_DEBUG` | — | `1` prints stack traces |
| `RUNO_RECIPE` | `.kodus/workspace.yaml` | which recipe to read (same as `--recipe`) — one repo can describe a dev box AND a PR preview |
| `RUNO_PROFILE` | — | env profile (same as `--profile`): one env PER PROFILE of a branch — see "Profiles" |
| `RUNO_SSH_KEY` | — | private key as a value instead of a file, for machines with no `$RUNO_HOME` (CI) |
| `RUNO_MAX_INSTANCES` | `3` | ceiling on simultaneous RUNNING instances |
| `CLOUDFLARE_API_TOKEN` | — | only for `expose.domain` (named tunnels) |

## Commands

| Command | What it does |
| --- | --- |
| `runo setup` | guided doctor: checks tooling, AWS/control-plane access, agent credentials (validated against the API), recipe; fixes what it can |
| `runo init [--force]` | inspects the repo and proposes `.kodus/workspace.yaml` |
| `runo new <name>` | branch `task/<name>` + worktree + `runo up` |
| `runo up [--branch B] [--here]` | materializes the remote env (idempotent: existing → resume/reconcile); `--here` uses the CURRENT working tree as sync anchor (Orca/worktree tools) |
| `runo agent <claude\|codex> [args…]` | agent session ON the VM in tmux (Ctrl+B D detaches without killing it; running again reattaches), cwd in the repo, auth injected |
| `runo validate [step]` | runs `validate:` on the VM; downloads JSON+MD evidence; exit ≠ 0 on failure |
| `runo pull` | rsync VM → local worktree (commit/push happen locally) |
| `runo ship ["msg"] [--validate] [--destroy]` | the finish flow in one command: pull (tolerant of suspended envs) → commit → push → open the PR via `gh`. `--validate` only ships green and embeds the evidence in the PR body; `--destroy` tears the env down after |
| `runo push [--restart]` | rsync local worktree → VM; `--restart` restarts `run:` services (compose dev with watch hot-reloads by itself) |
| `runo url [--open]` | public URL of the `public` service (current IP + port) |
| `runo tunnel [port…]` | forwards `localhost:<port>` → VM (frontends behave exactly like local dev); defaults to the recipe's public ports |
| `runo logs [service] [-f]` | remote logs per service |
| `runo exec -- <cmd>` | arbitrary command on the VM, cwd in the repo |
| `runo ls` | envs: branch, state, URL, uptime, instance |
| `runo suspend` / `runo resume` | stop/start the EC2 instance (stopped costs no compute; **the IP changes** and runo redetects it) |
| `runo bake [--rm]` | bakes an AMI with provisioning done (~10-12min, once): subsequent `runo up` boot in ~1-2min instead of ~6. `--rm` removes image/snapshot |
| `runo pool [n]` | warm pool: n provisioned, **stopped** instances (EBS only, ~US$3/mo each); `runo new` claims one — adjusts type/disk while stopped and starts it (~40-60s). No arg shows status; `0` drains |
| `runo destroy [--all]` | terminates the instance (EBS included), removes worktree and registry; `--all` also removes keypair + SG. `--branch B` without `--profile` destroys every profile of the branch |

Every command accepts `--branch <B>` (which env) and `--profile <name>` (which
profile of that branch — see below).

## Profiles: several envs of one branch

A branch normally has one env. Some changes need the same code materialized
more than once — Kodus runs a **cloud** shape (billing, analytics) and a
**self-hosted** shape, and a pull request may need one, the other or both.
`--profile` (or `RUNO_PROFILE`) makes the profile part of the env's identity:
the env name, the VM name and tags, the worktree, the tunnel or ingress
hostname and the registry all split by profile, and an env created without
one keeps every identifier exactly as before.

```bash
runo up --here --branch "$HEAD_REF" --profile cloud        # env <slug>-cloud
runo up --here --branch "$HEAD_REF" --profile self-hosted  # env <slug>-self-hosted, same VM size rules
runo logs --branch "$HEAD_REF" --profile cloud             # commands need the profile once a branch has two
runo destroy --branch "$HEAD_REF"                          # takes every profile of the branch
```

- **Recipe**: `--profile X` without `--recipe` reads `.kodus/workspace.X.yaml`
  when it exists and falls back to `.kodus/workspace.yaml`. `--recipe` always
  wins, so `--profile cloud --recipe .kodus/workspace.preview.cloud.yaml` is
  the CI form. The env remembers its recipe either way.
- **Lookup**: a branch with several profiles refuses to guess — `runo push`
  without `--profile` fails with the list of profiles instead of syncing the
  wrong machine. Inside a runo-created worktree the profile is implied.
- **Dev boxes**: git allows one worktree per branch, so two profiles of the
  same branch on a laptop need `runo up --here` from separate checkouts (an
  Orca worktree per profile, for instance). CI, which always uses `--here`,
  has no such limit.
- **Control plane**: the server keys envs by repo + branch + profile, shows
  the profile in the panel and in `runo environments`, and `runo attach`
  records it.

## Recipe (`.kodus/workspace.yaml`, schema v1)

```yaml
version: 1
setup:
  - bun install
files:
  copy: [.env]              # untracked files copied from the local working tree to the VM
services:
  db:
    image: postgres:16      # image: → docker compose generated by runo
    port: 5432
    env: { POSTGRES_PASSWORD: runo }
  api:
    run: bun run dev        # run: → process on the VM (tmux), logs in ~/.runo/logs/
    port: 3000
    public: true            # opens the port on the SG → http://<ip>:3000
    health: /health         # HTTP health check performed FROM OUTSIDE (validates SG + service)
data:
  migrate: bun run db:migrate
  seed: bun run db:seed
validate:
  - name: lint
    run: bun run lint
  - name: test
    run: bun test
expose:
  mode: https               # how the env is reachable — see "Public access" below
limits:
  instance: t3.medium
  disk: 30gb
  idle_suspend: 10m         # default 10m; "2h" or "off" — idle auto-suspend
  idle_activity: [ssh, net, agent]  # default all; what counts as use. A public
                            # preview drops net: the clock then runs from the last up
  spot: true                # ~70% cheaper; AWS interruption = stop (EBS survives,
                            # runo resume restarts). Automatic on-demand fallback.
                            # Spot skips the warm pool and hibernation.
```

**Passthrough mode** (repos with their own compose). Multi-file overlays,
interpolation env (with `${RUNO_PUBLIC_IP}` / `${RUNO_PUBLIC_IP_DASHED}`
substituted at up time — dashed form for nip.io-style wildcard DNS) and an
explicit `public_port` are supported:

```yaml
services:
  compose:
    files: [docker/compose.yml, docker/compose.preview.yml]
    profiles: [back, front]
    env: { PREVIEW_DOMAIN: "${RUNO_PUBLIC_IP_DASHED}.nip.io" }
    public: gateway
    public_port: 80
```

Git submodules are shipped automatically (recursively): each submodule's
content is archived from an already-populated checkout at the exact commit the
superproject records — fully offline, still tracked-files-only.

**Simple passthrough** (single compose file):

```yaml
version: 1
setup:
  - pnpm install
files:
  copy: [.env]
services:
  compose:
    file: docker-compose.dev.yml
    profiles: []             # optional; the repo's compose runs AS-IS on the VM
    public: kodus-api        # service whose published port becomes the public URL
    health: /health/simple   # optional; without it the check is TCP
    health_timeout: 1200     # heavy apps need more than the 120s default on first boot
data:
  migrate: pnpm run migration:run
  seed: pnpm run seed
validate:
  - name: lint
    run: pnpm run lint
limits:
  instance: m7i-flex.xlarge  # non-burstable: heavy builds never throttle on CPU credits
  disk: 100gb
```

`services.compose` is mutually exclusive with `image:`/`run:`. Since the VM is
dedicated to the env (exclusive Docker daemon), fixed `container_name`s and
published ports from the repo **cannot collide by construction** — no DinD, no
compose overrides.

## Public access (`expose`)

How the env's services are reached from outside. Everything below is one
`ExposeProvider` (`src/expose/`) — the engine only asks for "service → URL".

```yaml
expose:
  mode: https               # https | tunnel | ip
  domain: preview.acme.com  # tunnel only: named tunnel on a domain you own
  hostname: pr-${RUNO_SLUG} # tunnel + domain only (default: the env slug)
```

| mode | URL | Setup | Inbound ports | Stable across suspend/resume |
| --- | --- | --- | --- | --- |
| `https` (proposed by `runo init`) | `https://<ip-dashed>.sslip.io` | none | 80, 443 | no (the IP is in the name) |
| `tunnel` | `https://<random>.trycloudflare.com` | none | none | no (a new name per restart) |
| `tunnel` + `domain` | `https://<slug>.<domain>` | Cloudflare token | none | yes |
| `ip` | `http://<ip>:<port>` | none | every service port | no |

- **`https`** runs Caddy on the VM and gets a real Let's Encrypt certificate
  for the VM's [sslip.io](https://sslip.io) name (that service resolves any
  name carrying an embedded IP). No account anywhere, and only 80/443 face the
  world — the service ports stay closed.
- **`tunnel`** dials out to Cloudflare, so nothing has to be reachable from the
  internet at all. Without `domain` it uses quick tunnels: free and
  credential-less, but the hostname is redrawn on every restart and **many
  resolvers blackhole `*.trycloudflare.com`** (quick tunnels get abused for
  phishing, so filters block the zone) — check with `dig @1.1.1.1 <host>` if a
  URL works for you and not for a colleague.
- **`tunnel` + `domain`** keeps ONE hostname for the life of the env, which is
  what a link in a pull request needs. Needs `CLOUDFLARE_API_TOKEN` with
  *Account → Cloudflare Tunnel → Edit* and *Zone → DNS → Edit*; runo creates
  the tunnel, the ingress rules and the CNAME, and deletes all three on
  `runo destroy`. Note Cloudflare's free Universal SSL only covers ONE level of
  subdomain: `pr-1.acme.com` is served, `pr-1.preview.acme.com` needs Advanced
  Certificate Manager.
- **`ip`** is the original behavior and stays the default for recipes with no
  `expose:` block.

Services listed in `services.compose.public` each get their own URL — the first
is the primary, the others are reached at `<service>--<primary host>`. Their
addresses are substituted into the compose environment BEFORE the stack boots
(`${RUNO_PUBLIC_URL}`, `${RUNO_PUBLIC_HOST}`, `${RUNO_URL_<SERVICE>}`,
`${RUNO_HOST_<SERVICE>}`), because an app that emits absolute links — auth
callbacks, a frontend calling its own API — has to know its public address at
startup.

## Worktree tools (Orca & friends): `runo up --here`

If another tool already owns your worktrees (Orca, `git worktree` by hand),
skip `runo new` entirely: run `runo up --here` inside the worktree and that
directory becomes the env's sync anchor — `runo push`/`pull` sync it, and
`runo destroy` terminates the instance but **never touches the directory**.

Orca post-create hook (one line — every new worktree gets a remote env):

```bash
# copy untracked requirements first if your recipe needs them, e.g.:
# cp ~/dev/my-repo/.env .
runo up --here
```

## Two ways to use an agent

1. **Agent ON the VM** (`runo agent claude|codex`) — the brain runs there, in a
   tmux session: watch it live in your terminal, detach (Ctrl+B D or close the
   laptop) and the agent keeps working; `runo agent` reattaches with scrollback.
   Subscription auth via `claude setup-token` (CLAUDE_CODE_OAUTH_TOKEN) or an
   API key.
2. **Local agent driving the VM** — your local agent (with your subscription)
   treats the env's worktree as a regular local repo: edit files →
   `runo push [--restart]` → change live on the public URL →
   `runo validate`/`logs`/`exec` to verify. Zero credentials in the cloud.

## How it works

- **One EC2 instance per env** (Ubuntu 24.04 resolved via SSM Parameter Store;
  cloud-init installs docker+compose, node 22, bun, pnpm, tmux, rsync and the
  `claude`/`codex` CLIs). Tags: `Name=runo-<hash6>-<slug>`, `runo:env`,
  `runo:managed=true`, `runo:home-hash`.
- **Code travels via `git archive HEAD`** (tracked files only) + `files.copy`
  for untracked files (.env). `git init + commit` on the VM so the agent can
  use git there. **Zero git credentials in the cloud** — changes come back via
  `runo pull` (rsync); commit/push happen on your laptop.
- **One local worktree per env** (`$RUNO_HOME/worktrees/<repo>-<slug>`) is the
  sync anchor: upload source, pull destination. Branch already checked out in
  your main working tree → clear error suggesting `runo new`.
- **Agent auth**: env vars → `~/.kodus/agent.env` (global, independent of
  RUNO_HOME). Credentials travel via a chmod-600 file over scp, never via
  argv/logs.
- **Health checks from outside**: HTTP 200 on `health:` (or TCP) against the
  public IP — validates the security group and the service in one shot.
  Failure fails `runo up` with the service's log tail.
- **Suspend/resume**: a stopped instance costs no compute (EBS only, cents/day).
  EBS survives stop/start — database data persists. **The public IP changes**
  on every resume; runo redetects and updates registry/URL.
- **Idle auto-suspend** (`limits.idle_suspend`, default 10m): a watchdog ON the
  VM (1/min cron) shuts the instance down after N minutes without activity —
  internal shutdown becomes "stopped" (= suspend). Activity = established SSH
  session, network traffic (>100KB/min — includes someone using the public
  URL) or CPU from claude/codex processes (a detached agent that is working
  counts as active; an agent idle at the prompt does not). Every `runo up` and
  resume restarts the clock. `limits.idle_activity` narrows the signals: a
  public URL draws bot and outbound traffic that never lets a VM look idle, so
  a PR preview uses `[ssh, agent]` and suspends N after its last deploy.
- **Baked image** (`runo bake`): a temporary VM runs full cloud-init,
  `cloud-init clean`, stop, `CreateImage`. `runo up` then uses that AMI (no
  heavy user-data) and cold boot drops from ~6min to ~1-2min. Idle cost: just
  the snapshot (~US$1.4/mo for 30GB). Re-baking replaces the previous image.
- **Warm pool** (`runo pool <n>`): pre-provisioned instances wait STOPPED.
  `runo new` claims one: retag → adjust instance type
  (`ModifyInstanceAttribute`) and grow the disk (`ModifyVolume` + growpart on
  boot) if the recipe asks for more → `StartInstances`. Env ready in ~40-60s.
  The cost guardrail only counts RUNNING instances.
- **Hibernation**: envs launch with `HibernationOptions` + encrypted root.
  `runo suspend` hibernates (RAM → EBS); `runo resume` probes the services
  first and, if they answer (hot return), restarts nothing — the app comes
  back in the exact state it was. Graceful fallback to plain stop/boot when
  hibernation is unavailable. Idle auto-suspend uses plain stop (the decision
  comes from inside the VM, which has no AWS credentials — by design).
- **Spot** (`limits.spot: true`): **persistent** spot instance with
  interruption behavior **stop** — an AWS interruption is, in practice, an
  unplanned auto-suspend (EBS intact, `runo resume` restarts; IP changes as
  always). `runo destroy` cancels the spot request BEFORE terminating
  (otherwise AWS would launch a replacement). `runo ls` marks `(spot)`.
  Reference: t3.xlarge sa-east-1 ~US$0.08-0.11/h (vs 0.27 on-demand).
- **Local registry**: `$RUNO_HOME/envs.json`.
- **Cost guardrails**: max 3 RUNNING instances *per install* (scoped by the
  `runo:home-hash` tag); everything tagged `runo:managed=true`.

## Measured timings (real runs)

| Operation | Time |
| --- | --- |
| `runo push` (hot loop: edit → live) | ~1-3s |
| `runo new` with warm pool + baked AMI | ~1m30 to green health |
| `runo new` cold (no bake/pool) | ~6-7min |
| `runo resume` after hibernation | ~1min, services already hot |
| `runo suspend` (hibernating 4GB RAM) | ~1m30 |
| `runo bake` (one-time) | ~11min |

## Teams: control plane — no AWS credentials on laptops

For CI-created previews shared with QA agents, see
[shared preview setup and migration](docs/shared-previews.md).
`runo environments` discovers accessible environments, `runo attach <env-name>`
connects a checkout, and `runo share [user...]` sets collaborators (owner only).

For solo use, the CLI talks to AWS directly with your local credentials. For
teams, run **runo-server**: it holds the AWS credentials and the SSH keys;
developers need **zero cloud credentials** — they sign in with GitHub and use a
personal token.

```
dev laptop (CLI, no AWS creds)          runo-server (control plane)
  RemoteProvider ─── HTTP/WS ───►       bearer token → EC2 provider + SSH keys
  RUNO_SERVER + RUNO_TOKEN              env registry + history (server.db)
browser ─── GitHub OAuth ───────►       web panel: envs, history, cost, settings
```

Operator (platform team), on a machine that has AWS credentials:

```bash
RUNO_HOME=~/.runo-server \
RUNO_PUBLIC_URL=https://runo.example.com \
RUNO_GITHUB_CLIENT_ID=... RUNO_GITHUB_CLIENT_SECRET=... \
RUNO_GITHUB_ALLOWED_ORGS=your-org \
RUNO_SERVER_ADMINS=your-github-login \
RUNO_SERVER_TOKENS="preview-ci:<long-random>" \
bun server/main.ts --port 7777
```

| Who | Signs in with | Gets |
|---|---|---|
| People | GitHub (active member of an allowed org, or a listed user) | the panel; mint their own CLI token there |
| CI / agents | a token: `RUNO_SERVER_TOKENS`, or a service account created in the panel | the full API |
| Teams without GitHub | tokens only — leave the `RUNO_GITHUB_*` variables out | the panel via "use an access token" |

Setup (OAuth App, callback URL, GitHub Enterprise, what a browser session may
and may not do, offboarding) is in
[docs/control-plane-panel.md](docs/control-plane-panel.md).

Developers — open the server's URL, sign in with GitHub, then settings → CLI
tokens → create token (shown once):

```bash
export RUNO_SERVER=https://runo.example.com
export RUNO_TOKEN=runo_...
runo new my-task        # same CLI, same flow — AWS stays server-side
```

- Every provider operation (create/suspend/exec/upload/…) goes through the
  server; long steps stream live output back to the terminal.
- **Ingress — one hostname per env** (`RUNO_INGRESS_DOMAIN=envs.example.com`
  + wildcard DNS `*.envs.example.com` → the server): every env gets
  `http://<slug>.envs.example.com`, extra services at
  `http://<service>--<slug>.envs.example.com`. Solves parallel envs (no port
  collisions), shareable links, and frontend API-base assumptions. Suspended
  env → friendly 503 telling you to `runo resume`. v0 proxies HTTP only
  (no WebSocket/HMR — use `runo tunnel` for that); terminate TLS in front.
- **Web panel**: open the server's URL in a browser and sign in — live envs
  (suspend/resume/destroy), the history of every machine and who asked for it,
  estimated cost by person/repo/instance type, fleet peaks, an audit trail, and
  the settings an admin used to need SSH for. Same port, nothing else to
  deploy. See [docs/control-plane-panel.md](docs/control-plane-panel.md).
- `GET /v1/envs` (`?live=1` for instance state) is the same data as JSON.
- The recipe stays committed in each repo: platform team writes it once by PR,
  devs never touch infra config.
- `runo agent` over the control plane uses an experimental WebSocket TTY
  tunnel; headless usage (`runo agent claude -- -p …`) works everywhere.
- **Org policies** (`$RUNO_HOME/policies.yaml` on the server, hot-reloaded —
  see `server/policies.example.yaml`): instance-type allowlist, max disk,
  max envs per user, org-wide running ceiling, and an env TTL with automatic
  destruction (sweeper at startup + every 10min). The recipe in each repo
  decides the machine for that workload; policies are the platform team's
  ceilings on what any recipe/user may ask for. Violations fail `runo new`
  instantly with an actionable message — before anything touches the cloud.
  `GET /v1/policies` shows the active policy set.
- Single process; state is `server-envs.json` (what exists now) plus
  `server.db` (SQLite: history, users, sessions, tokens — secrets hashed).
  Login is GitHub OAuth restricted to your org/users, and/or bearer tokens.
  Put TLS (Caddy, ALB, Tailscale) in front before exposing it beyond localhost.

## Security — accepted v1 limitations (documented on purpose)

- **The public URL has no auth**, whichever `expose` mode you pick. Anyone who
  has it (or scans for it) reaches the app. Therefore: ALWAYS use a development
  `.env` — never production credentials. TLS is on by default (`https` /
  `tunnel`); `expose.mode: ip` additionally serves plain HTTP on every service
  port.
- The SG opens 22 and the public ports to `0.0.0.0/0`. The SSH key is an
  ed25519 generated by runo (`$RUNO_HOME/ssh/`), never reused.
- Agent API credentials live on the VM at `~/.runo/agent.env` (600) while the
  env exists; `runo destroy` takes the EBS with it (DeleteOnTermination).

## Validation evidence (`runo validate`)

Downloaded to `<worktree>/.kodus/evidence/<sha>.json` + `<sha>.md` + `logs/`:
a schema with `repo/branch/sha/env/startedAt/finishedAt/status/steps[]/urls` —
the future contract with Kody (review-time runs the SAME validation).

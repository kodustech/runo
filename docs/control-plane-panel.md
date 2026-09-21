# Control plane panel

The panel is served by `runo-server` on the same port as the API. It answers
four questions the JSON registry could not: which machines existed and who
asked for them, what they cost, how big the fleet got, and what the platform
team can change without SSH.

## Signing in

Two ways in; enable either or both.

**GitHub OAuth** (people). Create an OAuth App — for an organization: Settings →
Developer settings → OAuth Apps — with the callback
`<RUNO_PUBLIC_URL>/auth/github/callback`, then set on the server:

```bash
RUNO_PUBLIC_URL=https://runo.example.com
RUNO_GITHUB_CLIENT_ID=...
RUNO_GITHUB_CLIENT_SECRET=...
RUNO_GITHUB_ALLOWED_ORGS=your-org          # and/or
RUNO_GITHUB_ALLOWED_USERS=alice,bob
# RUNO_GITHUB_URL=https://github.example.com   # GitHub Enterprise Server
# RUNO_SESSION_HOURS=24
```

Who may log in is yours to define: active members of any listed org, plus any
listed user. With a client id and **no** allowlist the server refuses to start —
otherwise every GitHub account could sign in. If your org restricts third-party
apps, an owner has to approve the OAuth App once, or membership checks fail.
The GitHub access token is used for the login and discarded.

**Access token** (service identities, or teams without GitHub). Any bearer
token — `RUNO_SERVER_TOKENS` or one minted in the panel — can be exchanged for a
session on the login page. It is never kept in browser storage.

Admins are `RUNO_SERVER_ADMINS` (token identities or GitHub logins) plus anyone
an admin promotes in the panel.

## What a session can and cannot do

| | bearer token (CLI/CI) | browser session |
|---|---|---|
| create, exec, upload, download, tty, bake | yes | **no** |
| status, suspend, resume, destroy, share | yes | yes |
| history, cost, activity | yes | yes |
| policies, prices, users | admins | admins |
| mint a CLI token, change roles | — | only within 15 min of logging in |

Admins can suspend/resume/destroy **any** machine (that is the cost lever) but
get no exec/upload/download on machines they do not own or share.

The session cookie is `HttpOnly`, `SameSite=Lax`, `Secure` and `__Host-`
prefixed when `RUNO_PUBLIC_URL` is https, so an environment served on a sibling
ingress subdomain cannot read or overwrite it. State-changing requests must
carry the panel's header and origin. Sessions, tokens and the OAuth state are
stored and compared as SHA-256. Failed token logins are throttled per address.

Offboarding: remove the person from the GitHub org (no new logins) **and**
disable them in settings → people, which ends their sessions and stops every
token they minted immediately.

## History, peaks and cost

Once a minute the server lists the fleet and records what it sees in
`$RUNO_HOME/server.db`. That is how it knows about stops nobody asked it for —
the idle watchdog, a spot interruption, someone in the AWS console — shown in
the activity tab as `auto-stopped` / `auto-started` / `vanished`. Environments
that predate the database are picked up at the first sample; their earlier
hours are unknown, so history starts when this version first runs.

Cost is an **estimate**: observed running hours × on-demand price + public IPv4
while running + gp3 storage for as long as the machine exists (stopped
included). Not modeled: data transfer, `runo bake` images/snapshots, surplus CPU
credits of `unlimited` burstables. Spot machines are priced with the editable
spot factor (default 1 = a ceiling). Built-in prices exist for us-east-1/2 and
the t3 family in sa-east-1; an instance type without a price is called out on
the overview instead of silently counting as free. Editing a price re-prices
all history. While the server is down nothing is sampled: a machine that was
running before and after is counted as running throughout.

## Settings

- **Policies** — the same `policies.yaml` as before, validated and written
  atomically; hand edits still work and still hot-reload.
- **Prices** — the table above.
- **People and service accounts** — promote/demote, disable; create token-only
  identities for CI and agents. A GitHub login can never take over a service
  account's name.
- **CLI tokens** — everyone mints their own (shown once, stored hashed); admins
  mint for service accounts. `RUNO_SERVER_TOKENS` keeps working for bootstrap.
- **Server** — region, AWS identity pin, instance ceiling, login allowlist:
  read-only on purpose. Who may log in and which cloud account is used should
  not be one panel click away.

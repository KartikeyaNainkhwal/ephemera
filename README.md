# Ephemera

**Disposable, fully isolated environments on Zerops — one per pull request, one per agent task.**

Every pull request gets its own running application *and its own dedicated PostgreSQL database*, at a public URL, in about 90 seconds. When the pull request closes, the infrastructure is destroyed, the cost is reported on the PR, and nothing is left billing. The same engine is exposed over MCP, so a coding agent can ask for real, disposable infrastructure mid-task instead of guessing against a mock.

Built for the [Zerops Challenge](https://www.wemakedevs.org/hackathons/zerops), 8–9 August 2026.

---

## The problem

Reviewing a pull request means reading a diff and imagining the result. The alternative — checking out the branch, installing dependencies, standing up a database, seeding it — costs enough friction that most reviews stay imaginary.

Preview environments solve this, and are standard at well-resourced companies. But for anything beyond a static frontend they are genuinely hard, because a useful preview needs *real backing services*, not just a built bundle. Two previews sharing one database is a subtly broken preview: test a migration in one and you silently corrupt another.

AI coding agents have the same problem in a sharper form. They are handed sandboxes with mocked services, and everyone is surprised when real infrastructure behaves differently. Zerops's own position is that agents should develop against real managed services — but ZCP is deliberately scoped to **one agent, one project**, enforced at startup. Ephemera is the layer above: **many isolated environments, created and destroyed programmatically.**

## What it does

```
Connect a repository          →  Ephemera creates the webhook for you
Open a pull request           →  bot comment with the URL, before the infra exists
      ~90 seconds             →  app + its own PostgreSQL, serving traffic
Push to the branch            →  environment replaced with the new commit
Close / merge the PR          →  destroyed, final cost reported on the PR
```

- **Pull requests** — connect a repo from the dashboard; webhooks, comments and teardown are automatic.
- **Agents** — an MCP server exposes `create_environment`, `get_environment`, `list_environments`, `destroy_environment`.
- **Dashboard** — a live console: create environments, extend or destroy them, connect repositories, watch cost accrue per second, browse history.
- **API** — everything above is one authenticated HTTP API.
- **Reaper** — anything past its TTL is destroyed automatically, including failed environments; protected hostnames can never be reaped.

## Security model

Ephemera v1 is **deliberately single-tenant**: you deploy it into your own Zerops account, and one admin key controls it — the same trust model as early Coolify or a self-hosted CI runner.

- Every mutating endpoint requires `Authorization: Bearer <EPHEMERA_API_KEY>` (constant-time comparison). Reads are public by default for status-page transparency; `EPHEMERA_PUBLIC_READS=false` locks them down.
- GitHub webhooks are verified with an HMAC-SHA256 signature over the raw body, and deliveries are deduplicated by delivery id.
- All creation input is validated — repo URL shape, branch characters, port ranges, TTL bounds, env-var names (the `ZEROPS_` prefix and Ephemera's own reserved variables are rejected with an explanation).
- A **hard capacity cap** (`MAX_LIVE_ENVIRONMENTS`, default 10) bounds the maximum possible bill, and a per-IP rate limit stops accidental creation loops.
- Database credentials never pass through the control plane — environments receive them as `${hostname_password}` references resolved by Zerops at deploy time.
- The reaper refuses to touch `PROTECTED_HOSTNAMES`, so a misconfigured TTL cannot destroy the control plane itself.

Deliberately **not** built yet, and documented rather than half-shipped: GitHub OAuth sign-in, multi-user workspaces, per-user permissions. See the roadmap.

## Architecture

```
GitHub ──webhook (HMAC)──┐
Dashboard ──admin key────┤
Coding agent ──MCP───────┴──► Ephemera control plane ──zcli──► Zerops (create / destroy)
                                (Node 22, Fastify)     └─REST─► Zerops (status, URLs)
                                       │
                                       ├── PostgreSQL   intent: what should exist, TTLs, history
                                       └── SSE          live dashboard feed
```

Each environment is **two services** inside one long-lived Zerops project:

| service | type | purpose |
|---|---|---|
| `<slug>api` | a runtime, e.g. `nodejs@22` | the application, built by Zerops directly from git |
| `<slug>db` | `postgresql:single@16` | that environment's private database |

### Decisions worth explaining

**Environments are services inside one project, not one project each.** Measured: project creation carries a fixed ~2m10s core-activation cost that service creation does not. Same isolation for review purposes, less than half the wall clock.

**Every environment gets its own database.** Measured at **+7 seconds** versus sharing one. Isolation is effectively free, so there is no reason not to.

**Mutations go through `zcli`; reads go through the REST API.** Zerops documents no REST endpoint for Import YAML, so creation and deletion use the CLI. Status and service inventory come from `GET /project/{id}/service-stack`, which accepts the Personal Access Token directly as a bearer token.

**State is reconciled, not assumed.** Readiness means the app answered HTTP, not that the platform said ACTIVE. Teardown is confirmed by polling until the services are actually gone — an exit code is not evidence. On boot, the control plane re-attaches watchers to any environment caught mid-provision or mid-teardown by a restart, so nothing sits in `creating` forever and nothing keeps billing after a crash.

**URLs are computed before the infrastructure exists.** Zerops subdomains follow `{hostname}-{projectCode}-{port}.{region}.zerops.app` with a fixed per-project code, so the PR comment carries a working link the moment the webhook fires.

**The reaper is the point.** Creating infrastructure is easy; reliably removing it is what makes handing out environments safe. TTL-expired environments — including failed ones — are destroyed automatically.

## Running it

### 1. Deploy the control plane

```bash
# Create the services in your Zerops project (edit the placeholders first)
zcli project service-import infra/control-plane.yml -P <project-id>

# Deploy the code
zcli service push ephemera -P <project-id> --setup ephemera

# Expose it (after the first deploy - see platform note 6)
zcli service enable-subdomain ephemera -P <project-id>
```

### 2. Configure

Copy `.env.example` for the full list. The essentials:

| variable | required | purpose |
|---|---|---|
| `EPHEMERA_ZEROPS_TOKEN` | yes | Zerops Personal Access Token |
| `EPHEMERA_PROJECT_ID` | yes | project that hosts the environments |
| `EPHEMERA_PROJECT_CODE` | yes | 4-char code in public subdomains, e.g. `2c46` |
| `EPHEMERA_API_KEY` | yes | admin key for all mutating endpoints (`openssl rand -hex 24`) |
| `GITHUB_TOKEN` | for PR flow | enables repo connect + PR comments (`repo`, `admin:repo_hook`) |
| `GITHUB_WEBHOOK_SECRET` | for PR flow | webhook signature verification |
| `MAX_LIVE_ENVIRONMENTS` | no | capacity cap, default `10` |
| `DEFAULT_TTL_MINUTES` | no | default `120` |
| `PROTECTED_HOSTNAMES` | no | services the reaper must never destroy |

### 3. Connect a repository

Open the dashboard, enter `owner/name`, press Connect. Ephemera creates (or adopts and normalises) the `pull_request` webhook on the repository. Open a pull request and watch.

## HTTP API

| method | path | auth | purpose |
|---|---|---|---|
| `GET` | `/api/environments?all=true` | public¹ | list environments (all= includes destroyed) |
| `GET` | `/api/environments/:id` | public¹ | environment detail |
| `POST` | `/api/environments` | key | create an environment |
| `PATCH` | `/api/environments/:id` | key | extend TTL (`{"ttlMinutes": 120}`) |
| `DELETE` | `/api/environments/:id` | key | destroy an environment |
| `GET` | `/api/stream` | public¹ | server-sent events feed |
| `GET` | `/api/repos` | public¹ | list connected repositories |
| `POST` | `/api/repos` | key | connect a repository (`{"repo":"owner/name"}`) |
| `DELETE` | `/api/repos/:owner/:name` | key | disconnect a repository |
| `POST` | `/webhooks/github` | HMAC | GitHub events |
| `GET` | `/api/health` | public | liveness + running version |

¹ public unless `EPHEMERA_PUBLIC_READS=false`.

Create example:

```bash
curl -X POST https://<control-plane>/api/environments \
  -H "authorization: Bearer $EPHEMERA_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"slug":"demo","repo":"https://github.com/<you>/<repo>","branch":"main"}'
```

### Per-repository configuration

Drop an `ephemera.json` in the repository root; Ephemera reads it from the branch under review:

```json
{
  "runtime": "nodejs@22",
  "port": 3000,
  "buildCommands": ["npm install --omit=dev"],
  "startCommand": "npm start",
  "ttlMinutes": 240
}
```

## Give an agent environments

```json
{
  "mcpServers": {
    "ephemera": {
      "command": "node",
      "args": ["/path/to/ephemera/dist/mcp/server.js"],
      "env": {
        "EPHEMERA_URL": "https://<control-plane>",
        "EPHEMERA_API_KEY": "<admin key>"
      }
    }
  }
}
```

> *"Spin up a disposable environment with Postgres, run the migration, tell me if it works, then destroy it."*

## Platform details this encodes

Each of these was found empirically against a live Zerops project, and each one breaks silently:

1. **Hostnames**: max 25 characters, lowercase `a-z` and `0-9` only.
2. **`envSecrets` does not override a repository's own `zerops.yml`.** Per-environment databases require the `zeropsYaml` field — as a **nested object**, not a string.
3. **A Zerops PostgreSQL always exposes `dbName = db` and `user = db`.** Only the hostname varies.
4. **Passwords resolve as `${<hostname>_password}`** at deploy time.
5. **The `ZEROPS_` env prefix is reserved** and rejected on import — which is why the API rejects it up front with an explanation.
6. **`enableSubdomainAccess` is a no-op when a service has no code yet** (no ports known). Enable it after the first deploy.
7. **`@zerops/zcli` ships `bin/zcli.js`**, a Node launcher — invoked through `process.execPath`.
8. **A trailing `.git` breaks `buildFromGit` silently** — the import is accepted, the build never starts. There is a unit test pinning this.
9. **`zcli` can exit non-zero after succeeding**, and can fail to resolve a hostname it just listed. Import and teardown are therefore verified against project state, and deletion addresses services by resolved id.
10. **Environment variables can be written via `POST /service-stack/{id}/user-data`** — absent from the public API reference.

## Measured performance

Against a live Zerops project, 9 August 2026:

| operation | time |
|---|---|
| **pull request opened → preview serving traffic** | **84–104 s** |
| environment created via API → serving traffic | 90 s |
| three environments created in parallel | 103 s, 109 s, 118 s |
| environment destroyed | ~26 s |
| cost of one environment | **$0.0040 / hour** |
| cost of a complete preview cycle | **$0.00119** (reported on the pull request) |

Verified on [ephemera-demo#1](https://github.com/KartikeyaNainkhwal/ephemera-demo/pull/1).

## Development

```bash
npm install
npm run typecheck   # strict TypeScript
npm test            # unit tests over the manifest generator, cost model, validation
npm run dev         # local dev server (needs a .env - see .env.example)
```

CI runs typecheck, tests and build on every push (`.github/workflows/ci.yml`).

## Project layout

```
src/
  config.ts              resolved configuration
  security.ts            admin-key auth + rate limiting
  db.ts                  PostgreSQL pool and schema
  zerops/
    manifest.ts          environment spec → Zerops Import YAML   (+ tests)
    cli.ts               zcli wrapper - all mutations
    client.ts            REST reads + behavioural probe
  environments/
    service.ts           lifecycle orchestration + restart reconciliation
    store.ts             persistence
    reaper.ts            TTL enforcement
    cost.ts              cost model                              (+ tests)
    validate.ts          request validation                      (+ tests)
  github/repos.ts        repository connect/disconnect (webhook management)
  routes/
    api.ts               environments API
    repos.ts             repository-connection API
    github.ts            webhook receiver + PR comments
    stream.ts            server-sent events
  mcp/server.ts          MCP server for coding agents
  web/dashboard.html     the console
infra/control-plane.yml  import manifest for the control plane itself
```

## Roadmap

- **GitHub App + OAuth sign-in** — multi-user, multi-workspace; the reason v1 is honest about being single-tenant.
- GitLab and Bitbucket webhooks.
- Database seed snapshots, so previews start with realistic data.
- Build/runtime log streaming into the dashboard.
- Slack/Discord notifications on environment ready/failed.

## AI use

Built with Claude Code (Claude Opus 5) as the primary development tool — research, code generation, debugging, and documentation. Every platform behaviour listed above was verified empirically against a live Zerops project rather than accepted from documentation; several contradict or are absent from the published docs. The architecture decisions in this README are the substance of the work, each backed by a measurement taken during the build.

## Licence

[MIT](LICENSE)

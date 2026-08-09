# Ephemera

**Disposable, fully isolated environments on Zerops — one per pull request, one per agent task.**

Every pull request gets its own running application *and its own dedicated PostgreSQL database*, at a public URL, in about 100 seconds. When the pull request closes, the infrastructure is destroyed and stops billing. The same engine is exposed over MCP, so a coding agent can ask for a real, disposable environment mid-task instead of guessing against a mock.

Built for the [Zerops Challenge](https://www.wemakedevs.org/hackathons/zerops), 8–9 August 2026.

---

## The problem

Reviewing a pull request means reading a diff and imagining the result. The alternative — checking the branch out, installing dependencies, standing up a database, seeding it — costs enough friction that most reviews stay imaginary.

Preview environments solve this, and are standard at well-resourced companies. But for anything beyond a static frontend they are genuinely hard, because a useful preview needs *real backing services*, not just a built bundle. Zerops has the right primitives for this and no tool that assembles them.

Separately, and more recently, AI coding agents have the same problem in a sharper form. They are handed sandboxes with mocked services, and then surprise everyone when real infrastructure behaves differently. Zerops's own position is that agents should develop against real managed services — but ZCP is deliberately scoped to **one agent, one project**, enforced at startup: a ZCP process refuses to run with a token scoped to more than a single project.

Ephemera is the layer above that: **many isolated environments, created and destroyed programmatically.**

---

## What it does

```
POST /api/environments  →  202, with the final URL, immediately
      ~100 seconds      →  status: ready
      GET <url>         →  a working app on its own PostgreSQL
DELETE /api/environments/:id  →  gone, billing stopped
```

- **Pull requests** — a webhook provisions on open, replaces on push, destroys on close, and comments the URL on the pull request.
- **Agents** — an MCP server exposes `create_environment`, `get_environment`, `list_environments`, `destroy_environment`.
- **Dashboard** — live view over server-sent events, with a per-second cost ticker and TTL countdown.
- **Reaper** — anything past its TTL is destroyed automatically. Protected hostnames can never be reaped.

---

## Architecture

```
GitHub ──webhook──┐
                  ├──► Ephemera control plane ──zcli──► Zerops (create / destroy)
Coding agent ─MCP─┘        (Node 22, Fastify)   └─REST─► Zerops (status, URLs)
                                  │
                                  ├── PostgreSQL   intent: what should exist
                                  └── SSE          live dashboard
```

Each environment is **two services** inside one long-lived Zerops project:

| service | type | purpose |
|---|---|---|
| `<slug>api` | a runtime, e.g. `nodejs@22` | the application, built from git |
| `<slug>db` | `postgresql:single@16` | that environment's private database |

### Decisions worth explaining

**Environments are services inside one project, not one project each.** Measured: creating a project costs a fixed ~2m10s of core activation that creating services does not. Same isolation for review purposes, less than half the wall clock.

**Every environment gets its own database.** Measured at **+7 seconds** versus sharing one — isolation is effectively free, so there is no reason not to. Two previews sharing a database is a subtly broken preview.

**Mutations go through `zcli`; reads go through the REST API.** Zerops documents no REST endpoint for Import YAML, so creation and deletion use the CLI. Status, service inventory and URLs come from `GET /project/{id}/service-stack`, which accepts the Personal Access Token directly as a bearer token.

**Readiness means the app answered, not that the platform said ACTIVE.** A container can be running while the process inside is still starting, or crash-looping against a database it cannot reach. `waitUntilServing` polls the public URL and treats only a non-502/503 response as ready.

**URLs are computed before the infrastructure exists.** Zerops subdomains follow `{hostname}-{projectCode}-{port}.{region}.zerops.app`, and the project code is fixed per project. So the pull-request comment carries a working link the moment the webhook fires, rather than after a poll completes.

**The reaper is the point.** Creating infrastructure is easy; reliably removing it is what makes handing out environments safe. It runs on an interval, honours TTLs, and refuses to touch `PROTECTED_HOSTNAMES`.

---

## Platform details this encodes

Each of these was found empirically, and each one silently breaks things:

1. **Hostnames**: max 25 characters, lowercase `a-z` and `0-9` only. No hyphens, no underscores, no uppercase.
2. **`envSecrets` does not override a repository's own `zerops.yml`.** Pointing an app at a per-environment database requires the `zeropsYaml` field — supplied as a **nested object**, not a string (a string fails with `cannot unmarshal !!str into zeropsYamlParser.check`). Two "isolated" environments quietly shared a database until this was found.
3. **A Zerops PostgreSQL service always exposes `dbName = db` and `user = db`.** Only the hostname varies. Setting these to the service hostname yields an app that builds, boots, and 502s.
4. **Passwords resolve as `${<hostname>_password}`** at deploy time, so no credential passes through this process.
5. **The `ZEROPS_` env prefix is reserved** and rejected on import. Ephemera's variables use `EPHEMERA_`.
6. **`enableSubdomainAccess` is a no-op when a service is created before it has code**, because no ports are known yet. Enable it after the first deploy.
7. **`@zerops/zcli` ships `bin/zcli.js`**, a Node launcher — not an executable binary. It is invoked through `process.execPath`.
8. **A trailing `.git` breaks `buildFromGit` silently.** GitHub's `clone_url` ends in `.git`, giving `…/repo.git@feature/x`. Zerops *accepts* this at import time, then the build never starts and the service sits in `READY_TO_DEPLOY` with no app version and no error. Strip the suffix and slashed branch names work fine.
9. **`zcli` can exit non-zero after a successful operation** (`last command has finished with error`). Both import and delete are therefore verified against project state rather than exit status — an early "destroyed" environment had in fact survived and was still billing.
10. **Environment variables can be written via `POST /service-stack/{id}/user-data`** with `{key, content}`. This endpoint is absent from the public API reference; `POST /user-data` returns 404.

---

## Running it

### Deploy the control plane

```bash
# 1. Create the services (one long-lived host project)
zcli project service-import infra/control-plane.yml -P <project-id>

# 2. Deploy the code
zcli service push ephemera -P <project-id> --setup ephemera

# 3. Expose it (after the first deploy - see note 6 above)
zcli service enable-subdomain ephemera -P <project-id>
```

### Configuration

| variable | required | purpose |
|---|---|---|
| `EPHEMERA_ZEROPS_TOKEN` | yes | Zerops Personal Access Token |
| `EPHEMERA_PROJECT_ID` | yes | project that hosts the environments |
| `EPHEMERA_PROJECT_CODE` | yes | 4-char code in public subdomains, e.g. `2c46` |
| `EPHEMERA_REGION` | no | defaults to `prg1` |
| `GITHUB_TOKEN` | no | enables pull-request comments |
| `GITHUB_WEBHOOK_SECRET` | no | if set, webhook signatures are verified |
| `DEFAULT_TTL_MINUTES` | no | defaults to `120` |
| `PROTECTED_HOSTNAMES` | no | services the reaper must never destroy |

### Create an environment

```bash
curl -X POST https://<control-plane>/api/environments \
  -H 'content-type: application/json' \
  -d '{"slug":"demo","repo":"https://github.com/<you>/<repo>","branch":"main"}'
```

### Per-repository configuration

Drop an `ephemera.json` in the repository root and Ephemera reads it from the branch under review:

```json
{
  "runtime": "nodejs@22",
  "port": 3000,
  "buildCommands": ["npm install --omit=dev"],
  "startCommand": "npm start",
  "ttlMinutes": 240
}
```

### Give an agent environments

```json
{
  "mcpServers": {
    "ephemera": {
      "command": "node",
      "args": ["/path/to/ephemera/dist/mcp/server.js"],
      "env": { "EPHEMERA_URL": "https://<control-plane>" }
    }
  }
}
```

> *"Spin up a disposable environment with Postgres, run the migration, tell me if it works, then destroy it."*

---

## Measured performance

Against a live Zerops project, 9 August 2026:

| operation | time |
|---|---|
| **pull request opened → preview serving traffic** | **84–104 s** |
| environment created via API → serving traffic | 90 s |
| three environments created in parallel | 103 s, 109 s, 118 s |
| environment destroyed | ~26 s |
| cost of one environment | **$0.0040 / hour** |
| cost of a complete preview cycle | **$0.00119** (reported by Ephemera on the pull request) |

Verified against a live pull request on
[KartikeyaNainkhwal/ephemera-demo#1](https://github.com/KartikeyaNainkhwal/ephemera-demo/pull/1):
opening it produced a running application on its own PostgreSQL database showing
that branch's changes, and closing it destroyed both and reported the cost.

---

## Project layout

```
src/
  config.ts              resolved configuration
  db.ts                  PostgreSQL pool and schema
  zerops/
    manifest.ts          environment spec → Zerops Import YAML
    cli.ts               zcli wrapper (all mutations)
    client.ts            REST reads + behavioural probe
  environments/
    service.ts           lifecycle orchestration
    store.ts             persistence
    reaper.ts            TTL enforcement
    cost.ts              cost model
  routes/
    api.ts               REST API
    github.ts            webhook + PR comments
    stream.ts            server-sent events
  mcp/server.ts          MCP server for coding agents
  web/dashboard.html     dashboard
```

---

## AI use

Built with Claude Code (Claude Opus 5) as the primary development tool, used for research, code generation, debugging and documentation.

Every platform behaviour documented above was verified empirically against a live Zerops project rather than accepted from documentation — several of them contradict, or are absent from, the published docs. The architecture decisions in this README are the substance of the work, and each one is backed by a measurement recorded during the build.

## Licence

MIT

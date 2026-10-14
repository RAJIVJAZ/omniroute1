# OmniRoute deployment

Self-hosted setup for [OmniRoute](https://github.com/diegosouzapw/OmniRoute), a unified
AI router that exposes one OpenAI-compatible endpoint in front of many LLM providers, with
automatic fallback, load balancing and a web dashboard.

Pinned version: **3.8.51** (Docker image tag and npm dependency).

## 1. Configure

```sh
./scripts/setup.sh
```

This copies `.env.example` to `.env`, generates `JWT_SECRET`, `API_KEY_SECRET`,
`STORAGE_ENCRYPTION_KEY` and a random `INITIAL_PASSWORD`, and prints the password.
`.env` is git-ignored. Back up `STORAGE_ENCRYPTION_KEY`, because without it the stored data
can't be read.

## 2. Run

### Docker (recommended)

```sh
docker compose up -d          # or: npm run docker:up
docker compose logs -f omniroute
```

Data persists in the `omniroute-data` volume. The port is bound to `127.0.0.1` by default.
Set `OMNIROUTE_BIND=0.0.0.0` in `.env` only behind a reverse proxy with HTTPS (then also set
`AUTH_COOKIE_SECURE=true` and `REQUIRE_API_KEY=true`).

For coding agents (Claude Code, Codex, etc.), raise the heap: `OMNIROUTE_MEMORY_MB=8192`, and
give the container ≥10 GB of memory.

### npm

Requires Node.js **22.22.2+** or **24+**.

```sh
npm install
npm start
```

Data is stored in `./data` (git-ignored).

## 3. Use

1. Open the dashboard at <http://localhost:20128> and log in with the initial password.
   Change it under Settings → Security.
2. Add provider connections (API keys or OAuth) and create an OmniRoute API key.
3. Point any OpenAI-compatible client at `http://localhost:20128/v1` with that key:

```sh
curl http://localhost:20128/v1/chat/completions \
  -H "Authorization: Bearer $OMNIROUTE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello"}]}'
```

## Upgrading

Change `OMNIROUTE_VERSION` in `.env` (Docker) or the `omniroute` version in `package.json`
(npm), then `docker compose pull && docker compose up -d` or `npm install && npm start`.

All environment variables are documented in the upstream `.env.example`
(`node_modules/omniroute/.env.example` after `npm install`).

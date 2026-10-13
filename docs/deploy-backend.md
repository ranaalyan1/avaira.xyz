# Hosting the AVAIRA backend (the other half of the full stack)

The Vercel deployment in [`deploy-vercel.md`](./deploy-vercel.md) ships the React
SPA. Every API-backed surface (`/dashboard`, `/agents`, `/executions`, `/freeze`,
`/treasury`, `/reputation`, `/underwriters`) then needs this FastAPI service
somewhere that can hold a MongoDB connection and long-lived processes.

**Why it cannot live on Vercel:** `backend/server.py` resolves
`MONGO_URL` through `_get_required_env()` at *import* time, so importing the ASGI
app without a database raises before any request is served. The service also runs
a lifespan that owns background engines (`IntentLogger`, `AvairaSentinel`,
`ReputationEngine`, …) and the dependency set (`grpcio`, `google-genai`, `boto3`,
`cryptography`, `eth-account`) is far past what a Vercel Python function should
bundle.

---

## 1. Provision MongoDB

Create a free MongoDB Atlas cluster (or use any MongoDB 7 instance) and note the
SRV connection string. The app uses a database named by `DB_NAME`
(`backend/.env.example` suggests `avaira_v2`).

## 2. Deploy the container

`backend/Dockerfile` (python:3.11-slim, `uvicorn server:app --host 0.0.0.0
--port 8001`) and `backend/Procfile` are already correct, so any container host
works.

### Railway (config already committed)

`backend/railway.json` sets the Dockerfile builder and healthchecks `/api/`:

1. New Project → **Deploy from GitHub repo** → `ranaalyan1/avaira.xyz`.
2. Service **Settings → Root Directory**: `backend` (so `railway.json` and the
   Dockerfile are picked up), or keep the repo root and set the Dockerfile path
   to `backend/Dockerfile` if your project deploys from the root.
3. Add the MongoDB plugin, or just paste an Atlas URL into `MONGO_URL`.
4. **Networking → Generate Domain** to get a public HTTPS hostname. TLS matters:
   the session cookie is issued `Secure` (see below), so `http://` will drop it.

### Any Docker host / VPS

```bash
docker compose up -d mongo opa backend      # from the repository root
# or, standalone:
docker build -t avaira-backend backend
docker run -p 8001:8001 --env-file backend/.env avaira-backend
```

Put TLS in front (Caddy/nginx/Traefik). `docker-compose.yml` also starts `opa`
(Rego policy engine), `ollama` (local SLM) and a daily anchor cron — the backend
degrades gracefully if the optional ones are absent.

### Fly.io / Render

Both accept the existing Dockerfile directly (`fly launch --dockerfile
backend/Dockerfile`, or a Render "Docker" web service). Use `/api/health` as the
healthcheck path.

## 3. Environment variables

Minimum to boot and serve the SPA:

| Variable | Value |
| :--- | :--- |
| `MONGO_URL` | your Atlas / plugin URL. **Required at import time.** |
| `DB_NAME` | `avaira_v2` |
| `PERMIT_SECRET` | 32+ random characters (`python backend/scripts/generate_secrets.py`) |
| `AVAIRA_ADMIN_KEY` | random admin key (" ") |
| `AVAIRA_LOG_SECRET` | random 32-byte secret (" ") |
| `COOKIE_SECURE` | `true` (HTTPS host) — this also flips the session cookie to `SameSite=None`, which is what makes cross-site frontend↔API calls carry the session |
| `CORS_ORIGINS` | `https://avaira.vercel.app` — comma-separated. **Never `*`**: the app disables credentialed CORS the moment a wildcard appears, and login silently stops working |
| `ALLOWED_REDIRECT_ORIGINS` | `https://avaira.vercel.app` (whitelist for the post-login `redirect` parameter) |
| `DEFAULT_POST_LOGIN_REDIRECT` | `https://avaira.vercel.app/dashboard` |

For real sign-in you also need one OAuth provider, with the callback pointing at
the **backend** host:

| Variable | Value |
| :--- | :--- |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google Cloud console → Credentials → Web application |
| `GOOGLE_REDIRECT_URI` | `https://<backend-host>/api/auth/google/callback` |
| `X_CLIENT_ID` / `X_CLIENT_SECRET` | X developer portal |
| `X_REDIRECT_URI` | `https://<backend-host>/api/auth/x/callback` |
| `ADMIN_EMAILS` | comma-separated admin allowlist |

Optional: `PROTOCOL_PRIVATE_KEY` + the six contract addresses (from
`deployments/fuji.json`) enable on-chain anchoring; Stripe keys enable financial
slashing; `CHAIN_ID=43113` keeps the API reporting Fuji.

## 4. Point the frontend at it

Two options. **Same-origin proxy is recommended** — no CORS, and the session
cookie becomes first-party.

### Option A — proxy `/api` through the Vercel project (recommended)

Add this rewrite to the `vercel.json` that applies to your Root Directory, at the
**top** of the array (rewrites are evaluated in order, before the SPA catch-all),
replacing the host with your backend:

```json
{
  "rewrites": [
    { "source": "/api/(.*)", "destination": "https://YOUR-BACKEND-HOST/api/$1" },
    { "source": "/(.*)", "destination": "/index.html" }
  ]
}
```

Leave `REACT_APP_BACKEND_URL` **unset**: `frontend/src/lib/api.js` then falls back
to `window.location.origin`, and OAuth callbacks live on the same domain
(`https://avaira.vercel.app/api/auth/google/callback`). Set
`ALLOWED_REDIRECT_ORIGINS` / `DEFAULT_POST_LOGIN_REDIRECT` to the Vercel domain.

### Option B — direct cross-origin calls

Set `REACT_APP_BACKEND_URL=https://<backend-host>` in the Vercel project
(Production **and** Preview — preview URLs are different origins, so either add
each one to `CORS_ORIGINS` or keep previews pointed at the same backend) and
rebuild. Requires `COOKIE_SECURE=true` on the backend plus `CORS_ORIGINS`
listing every frontend origin, or the browser drops the session cookie.

## 5. Smoke test

```bash
curl -s https://<backend-host>/api/health          # {"status":"ok","db":"ok",...}
curl -s https://<backend-host>/api/                # {"message":"AVAIRA Protocol API v1.0",...}
curl -sI https://avaira.vercel.app/                # 200 from Vercel
```

Then open `https://avaira.vercel.app/login` and complete a sign-in: a successful
flow lands on `/dashboard` with the session cookie present in DevTools →
Application → Cookies.

## Troubleshooting

| Symptom | Cause |
| :--- | :--- |
| Container crash-loops, log ends in `MONGO_URL` | `_get_required_env("MONGO_URL")` raised — the variable is missing or empty. |
| `503 {"detail":"Database unavailable"}` on every `/api/*` except `/api/` | The app booted but the Mongo ping in the database guard failed (wrong URL, IP allowlist, Atlas cluster paused). |
| Signed in, then immediately bounced back to `/login` | Cookie dropped: backend is on `http://` while `COOKIE_SECURE=true`, or `CORS_ORIGINS` contains `*` / is missing the frontend origin. |
| Login redirects to `localhost:3000` | `DEFAULT_POST_LOGIN_REDIRECT` / `ALLOWED_REDIRECT_ORIGINS` still have their localhost defaults. |
| OAuth error `redirect_uri_mismatch` | The provider's registered callback must match `GOOGLE_REDIRECT_URI` / `X_REDIRECT_URI` character for character (backend host, not frontend). |
| Contract pages show zeros | `AGENT_REGISTRY_ADDRESS` and friends are unset, or `CHAIN_ID` disagrees with those addresses. |

# Deploying AVAIRA to Vercel

Two supported paths. **Path A needs no secrets and is the fastest way to a live
URL; Path B keeps deploys inside GitHub Actions.**

The deployed artifact is the **Create React App SPA in `frontend/`** (build
output `frontend/build`). The FastAPI backend in `backend/` is *not* deployable
to Vercel: `backend/server.py` calls `_get_required_env("MONGO_URL")` at import
time and needs MongoDB plus OAuth credentials, so it belongs on a container host
(Railway / Fly / any Docker host — see `backend/railway.json` and
`docker-compose.yml`). Point the frontend at it with `REACT_APP_BACKEND_URL`.

---

## What is already wired up in this repo

| File | Purpose |
| :--- | :--- |
| `vercel.json` | Used when the Vercel project Root Directory is the **repository root**: installs and builds `frontend/`, serves `frontend/build`, rewrites unknown paths to `/index.html` (SPA deep links). |
| `frontend/vercel.json` | Used when the Vercel Root Directory is **`frontend`**: same build + SPA rewrites, Node 22. |
| `frontend/.npmrc` | `legacy-peer-deps=true`. **Required** — React 19 is installed alongside `react-day-picker@8` / parts of Radix / `react-scripts@5`, so a default `npm ci` aborts with `ERESOLVE` on a clean checkout (i.e. exactly the way Vercel installs). |
| `.github/workflows/deploy.yml` | Path B: backend tests → frontend build → `amondnet/vercel-action` production deploy. |

> Both `vercel.json` files set an explicit `installCommand` (`npm ci`), so the
> npm/yarn lockfile ambiguity (`frontend/` ships both `package-lock.json` and
> `yarn.lock`) cannot silently pick the wrong package manager.

---

## Path A — Import the project in the Vercel dashboard (recommended)

1. **Vercel → Add New → Project → Import** `ranaalyan1/avaira.xyz`.
2. Set **Root Directory** to `frontend`.
   *Leave it empty only if you prefer deploying from the repository root — the
   root `vercel.json` covers that case too.*
3. Framework preset: **Create React App** (auto-detected from `react-scripts`).
   Leave **Install Command**, **Build Command** and **Output Directory** on
   *Default* — project settings override `vercel.json`, and clearing them lets
   the committed config apply.
4. **Environment Variables** (Production + Preview), all build-time — change one
   and you must redeploy for it to take effect:

   | Variable | Example | Notes |
   | :--- | :--- | :--- |
   | `REACT_APP_BACKEND_URL` | `https://api.avaira.xyz` | Omit only if the API is served from the **same origin** as the site (`/api`). Without it the app calls `window.location.origin/api` and dashboard data calls 404. |
   | `REACT_APP_CHAIN_ID` | `43113` | Fuji testnet. Use `43114` for mainnet. |
   | `REACT_APP_EXPLORER_URL` | `https://testnet.snowtrace.io` | |
   | `REACT_APP_AGENT_REGISTRY_ADDRESS` | `0x4D35…b6B0` | See `deployments/fuji.json`. |
   | `REACT_APP_EXECUTION_WALLET_ADDRESS` | `0x1765…3Ed5` | " |
   | `REACT_APP_FREEZE_SLASH_ADDRESS` | `0x32Cc…85D5` | " |
   | `REACT_APP_TREASURY_ADDRESS` | `0x9B95…65b7` | " |
   | `REACT_APP_REPUTATION_ENGINE_ADDRESS` | `0x6B1e…0069` | " |
   | `REACT_APP_INSURANCE_POOL_ADDRESS` | `0xBF5B…2dF9` | " |

   The full variable list lives in `frontend/.env.example`.
5. **Deploy.** The production URL is `<project>.vercel.app`; add `avaira.xyz`
   under *Settings → Domains* when you are ready to cut over DNS.

Every push to `main` then deploys automatically (Vercel Git integration), and
every branch/PR gets a preview URL.

### Verified build command

```bash
cd frontend && npm ci && CI=false npm run build   # → frontend/build
```

`CI=false` matters: Vercel exports `CI=true`, and CRA promotes lint warnings to
build-breaking errors under that flag.

---

## Path B — Deploy from GitHub Actions

The workflow `.github/workflows/deploy.yml` runs on every push to `main`, and can
also be started by hand (**Actions → AVAIRA CI/CD → Run workflow**) thanks to
`workflow_dispatch`.

Add three repository secrets (**Settings → Secrets and variables → Actions**):

| Secret | Where to find it |
| :--- | :--- |
| `VERCEL_TOKEN` | Vercel → Account Settings → Tokens → *Create*. |
| `VERCEL_ORG_ID` | `cat .vercel/project.json` after `npx vercel link`, or the Team ID in Vercel project settings. |
| `VERCEL_PROJECT_ID` | Same file / same settings page (`prj_…`). |

Then trigger a deploy. On success the workflow publishes build artifacts and
reports the deployment status back to Vercel through
`vercel/repository-dispatch/actions/status`.

> Why this needed fixing: the workflow file contained unquoted `name:` values of
> the form `Vercel - avaira-v2: backend-tests`. A colon followed by a space is
> invalid inside a YAML plain scalar, so GitHub rejected the **entire file** and
> every push died after 0 seconds with *"workflow file issue"* — no job ever ran,
> which is why no Vercel deployment has been produced since March. The values are
> now quoted; the same strings are still used so the Vercel check names match.

---

## Troubleshooting

| Symptom | Cause / fix |
| :--- | :--- |
| `npm error ERESOLVE … Could not resolve dependency` during a Vercel build | `frontend/.npmrc` is missing or the dashboard has a custom install command. Keep `legacy-peer-deps=true` and reset the install command to Default. |
| `Treating warnings as errors because process.env.CI = true` | Build command must be `CI=false npm run build`. |
| 404 when opening `/dashboard` directly | The SPA rewrite is missing. Keep the `/(.*)` → `/index.html` rewrite in the `vercel.json` that applies to your Root Directory. |
| Deployments stopped entirely; Actions runs fail in 0s | Invalid workflow YAML. Run `python -c "import yaml;yaml.safe_load(open('.github/workflows/deploy.yml'))"` before pushing a workflow edit. |
| Site loads but every dashboard call fails | `REACT_APP_BACKEND_URL` is unset (falls back to same-origin `/api`) or points at a backend that is not running. |
| Env var change has no effect | `REACT_APP_*` values are inlined at build time — redeploy after changing them. |
| Two lockfiles disagree | `frontend/` ships both `package-lock.json` (used by this deploy) and `yarn.lock` (used by `ci.yml` and the Dockerfile), and they have drifted — running `npm ci` even rewrites `yarn.lock`. Deploys are pinned to `npm ci` so this is not blocking; regenerating `yarn.lock` (`yarn install`) or dropping one package manager removes the trap. |

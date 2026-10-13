# Deploying AVAIRA to Vercel

Two supported paths. **Path A needs no secrets and is the fastest way to a live
URL; Path B keeps deploys inside GitHub Actions.**

The deployed artifact is the **Create React App SPA in `frontend/`** (build
output `frontend/build`). The FastAPI backend in `backend/` is *not* deployable
to Vercel: `backend/server.py` calls `_get_required_env("MONGO_URL")` at import
time and needs MongoDB plus OAuth credentials, so it belongs on a container host
(Railway / Fly / any Docker host — see `backend/railway.json` and
`docker-compose.yml`). Point the frontend at it with `REACT_APP_BACKEND_URL`, or
proxy it same-origin — both recipes live in
[`deploy-backend.md`](./deploy-backend.md).

---

## Where things stand (verified 2026-10-13)

Measured, not assumed — so the next step is a decision rather than a diagnosis:

| Check | Result |
| :--- | :--- |
| `https://avaira.vercel.app/` | Vercel `404: NOT_FOUND`. No project named `avaira` is serving that name. |
| Vercel deployments on this repo | 27 total, **all created 2026-03-14/15**, all by `vercel[bot]`, belonging to project **`avaira-v2`** (team `ranaaliyan887-1407s-projects`). No deployment has been created since, although `main` has received many pushes — so the project's Git integration is no longer building this repository. |
| `deploy.yml` → *Deploy to Vercel (production)* | Runs and reports **success**, but its `Check for Vercel credentials` step finds `VERCEL_TOKEN` / `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID` unset and skips the deploy. That is the workflow behaving as designed, not a failure. |
| Frontend build (Node 22, this commit) | **Green**: `cd frontend && npm ci && CI=false npm run build` → `290.9 kB` JS + `22.4 kB` CSS gzipped, `frontend/build` 6.8 MB. Deep links (`/gate`, `/score`, `/evidence`, `/docs`) all return the SPA shell. |

In short: **the repository is deploy-ready; the Vercel side is not connected.** A
deploy needs one action in a Vercel account — either [Path A](#path-a--import-the-project-in-the-vercel-dashboard-recommended)
or [Path B](#path-b--deploy-from-github-actions) below.

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

0. **To answer on `https://avaira.vercel.app`, the Vercel project has to be named
   `avaira`** — the `*.vercel.app` subdomain follows the project name. Two ways,
   both in the Vercel dashboard:
   * **Rename the existing project** `avaira-v2` → *Settings → General → Project
     Name* → `avaira`, then **Redeploy**. The rename moves the
     `<name>.vercel.app` domain across with it, and the March deploys show this
     project already built this repository successfully. Use this if the project
     and its Git connection are still in the account.
   * **Import it fresh** as below, giving the new project the name `avaira`.
     Use this if `avaira-v2` was deleted.
   `avaira` is currently unanswered on `*.vercel.app`, so the name is available;
   if Vercel has to append a suffix, add `avaira.vercel.app` under
   *Settings → Domains* afterwards.
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

   > **Checked against the source (2026-10-13): `REACT_APP_BACKEND_URL` is the
   > only variable the SPA actually reads** (`frontend/src/lib/api.js` is the
   > single `process.env` read outside test files). The contract-address and
   > chain variables are listed in `frontend/.env.example` for completeness but
   > no component consumes them, so setting them changes nothing in the
   > deployed UI. Because the default is `window.location.origin` + `/api`, a
   > static Vercel deploy with no `REACT_APP_BACKEND_URL` renders every
   > marketing, gate, score, evidence and docs page fine and only the
   > authenticated dashboard data calls return 404 — which is the expected
   > state until the backend in `deploy-backend.md` is running.
5. **Deploy.** The production URL is `<project>.vercel.app`; add `avaira.xyz`
   under *Settings → Domains* when you are ready to cut over DNS.

6. **Prove it, then update the two honesty markers.** Run `make verify-deploy`
   (see below) and expect `✓ https://avaira.vercel.app is serving AVAIRA`. Only
   after that:
   * delete the "The site is **not live yet**" note under the deploy button in
     `README.md`, and
   * if you want the status badge, add it next to the other shields:
     `[![Live](https://img.shields.io/badge/Protocol_Control_Center-avaira.vercel.app-000000?style=for-the-badge&logo=vercel&logoColor=white)](https://avaira.vercel.app)`
   Both are deliberately left out of the repo while the URL 404s: a badge that
   links to a not-found page is an overclaim, and `tools/doctor.py` exists
   precisely to keep the docs from drifting away from reality.

Every push to `main` then deploys automatically (Vercel Git integration), and
every branch/PR gets a preview URL.

### One-click instead of steps 1–3

The README carries a **Deploy with Vercel** button that opens the import flow with
the repository and the project name `avaira` pre-filled:

```
https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Franaalyan1%2Favaira.xyz
  &project-name=avaira&repository-name=avaira&root-directory=frontend
```

Vercel still asks you to pick the account/team and confirm the build settings —
that is by design; the button cannot silently deploy someone else's code.

### Verify the deployment, don't assume it

A green Vercel build proves the bundle compiled, not that the URL serves it. The
repo ships the check for the live host:

```bash
make verify-deploy                                  # https://avaira.vercel.app
make verify-deploy URL=https://avaira-git-main.vercel.app   # any preview URL
python3 tools/verify_deploy.py --json verification/reports/deployed.json
```

It asserts that `/` returns HTML with the AVAIRA title, that the response is
**not** Vercel's `NOT_FOUND` page, that every deep link (`/gate`, `/score`,
`/evidence`, `/docs`) returns the same SPA shell bytes as `/` — the rewrite, not
just the homepage — that both bundles download at full size, and that
`robots.txt` / `sitemap.xml` are served. Exit code 1 on any failure, and each
verdict (`not-deployed`, `unreachable`, `error`, `broken`) prints its own cause
and fix instead of a generic stack trace. Run it from a machine with open egress:
a sandbox without internet reports `unreachable`, which says nothing about the
deployment.

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

**Without those secrets the workflow stays green instead of failing**: the deploy
step detects the missing credentials, prints a warning annotation pointing here,
and skips — the backend tests and the verified frontend build still run on every
push to `main`.

The check-status step posts names like `Vercel - avaira: backend-tests`. If your
Vercel project is named differently (the older project in this repo's history was
`avaira-v2`), set a repository variable **`VERCEL_CHECK_PREFIX`**
(*Settings → Secrets and variables → Actions → Variables*) to e.g.
`Vercel - avaira-v2` — no YAML edit required.

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

# Deploying

Push to `main` → GitHub Actions SSHes into the VPS → `git pull`, rebuild, migrate,
restart. Nothing is built on the runner, and no app secret ever enters Actions.

Push to `staging` does the same thing into a second stack on the same box —
see [Staging](#staging) below.

## The target box

`185.2.103.152` (`ssh visionlytics`), Ubuntu 24.04, root, 62 GB RAM, 273 GB free.

It already runs four other Next apps under **pm2 + nginx**, so ports 3000–3003
are taken (writerengine, visionlytics, helpora-landing, helpora-app). This app is
the only containerised one and takes **3004**.

nginx on the host terminates TLS for `app.banooridairy.pk` and proxies to
`127.0.0.1:3004`. The container publishes on loopback only, so it is unreachable
except through that vhost.

> `banooridairy.pk` itself is a separate WordPress/PHP site on this box. Don't
> touch that vhost — the dashboard gets its own.

| Container | What | Port |
|---|---|---|
| `farm-web` | the Next.js app (`output: "standalone"`) | `127.0.0.1:3004` |
| `migrate` | one-off task runner (prisma CLI) | —, `tools` profile |
| `farm-worker` | WhatsApp worker — **parked, not in use** | —, `worker` profile |
| `farm-stg-web` | staging, same app from `/opt/farm-stg` | `127.0.0.1:3006` |

3005 is the `seo-121ecommerce` node app, which is why staging is 3006.

Postgres is Supabase, not on the VPS.

## Where the keys go

Two places, and only two.

### 1. GitHub → Settings → Secrets and variables → Actions

Infrastructure only. No database URL, no service-role key.

| Secret | Value |
|---|---|
| `VPS_HOST` | `185.2.103.152` |
| `VPS_USER` | `root` |
| `VPS_SSH_KEY` | full contents of `~/.ssh/vps_github_actions` (the private one, including the `-----BEGIN/END-----` lines) |
| `APP_DIR` | `/opt/farm` |
| `APP_URL` | `https://app.banooridairy.pk` |
| `STG_APP_DIR` | `/opt/farm-stg` |
| `STG_APP_URL` | `https://stg.banooridairy.pk` |

Staging reuses `VPS_HOST`, `VPS_USER` and `VPS_SSH_KEY` — same box, same key.

That key already works: it is ED25519, has no passphrase, and its public half is
in the box's `/root/.ssh/authorized_keys` as `github-actions-vps`.

### 2. `/opt/farm/.env` on the VPS

Every app secret lives here and nowhere else — same keys as your local `.env`:

```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
DATABASE_URL
DIRECT_URL
NEXT_PUBLIC_APP_NAME
ADMIN_EMAIL
ADMIN_PASSWORD
ADMIN_NAME
```

`DATABASE_URL` and `DIRECT_URL` are **not** interchangeable. Runtime queries use
the transaction pooler (`:6543`); migrations and trigger DDL use the session
pooler (`:5432`), because pgbouncer in transaction mode cannot run DDL or
advisory locks.

Compose reads this one file for both the `NEXT_PUBLIC_*` build args and the
container runtime env.

## One-time: baseline the production database

Do this **before** the first deploy, or the deploy will fail.

The project used `prisma db push`, so production has every table but no
`_prisma_migrations` history. `prisma/migrations/0_init` was generated from
production's actual schema, so it describes tables that already exist — applying
it would fail on "relation already exists". Mark it applied instead, from your
machine, with `DIRECT_URL` pointing at production:

```bash
npx prisma migrate resolve --applied 0_init
npx prisma migrate status   # expect: "Database schema is up to date!"
```

After this: `npx prisma migrate dev --name <what>` locally, commit the generated
folder, and the deploy applies it. Never run `prisma db push` at production
again — no history, and it can drop columns without warning.

> `prisma migrate diff` reports a permanent phantom difference on
> `CustomerProduct.alternatePattern`. Postgres stores that default as
> `(ARRAY[]::numeric[])::numeric(65,30)[]` and Prisma 5 cannot round-trip its own
> rendering. The default *is* applied. Ignore it.

## One-time: VPS setup

Docker is **not** installed on this box yet.

```bash
ssh visionlytics

# 1. Docker + compose plugin
curl -fsSL https://get.docker.com | sh
docker compose version

# 2. Code (repo is private — add a deploy key, or use a PAT in the remote URL)
mkdir -p /opt/farm
git clone https://github.com/Kbaliza/Farm-new.git /opt/farm
cd /opt/farm

# 3. Secrets — from your machine:
#    scp .env visionlytics:/opt/farm/.env
chmod 600 /opt/farm/.env

# 4. Build and start
docker compose build web
docker compose run --rm migrate npx prisma migrate deploy
docker compose run --rm migrate npx tsx scripts/apply-returns-sync-trigger.ts
docker compose up -d

# 5. Bootstrap the admin user and storage buckets
docker compose run --rm migrate npx tsx scripts/create-admin.ts
docker compose run --rm migrate npx tsx scripts/ensure-customer-buckets.ts
```

### nginx + TLS

Point `app.banooridairy.pk` at `185.2.103.152` in DNS first, then:

```bash
cp /opt/farm/deploy/nginx/app.banooridairy.pk.conf /etc/nginx/sites-available/app.banooridairy.pk
ln -s /etc/nginx/sites-available/app.banooridairy.pk /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d app.banooridairy.pk
```

Certbot rewrites that file to add the TLS block and the `:80 → :443` redirect,
exactly as it did for `app.helpora.ai`.

### SQL outside the migration chain

`prisma migrate deploy` only manages tables and columns. Everything else lives in
`supabase/`:

- **`supabase/prod-objects.sql`** — the real source of truth. 17 functions,
  4 triggers, 46 RLS policies, and the `pg_net` extension. Extracted from the
  live database on 2026-08-09, where it had accumulated with no source file
  behind it. Supersedes `rls.sql`.
- `supabase/storage-policies.sql` — storage bucket policies
- `supabase/rls.sql` — superseded; kept for history. It covered only the 23
  customer-app policies, not the 23 rider-app ones.
- `supabase/returns-sync-trigger.sql` — re-applied automatically every deploy.

If you change a policy or function in the Supabase SQL editor, mirror it into
`prod-objects.sql`. That drift is exactly what nearly broke the region migration.

Still outside version control: the **`send-push` Edge Function** that
`trg_push_notification` calls, and the vault secrets `firebase_sa` and
`service_key`. Pull the function with `supabase functions download send-push` and
commit it.

### The database moved to `eu-central-1` on 2026-08-09

It used to live in Tokyo while the app runs on Contabo in Lauterbourg, France.
Every query paid for the distance: `/api/health`, which is a single `SELECT 1`,
took **1,296 ms**, while a page touching no database rendered in 13 ms.

After moving to Frankfurt, ~300 km from the VPS:

| | Tokyo | Frankfurt |
|---|---|---|
| TCP round-trip from the VPS | 269 ms | **31 ms** |
| `/api/health` (one query) | 1,296 ms | **51 ms** |

The old project still exists and is untouched — nothing was ever written to it
during the migration. Keep it until you're confident, then archive it. The last
Tokyo config is saved on the VPS at `/opt/farm/.env.tokyo-backup`.

What the move actually required, beyond copying rows — worth knowing if it ever
happens again:

1. `prisma migrate deploy` against the empty project. The chain is baselined, so
   it builds all 66 tables; no `migrate resolve` on a fresh database.
2. `pg_dump --data-only` from the old project, loaded with
   `session_replication_role = replica` so foreign keys don't fight the load order.
3. `auth.users` + `auth.identities` copied with UUIDs intact — otherwise every
   `supabaseId` in the app dangles. Password hashes carry over; sessions do not,
   because they're signed with the old project's JWT secret.
4. Storage buckets recreated with matching public/private flags, objects copied.
5. **`supabase/prod-objects.sql`** — the 17 functions, 4 triggers and 46 policies
   that lived only in the old database. Row counts looked perfect without them.
6. Vault secrets: `firebase_sa` copied verbatim, `service_key` re-set to the new
   project's service role key.
7. `trg_push_notification` hardcodes the project's edge-function URL — rewritten
   to the new ref.

Still outstanding: the `send-push` Edge Function has not been moved. It exists
only on the old project, so **customer push notifications are not working**.
Fixing it needs a Supabase account with access to both projects:

```bash
supabase login
supabase functions download send-push --project-ref osnydstoahytkdcyybkt
supabase functions deploy send-push --project-ref alrahkhcxfulircvsocw
```

Commit the downloaded source under `supabase/functions/` so it stops being a
single point of loss.

## Deploying

Push to `main`. To redeploy without a code change (e.g. after editing `.env` on
the VPS), run the **Deploy to VPS** workflow from the Actions tab.

Over SSH, in order: `git fetch` → `git checkout -f -B <branch> <sha>` →
`docker compose build web migrate` → `prisma migrate deploy` → re-apply the
returns-sync trigger → `up -d` → `image prune` → **assert the running container
was built from that commit** → poll `${APP_URL}/api/health` for up to 2 minutes,
failing the run if it never comes back.

### Why the checkout is pinned to a SHA

It used to be `git pull origin <branch>`, and that is how staging served stale
code through five consecutive green deploys on 5–6 Sep 2026. A pull only
fast-forwards whatever branch is checked out: on a detached HEAD, or a branch
not tracking `origin`, it prints "Already up to date" and **exits 0**. The build
context is then byte-identical, every Docker layer is a cache hit, `up -d` finds
no new image, and the run goes green having shipped the previous build.

`git checkout -f -B "$BRANCH" "$SHA"` cannot no-op, and it repairs a box left on
the wrong branch or a detached HEAD. `-f` discards local edits to *tracked* files;
untracked files are left alone, so the `.env` sitting next to the compose file
survives. **Never add `git clean` here** — that would delete it.

### Asking the box what it is running

The deploy passes the commit in as a build arg; the Dockerfile's runner stage
bakes it into the image as `GIT_SHA`, and the workflow reads it back out of the
container that is actually serving and fails the run if it does not match. To
check by hand:

```bash
# production
cd /opt/farm && docker compose exec -T web printenv GIT_SHA
# staging
cd /opt/farm-stg && docker compose exec -T web printenv GIT_SHA
```

An older image predating this change prints nothing — that itself means the
container has not been rebuilt since 6 Sep 2026.

Migrations run *before* the new container starts, so new code never sees an old
schema. A concurrency group serialises deploys so two pushes can't race on the
same checkout or migration lock.

`/api/health` does a real `SELECT 1`, so a pass means "can actually serve", not
just "process is up". It is public by design (`proxy.ts` excludes `/api/`) and
returns nothing but `{ok}`.

## Staging

`https://stg.banooridairy.pk` — same box, same repo, second stack. Push to the
`staging` branch and **Deploy to VPS (staging)** does `git pull origin staging` →
build → migrate → `up -d` → poll `/api/health`, exactly like production.

| | production | staging |
|---|---|---|
| branch | `main` | `staging` |
| directory | `/opt/farm` | `/opt/farm-stg` |
| port | `127.0.0.1:3004` | `127.0.0.1:3006` |
| container | `farm-web` | `farm-stg-web` |
| image | `farm-web:latest` | `farm-stg-web:latest` |
| compose project | `farm` | `farm-stg` |
| workflow | `deploy.yml` | `deploy-staging.yml` |
| vhost | `app.banooridairy.pk` | `stg.banooridairy.pk` |

`docker-compose.staging.yml` is an overlay, never used alone:

```bash
docker compose -f docker-compose.yml -f docker-compose.staging.yml ps
```

`/opt/farm-stg/.env` sets `COMPOSE_FILE` to that pair, so a bare `docker compose`
run from inside that directory already picks the overlay up. The `ports` entry
uses `!override` because compose *appends* sequences when merging files — without
it staging would inherit 3004 too and fight production for the bind.

The two stacks share nothing at the Docker level: different project name means
different network and a separate `wa_auth` volume.

### Staging shares the production database

`/opt/farm-stg/.env` is a copy of `/opt/farm/.env`. Same Supabase project, same
`DATABASE_URL`. Three consequences, all deliberate:

- Anything you type into staging is **production data**. There is no sandbox.
- A migration that lands on `staging` is applied to the **production database**
  by the staging deploy, before `main` ever sees it. Order your merges
  accordingly, or expect production to run against a schema ahead of its code.
- The staging vhost sends `X-Robots-Tag: noindex, nofollow`, because otherwise
  two hosts serve identical content and the duplicate can outrank the real one.

To decouple later: create a second Supabase project, point `/opt/farm-stg/.env`
at it, then `docker compose ... run --rm migrate npx prisma migrate deploy` to
build the schema from scratch (the chain is baselined, so no `migrate resolve`
on an empty database), followed by `scripts/create-admin.ts` and
`scripts/ensure-customer-buckets.ts`. Nothing in the workflow changes.

### One-time: staging setup on the VPS

```bash
ssh visionlytics

git clone git@github-farm:Kbaliza/Farm-new.git /opt/farm-stg
cd /opt/farm-stg
git checkout staging

cp /opt/farm/.env /opt/farm-stg/.env
chmod 600 /opt/farm-stg/.env
# and append, so bare `docker compose` in this directory uses the overlay:
#   COMPOSE_FILE=docker-compose.yml:docker-compose.staging.yml

docker compose -f docker-compose.yml -f docker-compose.staging.yml build web
docker compose -f docker-compose.yml -f docker-compose.staging.yml up -d
```

No `prisma migrate deploy` on first bring-up — the database is production's and
is already migrated.

nginx and TLS, after `stg.banooridairy.pk` resolves to `185.2.103.152`:

```bash
cp /opt/farm-stg/deploy/nginx/stg.banooridairy.pk.conf /etc/nginx/sites-available/stg.banooridairy.pk
ln -s /etc/nginx/sites-available/stg.banooridairy.pk /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d stg.banooridairy.pk
```

## Rollback

```bash
cd /opt/farm
git log --oneline -10
git reset --hard <good-sha>
docker compose build web && docker compose up -d
```

Schema changes are not auto-reverted — `prisma migrate deploy` has no down
migration. Undoing one means writing a forward migration.

## The WhatsApp worker (parked)

Not in use yet, so it neither builds nor starts during a deploy. To bring it up:

```bash
docker compose --profile worker up -d --build worker
docker compose logs -f worker      # QR appears here and on the Connect tab
```

It needs its own image because the web image is a stripped standalone build with
no `tsx`, no Chromium and no `whatsapp-web.js` in it. Run exactly one instance —
`whatsapp-web.js` takes a `LocalAuth` lock on its session directory. That session
lives in the `wa_auth` volume, which is what saves you from re-scanning the QR on
every redeploy, so don't run `docker system prune --volumes` on this host.

## Known gaps

- **No test gate.** The integration suite reads `DATABASE_URL` from `.env` and,
  as written, only passes against a database that already has funded payment
  heads — 7 tests in `expenses`, `vendors` and `otc` fail on a freshly migrated
  database because the overdraft guard rejects outflows from a zero-balance
  `CASH` head. Adding CI means fixing those fixtures first.
- **Build happens on the VPS.** Fine here — 62 GB RAM.
- **No zero-downtime.** `up -d` restarts `web` in place; expect a few seconds of
  502 through nginx.

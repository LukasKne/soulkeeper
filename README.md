# Soulkeeper

A small Dark Souls Remastered no-death competition tracker. Public leaderboards show each competition's players, their points, and whether their character is alive or dead. Each assigned player has one attempt per competition.

Lukas can manage players and competitions from **Administration** at `/admin`. Create accounts, reset passwords, and deactivate players while preserving their results. Usernames are permanent; there is no public registration.

Every signed-in player can use **Change password** beside their account name. Enter the current password and confirm a new password of at least 12 characters. A successful change signs out that player's sessions; log in again with the new password. Scores and competition history are preserved.

Create the next competition with a name and a selected group of active players. There is one current competition at a time. The previous competition stays visible in the selector, with its participants, leaderboard, and checklists preserved as read-only records. Each competition has a permanent URL. Participants can be added to the current competition; a player who has started an attempt cannot be removed.

## Run with Docker

```sh
cp .env.example .env
```

Set two different initial passwords in `.env`, then start:

```sh
docker compose up -d --build
```

Open <http://localhost:8085>. The first setup creates `lukas` (administrator) and `oli`, both assigned to Competition 1. Sign in as Lukas to create more accounts. Keep `.env` private.

Progress is stored in the `soulkeeper-data` named volume. Rebuilding or recreating the container preserves it. `docker compose down -v` deletes that volume and all competitions.

## Host behind HTTPS

Set these `.env` values for your deployment:

| Variable | Value |
| --- | --- |
| `LUKAS_PASSWORD`, `OLI_PASSWORD` | Two different private passwords for the initial accounts on first setup |
| `APP_ORIGIN` | The exact public HTTPS origin, without a trailing path |
| `COOKIE_SECURE` | `true` |
| `BIND_ADDRESS` | Server LAN IP when the reverse proxy is on another machine; otherwise `127.0.0.1` |
| `PORT` | Available host port, default `8085` |
| `SOULKEEPER_IMAGE` | Published image reference, or `soulkeeper:local` for local builds |

Forward your HTTPS reverse proxy to the configured host port. The container serves both the frontend and API on port 8000. Use a persistent named volume or a writable data directory owned by container UID/GID `10001:10001`.

Players manage their own passwords through **Change password**. Lukas can also reset passwords in **Administration**. Changing or resetting a password, or deactivating an account, invalidates that player's sessions while preserving competitions and scores. The environment passwords only initialize a new database; changing them does not overwrite existing accounts or undo password changes.

Existing installations migrate automatically, keeping Lukas and Oli's passwords and competition history. Both remain assigned to every pre-migration competition. Back up your database before upgrading.

## Published images

The GitHub workflow tests pull requests and publishes images to `ghcr.io/<owner>/<repository>` after successful builds on `main`, version tags, and manual dispatch. It builds AMD64 and ARM64 images. Tags include `sha-<full-commit>`, version tags, and `latest` for `main`.

After the first publication, [set the GHCR package visibility to public](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry) to allow unauthenticated pulls. Set `SOULKEEPER_IMAGE` in `.env`, preferably to an immutable SHA tag:

```sh
docker compose pull
docker compose up -d --no-build
```

## Scoring

The vanilla catalog includes DLC: **26 boss encounters × 5 points + 60 nonrespawning miniboss encounters × 3 points = 310 points**. Each fixed encounter has its own checkbox. Bell Gargoyles, Ornstein and Smough, and Four Kings each count as one boss fight. Only the final Seath fight counts.

Havel and Ricard are included. Invaders, other NPC fights, respawning variants, ordinary enemies, and loot creatures are excluded. This is the app's defined scoring catalog, not an official game ruleset. See [catalog sources](backend/catalog_sources.md) for locations and eligibility details.

A competition snapshots its catalog when it is created, so later catalog changes cannot rewrite earlier scores. Death and completion lock an attempt; only creating another competition gives players new attempts.

## Development and checks

Use Node 24+ and Python 3.13+.

```sh
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements-dev.txt
.venv/bin/python -m pytest backend/tests -q
```

In `frontend/`:

```sh
npm ci
npm test -- --run
npm run build
```

For development, export `LUKAS_PASSWORD`, `OLI_PASSWORD`, and `APP_ORIGIN=http://localhost:5173` in your shell. Start `.venv/bin/uvicorn backend.app:app --reload` from the repository root, and `npm run dev` from `frontend/`. Vite proxies API requests to port 8000.

The disposable container smoke test checks the built frontend, login, user management, participant isolation, scoring, archives, and persistence after container recreation:

```sh
docker build -t soulkeeper:local .
bash scripts/container-smoke.sh soulkeeper:local
```

It uses an isolated temporary volume and host port 18085. It never targets your deployed database.

## Back up data

Create a consistent SQLite backup while the app is running, then copy it off the container:

```sh
docker compose exec -T soulkeeper python -c "import sqlite3; source=sqlite3.connect('/data/soulkeeper.db'); target=sqlite3.connect('/data/backup.db'); source.backup(target); target.close(); source.close()"
docker compose cp soulkeeper:/data/backup.db ./backup.db
```

Keep backups outside the data volume. For restore, stop the app, replace the database in the volume, remove any stale `soulkeeper.db-wal`/`soulkeeper.db-shm` files, preserve ownership, and start the app again.

## License

MIT. Original app code and styling; no game artwork is distributed.

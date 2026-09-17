# Running with Docker

The repo ships a multi-stage `Dockerfile` (Next.js standalone output,
runs as a non-root user) and a `docker-compose.yml` with a single
`app` service. Supabase is external — point the app at your hosted
(or self-hosted) Supabase project via env vars; no database container
is included.

## Quick start

1. Copy the env template and fill it in:

   ```bash
   cp .env.local.example .env.local
   ```

2. Build and start (the `--env-file` flag is required — Compose only
   reads `.env` by default for `${VAR}` substitution, and this project
   keeps its config in `.env.local`):

   ```bash
   docker compose --env-file .env.local up --build -d
   ```

3. The app is served on [http://localhost:3000](http://localhost:3000)
   (publish it elsewhere with `HOST_PORT=8080` in `.env.local`).

> Use `HOST_PORT`, not `PORT`, to move the published port. `PORT` is
> what the server listens on _inside_ the container, and `env_file`
> would inject it there — leaving the app on a port the mapping and
> the healthcheck don't target. Compose pins it to 3000 for that
> reason.

## Build-time vs runtime variables

- `NEXT_PUBLIC_*` variables are **inlined into the client bundle at
  build time**. They are passed as Docker build args by
  `docker-compose.yml`. If you change any of them, rebuild:
  `docker compose --env-file .env.local up --build -d`. This includes
  `NEXT_PUBLIC_APP_LOCALE` (`en | ko | pt | es`), so the UI language is
  fixed per image.
- Everything else (`SUPABASE_SERVICE_ROLE_KEY`, `ENCRYPTION_KEY`,
  `META_APP_SECRET`, …) is read at **runtime** from `.env.local` via
  `env_file` and is never baked into the image — safe to change with
  just a container restart.

## Plain Docker (no Compose)

```bash
docker build \
  --build-arg NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key \
  -t wacrm .

docker run -d --env-file .env.local -e PORT=3000 -p 3000:3000 wacrm
```

## Notes

- Database migrations under `supabase/` are **not** run by the
  container — apply them with the Supabase CLI as described in the
  README.
- Received attachments are copied into the `chat-media` Supabase
  Storage bucket, because Meta deletes media roughly 30 days after it
  arrives and the copy is the only thing that outlives that. It grows
  with inbound volume, so it's worth watching your project's storage
  quota. Turn it off per account under Settings → WhatsApp →
  Attachment Storage; attachments received while it's off become
  unviewable once Meta drops them. Files over 16 MB (the bucket's
  limit) are never copied.
- Nothing inside the container is scheduled. Point an external
  scheduler at the cron endpoints below, sending the shared secret in
  the `x-cron-secret` header (`AUTOMATION_CRON_SECRET`, see
  `.env.local.example`). All of them return 503 until that variable is
  set, and 401 without a matching header.

  | Endpoint | Needed when | Suggested interval |
  | --- | --- | --- |
  | `GET /api/whatsapp/connections/cron` | **Always, on any Evolution (QR code) deployment.** | 5 min |
  | `GET /api/automations/cron` | Automations use Wait steps | 1-5 min |
  | `GET /api/flows/cron` | Flows are in use | 1-5 min |
  | `GET /api/broadcasts/cron` | Broadcasts are scheduled or resumed | 1-5 min |

  The connections cron is the one worth going out of your way for. A
  WhatsApp session can die without Evolution ever emitting a
  `CONNECTION_UPDATE`, and it can also go "zombie" — the socket keeps
  reporting itself open while WhatsApp quietly stops routing anything
  through it. Neither shows up in the UI on its own. With nothing on a
  schedule, a connection sits at "connected" indefinitely while the
  inbox receives nothing: observed in production as 19 days of silence
  with a green status. This job is what notices, and what restarts a
  zombie session automatically. It also re-registers the instance's
  webhook if it has drifted from `NEXT_PUBLIC_SITE_URL`, which is the
  other way inbound goes quiet with everything else looking healthy.

  A host crontab entry is enough:

  ```cron
  */5 * * * * curl -fsS -H "x-cron-secret: YOUR_SECRET" https://crm.example.com/api/whatsapp/connections/cron >/dev/null
  ```

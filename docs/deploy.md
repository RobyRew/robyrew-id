# Deploying id.robyrew.com

Same shape as the other Node apps on vps01: GitHub Actions builds the image
(`RobyRew/platform` reusable workflow) and pushes
`ghcr.io/robyrew/robyrew-id`; Dokploy pulls it.

1. **Logto first**: steps 1, 2 and 7 of [logto-checklist.md](logto-checklist.md)
   (M2M app, the Traditional Web app, the webhook — the webhook after the app
   answers on its URL).
2. **DNS before the Dokploy domain**: A `id.robyrew.com` → 94.143.138.233 and
   AAAA → 2001:ba0:20d:3c00::1 (IONOS DNS API), then `domain.create` (port
   4321, https, Let's Encrypt). A domain created before the name resolves
   keeps Traefik's default certificate.
3. **Dokploy application** from the GHCR image, memory limit as a byte string
   (`"201326592"`, 192 MiB), env from `.env.example`. Measured on 2026-11-17
   with the production build on macOS: ~106 MB RSS idle, 128 MB peak while
   re-encoding a 12-megapixel 8.2 MB JPEG (sharp runs one libvips thread with
   its cache off, one conversion at a time); an 18 MB upload is refused with
   413 before decoding.
4. **Named volume** `robyrew-id-data` on `/app/data` (Dokploy `mounts.create`,
   type volume). Without it every redeploy starts with an empty database and
   every avatar URL in Logto points at a missing file.
5. **Backups and checks** (infrastructure repo): add `robyrew-id-data` to
   `backup_docker_volumes`, the app to `report_expected_app_mounts`, and
   `https://id.robyrew.com/api/health` to `dokploy_site_probe_sites`. The image
   has no Docker healthcheck on purpose (exec probes leaked memory on vps01).
6. Put the deploy webhook in the repo secret `DOKPLOY_DEPLOY_WEBHOOK`; every
   push to `main` then builds the image and asks Dokploy to pull it.

After a deploy, check the running image digest (`docker service inspect` /
`docker image inspect … RepoDigests`) rather than the Dokploy status: a task
that fails to start is rolled back while the deployment still reads "done".

## As deployed (2026-11-19)

- Logto: Traditional Web app `RobyRew ID` (`2z9dm3wv1lk0yt2iettbi`), the M2M app
  `RobyRew ID (management)` with its own secret "robyrew-id production", and the
  webhook `RobyRew ID` (`8zc9awmo4iquzyel86ac9`, the four user events).
- Dokploy: application `Uw6NS2BdY0ZPzuA6aZiJA` (service `robyrew-id-dotdpw`) in
  the Tools project, image `ghcr.io/robyrew/robyrew-id:latest`, memory limit
  `"201326592"`, named volume `robyrew-id-data` on `/app/data`, domain
  `id.robyrew.com` → 4321 with Let's Encrypt.


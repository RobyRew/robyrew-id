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
6. Put the deploy webhook in the repo secret `DOKPLOY_DEPLOY_WEBHOOK` and push.

After a deploy, check the running image digest (`docker service inspect` /
`docker image inspect … RepoDigests`) rather than the Dokploy status: a task
that fails to start is rolled back while the deployment still reads "done".

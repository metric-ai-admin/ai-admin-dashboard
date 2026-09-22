# AppFolio Forms Agent — its own Render service, separate from the dashboard.
#
# WHY A SEPARATE SERVICE, not a job inside the dashboard:
#   - Chromium needs 300-700MB for a real page; the dashboard runs on a 512MB
#     starter plan. An OOM here would restart the dashboard for the whole team.
#   - Render disks cannot be shared: "You can't access a service's disk from any
#     other service" (render.com/docs/disks). The dashboard already owns
#     dashboard-data at /var/data, so the browser profile needs its own disk.
#   - That same page: "You can't scale a service to multiple instances if it has
#     a disk attached." Attaching a disk pins this service to ONE instance, which
#     is exactly what we want — an in-process cron cannot double-fire and
#     countersign the same form twice.
#
# The base image ships Chromium plus every system library Playwright needs.
# Render's native `env: node` runtime cannot install those (no root apt), which
# is why this service is Docker while the dashboard stays on the node runtime.
#
# The image tag and the playwright npm version MUST match exactly — the image
# bundles the browser build for that release and a mismatch fails at launch.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

ENV NODE_ENV=production \
    # Browsers are already in the image; stop npm from downloading them again.
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    # Render runs UTC. Everything user-facing is rendered in Central explicitly,
    # but keeping the container on UTC matches the dashboard's assumptions.
    TZ=UTC

WORKDIR /app

# Dependencies first so a code change does not re-install on every deploy.
COPY agent/package.json agent/package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY agent/ ./

# Non-root. The base image ships a `pwuser`; the disk is chowned at runtime by
# the entrypoint because Render mounts it after the image is built.
USER root
RUN mkdir -p /var/data && chown -R pwuser:pwuser /app /var/data
USER pwuser

EXPOSE 10000

CMD ["node", "index.js"]

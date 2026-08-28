# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03

FROM ${NODE_IMAGE} AS pnpm-base

ARG PNPM_VERSION=11.1.3
ENV CI=true

RUN npm install --global "pnpm@${PNPM_VERSION}" \
  && test "$(pnpm --version)" = "${PNPM_VERSION}"

WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY packages/application/package.json packages/application/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/image-storage/package.json packages/image-storage/package.json
COPY services/core-api/package.json services/core-api/package.json
COPY services/mcp-server/package.json services/mcp-server/package.json

FROM pnpm-base AS build

RUN pnpm --filter @beautio/web... --filter @beautio/core-api... install --frozen-lockfile

COPY tsconfig.base.json tsconfig.scripts.json ./
COPY apps/web apps/web
COPY packages packages
COPY services/core-api services/core-api

RUN pnpm --filter @beautio/web build

FROM pnpm-base AS production-dependencies

RUN pnpm --filter @beautio/core-api... install --frozen-lockfile --prod

FROM ${NODE_IMAGE} AS runtime

ENV NODE_ENV=production \
  BEAUTIO_API_HOST=0.0.0.0 \
  BEAUTIO_API_PORT=8787 \
  BEAUTIO_DB_PATH=/var/lib/beautio/beautio.sqlite \
  BEAUTIO_IMAGE_STORAGE_ROOT=/var/lib/beautio/images \
  BEAUTIO_WEB_ROOT=/app/apps/web/dist

WORKDIR /app

COPY --from=production-dependencies /workspace/node_modules node_modules
COPY --from=production-dependencies /workspace/package.json package.json
COPY --from=production-dependencies /workspace/packages/application packages/application
COPY --from=production-dependencies /workspace/packages/contracts packages/contracts
COPY --from=production-dependencies /workspace/packages/database packages/database
COPY --from=production-dependencies /workspace/packages/domain packages/domain
COPY --from=production-dependencies /workspace/packages/image-storage packages/image-storage
COPY --from=production-dependencies /workspace/services/core-api services/core-api

COPY --from=build /workspace/apps/web/dist apps/web/dist
COPY --from=build /workspace/packages/application/src packages/application/src
COPY --from=build /workspace/packages/contracts/src packages/contracts/src
COPY --from=build /workspace/packages/database/src packages/database/src
COPY --from=build /workspace/packages/domain/src packages/domain/src
COPY --from=build /workspace/packages/image-storage/src packages/image-storage/src
COPY --from=build /workspace/services/core-api/src services/core-api/src

RUN chmod -R a+rX /app \
  && install -d -o node -g node /var/lib/beautio /var/lib/beautio/images

USER node

RUN test -r /app/services/core-api/src/http.ts \
  && test -r /app/packages/image-storage/src/index.ts \
  && node --input-type=module -e "await import('file:///app/packages/image-storage/src/index.ts')"

EXPOSE 8787
VOLUME ["/var/lib/beautio"]
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.BEAUTIO_API_PORT || '8787') + '/api/health').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]

CMD ["node", "--enable-source-maps", "services/core-api/src/http.ts"]

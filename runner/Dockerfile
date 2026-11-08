# Reproducible runner image. Build from the repo root:
#   docker build -f runner/Dockerfile -t srs-runner .
# For a reproducible image pin the digest: node:22-bookworm-slim@sha256:<digest from `docker buildx imagetools inspect`>
FROM node:22-bookworm-slim
WORKDIR /app
COPY runner/package.json package.json
RUN npm install --omit=dev --no-audit --no-fund --legacy-peer-deps
COPY core/src core/src
COPY runner/src runner/src
COPY runner/docker-compose.yml runner/docker-compose.yml
COPY standard/parts.json standard/parts.json
ENV NODE_ENV=production RUNNER_PORT=8787 RUNNER_HOST=0.0.0.0
EXPOSE 8787
# listen on all interfaces inside the CVM
CMD ["node", "--import", "tsx", "runner/src/main.ts"]

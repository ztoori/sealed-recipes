# Reproducible runner image. Build from the repo root:
#   docker build -f runner/Dockerfile -t srs-runner .
# For a reproducible image pin the digest: node:22-bookworm-slim@sha256:<digest from `docker buildx imagetools inspect`>
FROM node:22-bookworm-slim
WORKDIR /app
COPY runner/package.json package.json
RUN npm install --omit=dev --no-audit --no-fund --legacy-peer-deps
# @phala/dstack-sdk needs @noble/hashes and @noble/curves 1.x (required peers; it imports '@noble/hashes/sha512'),
# while the runner uses 2.x. Give the SDK its own 1.x copies in its own node_modules, then fail the build if it can't load.
RUN mkdir /tmp/noble1 && cd /tmp/noble1 && npm init -y >/dev/null \
 && npm install --no-audit --no-fund @noble/hashes@^1.6.1 @noble/curves@^1.8.1 \
 && mkdir -p /app/node_modules/@phala/dstack-sdk/node_modules \
 && cp -r node_modules/@noble /app/node_modules/@phala/dstack-sdk/node_modules/ \
 && cd /app && rm -rf /tmp/noble1 \
 && node --input-type=module -e "await import('@phala/dstack-sdk'); await import('@noble/hashes/sha2.js'); console.log('dstack-sdk and runner hashes load')"
COPY core/src core/src
COPY runner/src runner/src
COPY runner/docker-compose.yml runner/docker-compose.yml
COPY standard/parts.json standard/parts.json
COPY standard/reviews.json standard/reviews.json
COPY standard/reviewers.json standard/reviewers.json
ENV NODE_ENV=production RUNNER_PORT=8787 RUNNER_HOST=0.0.0.0
EXPOSE 8787
# listen on all interfaces inside the CVM
CMD ["node", "--import", "tsx", "runner/src/main.ts"]

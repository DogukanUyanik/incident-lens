# Built from the repo root (see docker-compose.demo.yml). Keeps the repo layout: lib/paths.ts expects to run from
# packages/dashboard, with evals/scenarios.json two levels up.
FROM node:22.22.1-slim

ENV NEXT_TELEMETRY_DISABLED=1

WORKDIR /app

COPY packages/agent/package.json packages/agent/package-lock.json packages/agent/
COPY packages/dashboard/package.json packages/dashboard/package-lock.json packages/dashboard/
RUN npm ci --prefix packages/agent && npm ci --prefix packages/dashboard

COPY packages/agent packages/agent
COPY packages/dashboard packages/dashboard
COPY evals/scenarios.json evals/scenarios.ts evals/

WORKDIR /app/packages/dashboard
# next build type-checks runner/, which imports the agent source. next.config.ts needs typescript at runtime too,
# so dev dependencies stay installed.
RUN npm run build

RUN chown -R node:node .next
USER node

EXPOSE 3000

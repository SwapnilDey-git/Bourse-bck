# Bourse Stage-2 worker. Build context is the bourse-app ROOT (not worker/), because
# the worker imports the shared deep modules from ../src/lib. Build with:
#   docker build -f worker/Dockerfile -t bourse-worker .
FROM node:22-slim

WORKDIR /app

# Worker deps first (layer cache).
COPY worker/package.json worker/package-lock.json* worker/
RUN cd worker && npm install --no-audit --no-fund

# Shared library the worker imports at runtime, plus the worker source.
COPY src/lib ./src/lib
COPY worker ./worker

WORKDIR /app/worker
# tsx runs the TypeScript directly — no build step for an always-on service.
CMD ["npm", "start"]

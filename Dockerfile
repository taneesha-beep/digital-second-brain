# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Phase 1.6 — the pinned environment.
#
# The base image is pinned BY DIGEST, not by tag. `node:25.8.1-alpine` names a
# Node version but not a set of bytes: the official images are rebuilt when the
# base OS is patched and republished under the same tag. A digest is the content
# hash of the image index, so it can only ever name these bytes.
#
# That distinction is the whole point of this file. data/corpus/cooking.jsonl
# has a published SHA-256 that every nDCG number in docs/EVALUATION.md will rest
# on, and text processing is quietly environment-dependent. A floating tag makes
# that checksum reproducible in name only.
#
# The digest below is the multi-arch INDEX digest, deliberately — it resolves on
# linux/amd64, linux/arm64/v8 and linux/s390x. Pinning a per-architecture
# manifest digest would pin the bytes and break every other machine.
#
# To move Node: change the tag, re-resolve with
#   docker buildx imagetools inspect node:<version>-alpine
# and rebuild the corpus. If the checksum moves, that is a finding to record in
# docs/EVALUATION.md, not something to paper over.
# ---------------------------------------------------------------------------
FROM node:25.8.1-alpine@sha256:5209bcaca9836eb3448b650396213dbe9d9a34d31840c2ae1f206cb2986a8543 AS base
WORKDIR /app


# ---------------------------------------------------------------------------
# corpus — the one-off container behind `docker compose run corpus`.
#
# NOTHING IS INSTALLED HERE, and that is the second pin. build-corpus.js has
# zero runtime dependencies (docs/EVALUATION.md §2), so this stage contains the
# pinned Node runtime and the scripts and no third-party code at all. There is
# no npm ci, no lockfile resolution, and therefore no transitive dependency
# bump that could shift a byte of the output. "Zero dependencies" stops being a
# property of the source and becomes a property of the image.
#
# No Mongo, no network, no app code. The build scripts read data/raw/ and write
# data/corpus/, data/qrels/, data/splits/ — nothing else.
#
# The scripts resolve paths from __dirname up to the repo root, so this layout
# must mirror the repo: /app/backend/scripts + /app/data (bind-mounted).
# ---------------------------------------------------------------------------
FROM base AS corpus
COPY backend/package.json ./backend/package.json
COPY backend/scripts ./backend/scripts
CMD ["npm", "--prefix", "backend", "run", "corpus:build", "--", "--site", "cooking"]


# ---------------------------------------------------------------------------
# api — the Express server.
# ---------------------------------------------------------------------------
FROM base AS api
COPY backend/package.json backend/package-lock.json ./backend/
RUN npm --prefix backend ci --omit=dev
COPY backend ./backend
EXPOSE 5001
CMD ["node", "backend/server.js"]


# ---------------------------------------------------------------------------
# web — the Vite frontend, built and served with `vite preview`.
#
# preview rather than dev, for two reasons. vite.config.js sets
# `host: 'localhost'` (binds container loopback only, unreachable from the host)
# and proxies /api to 127.0.0.1:5001 (which inside this container is the
# container itself, not the API). preview takes --host on the CLI and needs no
# proxy, so the app runs in a container without editing a config file that
# local `npm run dev` depends on.
#
# VITE_API_URL is baked in at build time. The browser runs on the host, so
# localhost:5001 there is the published API port. Port 4173 is vite preview's
# default and is already in server.js's CORS allowlist.
# ---------------------------------------------------------------------------
FROM base AS web
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN npm --prefix frontend ci
COPY frontend ./frontend
ARG VITE_API_URL=http://localhost:5001
ENV VITE_API_URL=${VITE_API_URL}
RUN npm --prefix frontend run build
EXPOSE 4173
CMD ["npm", "--prefix", "frontend", "run", "preview", "--", "--host", "0.0.0.0", "--port", "4173"]

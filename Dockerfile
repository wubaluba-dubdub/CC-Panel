FROM node:22-slim AS base
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Install dependencies first for layer caching
COPY package.json package-lock.json* ./
RUN npm ci

# Copy source
COPY . .

# Compile the server. There is no client bundle yet: `vite build` was in this
# script a milestone before any client existed and failed with "Could not resolve
# entry module", which is what tests/integration/build.test.ts now stops.
RUN npm run build

# Production image
FROM node:22-slim AS production
RUN apt-get update && apt-get install -y tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY --from=base /app/dist ./dist

# Create non-root user and data directory
RUN addgroup --system --gid 10001 panel && \
    adduser --system --uid 10001 --ingroup panel --home /data panel && \
    mkdir -p /data && chown panel:panel /data

USER 10001

ENV HOME=/data/home \
    NODE_ENV=production \
    DATA_DIR=/data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/healthz').then(r=>r.json()).then(d=>{if(!d.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/server/index.js"]

FROM node:20-alpine AS build

WORKDIR /app

# npm + package-lock.json is the tracked lockfile. The previous file copied yarn.lock,
# which is not in the repository, so this stage could not build (audit F-25).
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
# Production bundles ship without source maps (audit F-20).
ENV GENERATE_SOURCEMAP=false \
    INLINE_RUNTIME_CHUNK=false
RUN npm run build

FROM node:20-alpine

WORKDIR /app
RUN npm install -g serve

COPY --from=build /app/build ./build

# Serve as the unprivileged `node` user (audit F-24).
USER node

EXPOSE 3000

CMD ["serve", "-s", "build", "-l", "3000"]

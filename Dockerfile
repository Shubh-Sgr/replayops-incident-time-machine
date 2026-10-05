FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
RUN npm install

COPY apps/api apps/api
RUN npm run build --workspace @replayops/api
RUN npm prune --omit=dev

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S replayops && adduser -S replayops -G replayops
COPY --from=build --chown=replayops:replayops /app/package.json ./package.json
COPY --from=build --chown=replayops:replayops /app/node_modules ./node_modules
COPY --from=build --chown=replayops:replayops /app/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=replayops:replayops /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=replayops:replayops /app/apps/api/db/migrations ./apps/api/db/migrations
USER replayops
EXPOSE 8787
CMD ["node", "apps/api/dist/index.js"]

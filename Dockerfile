FROM node:22-alpine AS build
WORKDIR /app
COPY . .
RUN npm ci && npm run build

FROM node:22-alpine AS engine
WORKDIR /app
COPY package.json package-lock.json ./
COPY engine/package.json ./engine/package.json
COPY packages/bonus/package.json ./packages/bonus/package.json
COPY packages/storage/package.json ./packages/storage/package.json
COPY operator/package.json ./operator/package.json
COPY client/package.json ./client/package.json
RUN npm ci --omit=dev --workspace engine --include-workspace-root=false --ignore-scripts
COPY engine/src ./engine/src
COPY --from=build /app/packages/bonus/dist ./packages/bonus/dist
ENV NODE_ENV=production
USER node
EXPOSE 4000
CMD ["node", "engine/src/index.js"]

FROM build AS operator
ENV NODE_ENV=production
USER node
EXPOSE 3000
CMD ["node", "operator/dist/index.js"]

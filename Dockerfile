FROM node:22-alpine
WORKDIR /app
COPY . .
RUN npm ci && npm run build
ENV NODE_ENV=production
USER node
EXPOSE 3000
CMD ["node", "operator/dist/index.js"]

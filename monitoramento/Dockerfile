FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
EXPOSE 8080
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
# tsc não copia .sql; db.ts procura o schema ao lado do próprio módulo.
COPY src/db-schema.sql ./dist/db-schema.sql
COPY config.example.yml ./config.example.yml
CMD ["node", "dist/index.js"]

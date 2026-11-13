# Single deployable service: Express API + built React app on one port. Data lives in Convex.
FROM node:22-alpine AS client
WORKDIR /app
COPY frontend/package*.json frontend/
RUN npm --prefix frontend ci
COPY frontend frontend
RUN npm --prefix frontend run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY backend/package*.json backend/
RUN npm --prefix backend ci --omit=dev
COPY backend backend
COPY --from=client /app/frontend/dist frontend/dist
EXPOSE 4000
CMD ["node", "backend/src/index.js"]

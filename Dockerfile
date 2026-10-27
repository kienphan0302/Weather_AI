FROM node:24-alpine AS builder
WORKDIR /app
ENV CI=1 \
    EXPO_NO_TELEMETRY=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx expo export --platform web

FROM nginx:stable-alpine AS runtime
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/health || exit 1

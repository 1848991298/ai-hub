FROM node:22-bookworm-slim AS web
WORKDIR /build/ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci
COPY ui/ ./
RUN npm run build
FROM python:3.12-slim
WORKDIR /app
COPY scripts/market_hub.py scripts/market_server.py ./
COPY --from=web /build/ui/dist/market.html /app/web/market.html
COPY --from=web /build/ui/dist/assets /app/web/assets
RUN mkdir /data && chown 10001:10001 /data
USER 10001:10001
EXPOSE 4320
CMD ["python3","market_server.py","--bind","0.0.0.0","--port","4320","--assets","/app/web","--data","/data/market.sqlite"]

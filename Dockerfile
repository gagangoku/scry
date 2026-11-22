# syntax=docker/dockerfile:1
#
# Headless scry: the ingest endpoint, /plugin and the browser search UI
# (server.js). No npm dependencies at runtime: Electron is only for the desktop app.
#
# docker build -t scry .
# docker run -p 9999:9999 -v scry-data:/data \
#   -e SCRY_USER=... -e SCRY_PASS=... scry
# Ingest tokens are per project, created in the UI and stored in /data.
FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY public/ public/
COPY lib/ lib/
COPY claude-chat-logger/ claude-chat-logger/
RUN mkdir -p /data && chown 65532:65532 /data
ENV NODE_ENV=production \
    PORT=9999 \
    HOST=0.0.0.0 \
    SCRY_DATA_DIR=/data
VOLUME /data
USER 65532:65532
EXPOSE 9999
CMD ["node", "server.js"]

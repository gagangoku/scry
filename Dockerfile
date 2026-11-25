# syntax=docker/dockerfile:1
#
# The scry server (Go, server/): sign-in, projects and tokens, ingest into a
# per-user spool that the Mac app drains, billing, and the public pages and
# plugin. A static binary on distroless: no shell, no Node.
#
# docker build -t scry .
# docker run -p 9999:9999 -v scry-data:/data -e SCRY_GOOGLE_CLIENT_ID=... scry
FROM golang:1.24-alpine AS build
WORKDIR /src
COPY server/ ./
ARG VERSION=dev BUILD=dev COMMIT= BUILT_AT=
RUN CGO_ENABLED=0 go build -trimpath \
      -ldflags "-s -w -X main.version=${VERSION} -X main.build=${BUILD} -X main.commit=${COMMIT} -X main.builtAt=${BUILT_AT}" \
      -o /scry-server .

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=build /scry-server /app/scry-server
COPY public/ /app/public/
COPY claude-chat-logger/ /app/claude-chat-logger/
ENV PORT=9999 HOST=0.0.0.0 SCRY_DATA_DIR=/data \
    SCRY_PUBLIC_DIR=/app/public SCRY_PLUGIN_DIR=/app/claude-chat-logger
VOLUME /data
USER 65532:65532
EXPOSE 9999
ENTRYPOINT ["/app/scry-server"]

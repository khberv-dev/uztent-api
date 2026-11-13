# The official MediaMTX image is built FROM scratch (no shell, no curl), so the
# runOnOnline / runOnOffline hooks couldn't call the API and the transcoder
# couldn't run. Same binary, on Alpine with curl and ffmpeg.
FROM alpine:3.22
RUN apk add --no-cache curl ffmpeg
COPY --from=bluenviron/mediamtx:1.21.3 /mediamtx /mediamtx
COPY mediamtx.yml /mediamtx.yml
ENTRYPOINT ["/mediamtx"]

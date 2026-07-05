FROM debian:trixie-slim

# prusa-slicer's CLI slices fully headless (no X server needed); nodejs runs
# the thin HTTP wrapper in server.mjs.
RUN apt-get update \
    && apt-get install -y --no-install-recommends prusa-slicer nodejs unzip \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --system --create-home slicer
COPY server.mjs config.ini /opt/slicer/

USER slicer
ENV HOME=/home/slicer PORT=8000
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "/opt/slicer/server.mjs"]

FROM debian:trixie-slim

# openscad's CLI renders meshes fully headless (PNG previews would need GL,
# which we don't use); nodejs runs the thin HTTP wrapper in server.mjs.
# openscad-mcad is the packaged MCAD library; BOSL2 is vendored below at a
# pinned tag because Debian doesn't package it and many MakerWorld parametric
# models depend on it. Both live under OPENSCADPATH, which is the include
# allowlist enforced app-side (SCAD_LIBRARY_ALLOWLIST in
# src/lib/scad-params.ts) — keep the two in sync.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openscad openscad-mcad nodejs ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

ARG BOSL2_TAG=v2.0.747
RUN mkdir -p /usr/share/openscad/libraries \
    && curl -fsSL "https://github.com/BelfrySCAD/BOSL2/archive/refs/tags/${BOSL2_TAG}.tar.gz" \
       | tar -xz -C /usr/share/openscad/libraries \
    && mv /usr/share/openscad/libraries/BOSL2-* /usr/share/openscad/libraries/BOSL2

RUN useradd --system --create-home openscad
COPY server.mjs lib.mjs /opt/openscad/

USER openscad
ENV HOME=/home/openscad PORT=8000 OPENSCADPATH=/usr/share/openscad/libraries
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "/opt/openscad/server.mjs"]

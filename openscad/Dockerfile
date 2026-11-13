# Node comes from the official image rather than the distro's `nodejs` package: Ubuntu/Debian ship EOL lines (18/20) that miss security releases such as CVE-2026-111497 (Node2Shell, Brotli RCE; fixed in 24.22.1). The official binary is built against an old glibc and runs on this base as-is.
FROM node:24.22.1-trixie-slim AS node

# OpenSCAD's official weekly development build on Debian trixie, not Debian's own `openscad` package: that is still 2021.01, which only has the CGAL renderer. This build has the Manifold renderer (selected in server.mjs), which renders typical customizer models 100x+ faster (a 60 mm junction box: 29 s → 0.2 s). There has been no stable release since 2021.01, so the dated tag is the pin; Renovate bumps it and the bumps are reviewed by hand (renovate.json).
FROM openscad/openscad:trixie.2026-11-09

# The CLI renders meshes fully headless (PNG previews would need GL, which we don't use); node (copied from the node stage) runs the thin HTTP wrapper in server.mjs. The image ships MCAD under /usr/local/share/openscad/libraries; BOSL2 is vendored next to it at a pinned tag because many MakerWorld parametric models depend on it. That directory is OPENSCADPATH and the include allowlist enforced app-side (SCAD_LIBRARY_ALLOWLIST in src/lib/scad-params.ts) — keep the two in sync.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

ARG BOSL2_TAG=v2.0.747
RUN curl -fsSL "https://github.com/BelfrySCAD/BOSL2/archive/refs/tags/${BOSL2_TAG}.tar.gz" \
       | tar -xz -C /usr/local/share/openscad/libraries \
    && mv /usr/local/share/openscad/libraries/BOSL2-* /usr/local/share/openscad/libraries/BOSL2

COPY --from=node /usr/local/bin/node /usr/local/bin/node

RUN useradd --system --create-home openscad
COPY server.mjs lib.mjs /opt/openscad/

USER openscad
WORKDIR /home/openscad
ENV HOME=/home/openscad PORT=8000 OPENSCADPATH=/usr/local/share/openscad/libraries
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "/opt/openscad/server.mjs"]

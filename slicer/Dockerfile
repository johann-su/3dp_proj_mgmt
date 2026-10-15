# OrcaSlicer ships for Linux only as an AppImage (built against Ubuntu 24.04)
# or a flatpak. The AppImage is an ELF runtime with a squashfs appended; it is
# unpacked with unsquashfs rather than by running `--appimage-extract`, so the
# image also cross-builds (an amd64 AppImage can't execute on an arm64 build
# host, even under emulation). The runtime stage is the matching Ubuntu.
FROM ubuntu:24.04 AS orca

# renovate: datasource=github-releases depName=OrcaSlicer/OrcaSlicer extractVersion=^v(?<version>.*)$
ARG ORCA_VERSION=2.4.2
ARG TARGETARCH
# A stalled mirror connection otherwise hangs the build indefinitely (seen on
# the Dokploy host: apt sat on "Ign: … noble InRelease" for 15+ minutes):
# time out each request and retry instead. Repeated in the runtime stage.
RUN printf 'Acquire::Retries "5";\nAcquire::http::Timeout "30";\nAcquire::https::Timeout "30";\n' \
      > /etc/apt/apt.conf.d/80-retries
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl squashfs-tools \
    && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    case "$TARGETARCH" in arm64) arch=_aarch64 ;; *) arch= ;; esac; \
    curl -fsSL --retry 5 --retry-delay 5 --connect-timeout 30 -o /tmp/orca.AppImage \
      "https://github.com/OrcaSlicer/OrcaSlicer/releases/download/v${ORCA_VERSION}/OrcaSlicer_Linux_AppImage_Ubuntu2404${arch}_V${ORCA_VERSION}.AppImage"; \
    # The squashfs starts where the runtime's ELF ends: after its section \
    # header table (e_shoff + e_shentsize * e_shnum, 64-bit little-endian). \
    shoff=$(od -An -t u8 -j 40 -N 8 /tmp/orca.AppImage | tr -d ' '); \
    shentsize=$(od -An -t u2 -j 58 -N 2 /tmp/orca.AppImage | tr -d ' '); \
    shnum=$(od -An -t u2 -j 60 -N 2 /tmp/orca.AppImage | tr -d ' '); \
    unsquashfs -q -no-progress -o $((shoff + shentsize * shnum)) -d /opt/orca /tmp/orca.AppImage; \
    rm /tmp/orca.AppImage; \
    test -x /opt/orca/AppRun

FROM ubuntu:24.04

# The CLI slices headless (no X server or xvfb needed), but the binary is the
# GUI build and links GTK/WebKit/GL, so those runtime libraries must exist.
# nodejs runs the thin HTTP wrapper in server.mjs; unzip/zip read and patch
# the .3mf archives.
COPY --from=orca /etc/apt/apt.conf.d/80-retries /etc/apt/apt.conf.d/80-retries
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       libgtk-3-0t64 libwebkit2gtk-4.1-0 libgl1 libegl1 libglu1-mesa \
       libopengl0 libgstreamer1.0-0 libgstreamer-plugins-base1.0-0 \
       libsecret-1-0 libsm6 libice6 libwayland-egl1 libdbus-1-3 \
       nodejs unzip zip \
    && rm -rf /var/lib/apt/lists/*

COPY --from=orca /opt/orca /opt/orca
COPY server.mjs lib.mjs presets.mjs /opt/slicer/

RUN useradd --system --create-home slicer

USER slicer
# The printer files without slicer settings are estimated for: names of Orca
# system presets (resources/profiles/<vendor>/{machine,process,filament}),
# flattened at startup. Unset = Bambu Lab P1S / 0.20mm Standard / Bambu PLA.
ENV HOME=/home/slicer PORT=8000 \
    SLICER_GENERIC_MACHINE="" SLICER_GENERIC_PROCESS="" SLICER_GENERIC_FILAMENT=""
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "/opt/slicer/server.mjs"]

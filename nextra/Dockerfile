# Operator docs site (Nextra static export behind nginx). Deployed separately
# on its own subdomain — deliberately NOT a compose.yml service and never part
# of the app image: the docs describe the software, not one deployment, and are
# published once by the project rather than bundled with every instance.
#
# Build from the REPOSITORY ROOT so the content symlink (nextra/content ->
# ../docs) resolves inside the build context:
#
#   docker build -f nextra/Dockerfile -t print-vault-docs .

FROM node:22-alpine AS build
WORKDIR /repo/nextra
COPY nextra/package.json nextra/package-lock.json ./
RUN npm ci
# docs/ must land next to nextra/ for the content symlink to resolve.
COPY docs /repo/docs
COPY nextra /repo/nextra
RUN npm run build

FROM nginx:alpine
COPY nextra/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/nextra/out /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
    CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1

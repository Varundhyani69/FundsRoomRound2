# frontend/Dockerfile -- the Web_Client image: build the bundle, serve it with nginx.
#
# The runtime stage carries no Node at all. A Vite build produces static files, so
# what ships is nginx plus a `dist/` directory -- around 50MB instead of the ~250MB
# a Node runtime image would cost, and with no JavaScript runtime in the image to
# have vulnerabilities reported against it.
#
# ---------------------------------------------------------------------------------
# THE ONE THING TO UNDERSTAND ABOUT THIS IMAGE
# ---------------------------------------------------------------------------------
# VITE_API_BASE_URL is a BUILD-TIME value, not a runtime one. Vite substitutes
# `import.meta.env.VITE_API_BASE_URL` into the bundle as a literal string during
# `npm run build`, so by the time nginx serves those files the API URL is baked in
# and setting an environment variable on the running container changes nothing.
#
# The practical consequence: one image per environment. An image built for
# staging cannot be promoted to production if the two use different API URLs --
# production needs its own build. That is a real constraint of any static SPA, not
# something specific to this project, and the alternative (fetching the URL from a
# runtime-generated config.js) buys deployment flexibility at the cost of an extra
# request before the app can start. For a single-environment case study, baking it
# in is the simpler and more defensible choice.
#
# vite.config.js hard-fails the build when the variable is missing (Req 10.11), so a
# forgotten --build-arg is a failed build, never an image that silently points at
# localhost.

# ---------------------------------------------------------------------------------
# Stage 1: build the bundle
# ---------------------------------------------------------------------------------
FROM node:20-alpine AS build

WORKDIR /app

# Lockfile first, so the dependency layer caches independently of source changes.
COPY package.json package-lock.json ./

# The full dependency set, not --omit=dev: vite, @vitejs/plugin-react and the rest
# of the toolchain live in devDependencies and are exactly what performs the build.
# None of them reach the runtime stage.
RUN npm ci

# Declared AFTER the dependency install so changing the URL does not invalidate the
# npm cache layer, and BEFORE the source copy so the build sees it.
#
# Not a secret: it is a public URL that ends up readable in the shipped JavaScript
# anyway. Never pass an actual secret as a build argument -- ARG values are recorded
# in the image history and are readable with `docker history`.
ARG VITE_API_BASE_URL
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL

COPY . .

RUN npm run build

# ---------------------------------------------------------------------------------
# Stage 2: serve
# ---------------------------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime

# SPA routing, cache headers, gzip, and a /healthz target for a load balancer.
# Replaces the default server block rather than adding to it.
COPY nginx.conf /etc/nginx/conf.d/default.conf

COPY --from=build /app/dist /usr/share/nginx/html

# Port 80 inside the container; TLS terminates at the load balancer or CloudFront in
# front of it, so nginx here speaks plain HTTP. Left as root because nginx needs to
# bind a privileged port and then drops to its own `nginx` worker user; switching to
# an unprivileged user would mean also moving the listener to 8080 and rewriting the
# pid and temp paths, which buys little when the container is behind a load balancer
# and runs no application code.
EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --quiet --spider http://127.0.0.1/healthz || exit 1

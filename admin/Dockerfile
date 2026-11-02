# Install dependencies in a separate stage, so npm itself does not end up in the image.
FROM node:20-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-alpine

# The runtime only needs node. Remove the bundled package managers (npm, corepack, yarn):
# they are not used at runtime and their own dependencies show up in vulnerability scans.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js ./
COPY views/ ./views/
COPY defaults/ ./defaults/

EXPOSE 3002

CMD ["node", "server.js"]

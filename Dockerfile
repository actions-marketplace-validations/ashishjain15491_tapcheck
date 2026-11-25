# tapcheck with Chromium and its system libraries, on the official Playwright image. The tag must match the playwright
# version in package.json: the image's browsers are the ones that version drives.
#
#   docker build -t tapcheck .
#   docker run --rm --network host --ipc=host -v "$PWD:/work" -w /work tapcheck
#
# The image holds Node.js, Chromium and tapcheck: not your app's runtime. Run the app separately (on the host, or in
# its own container) and give its address as baseUrl; leave app.start out of the tapcheck.yml the container reads.
FROM mcr.microsoft.com/playwright:v1.65.1-noble
WORKDIR /opt/tapcheck
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
RUN npm run build && npm prune --omit=dev --no-audit --no-fund
WORKDIR /work
ENTRYPOINT ["node", "/opt/tapcheck/dist/cli.js"]

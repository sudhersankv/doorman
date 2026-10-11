# Doorman server only (the simulator with Playwright runs locally; the public app needs no browser).
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund --ignore-scripts
COPY server.js ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
EXPOSE 3000
CMD ["node", "server.js"]

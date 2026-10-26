FROM node:22-slim

# Install Chromium dependencies for Puppeteer.
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Use the system Chromium installed above instead of downloading a second
# browser during npm install. Production must receive client secrets from a
# runtime secret source, never from the repository build context.
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV REQUIRE_EXTERNAL_CLIENT_CONFIG=true
ENV NODE_ENV=production
ENV RUNTIME_DATA_DIR=/app/runtime

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY . .
RUN mkdir -p /app/runtime /app/logs \
    && chown -R node:node /app

USER node

EXPOSE 3000

CMD ["node", "src/server.js"]

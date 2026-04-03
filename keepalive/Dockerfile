FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-noto-cjk \
    dumb-init \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production

COPY src/ src/

ENV CHROME_PROFILE_DIR=/data/chrome-profile
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

EXPOSE 8080 9222

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/server.mjs"]

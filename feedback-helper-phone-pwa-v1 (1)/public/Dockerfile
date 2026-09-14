FROM mcr.microsoft.com/playwright:v1.55.0-noble

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

# Keep the exact browser binary inside the image so runtime never depends on a cache download.
ENV PLAYWRIGHT_BROWSERS_PATH=0
RUN npx playwright install chromium

COPY . .

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.mjs"]

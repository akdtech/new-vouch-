FROM node:24.20.0-bookworm-slim

ENV NODE_ENV=production
ENV YTDLP_PATH=/usr/local/bin/yt-dlp
ENV FFMPEG_PATH=/usr/bin/ffmpeg

# Direct music engine dependencies: FFmpeg + Python 3 for yt-dlp + HTTPS certificates.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates python3 \
    && curl -L --fail --silent --show-error https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod 755 /usr/local/bin/yt-dlp \
    && python3 --version \
    && /usr/local/bin/yt-dlp --version \
    && ffmpeg -version | head -n 1 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000

CMD ["node", "index-direct.js"]

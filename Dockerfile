FROM node:24.20.0-bookworm-slim

ENV NODE_ENV=production
ENV YTDLP_PATH=/usr/local/bin/yt-dlp
ENV FFMPEG_PATH=/usr/bin/ffmpeg

# Direct music engine: FFmpeg + Python 3 + Deno for yt-dlp's current YouTube EJS challenge solver.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates python3 unzip \
    && curl -L --fail --silent --show-error https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod 755 /usr/local/bin/yt-dlp \
    && curl -L --fail --silent --show-error https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip -o /tmp/deno.zip \
    && unzip -q /tmp/deno.zip -d /tmp/deno \
    && install -m 755 /tmp/deno/deno /usr/local/bin/deno \
    && rm -rf /tmp/deno /tmp/deno.zip \
    && python3 --version \
    && deno --version \
    && /usr/local/bin/yt-dlp --version \
    && ffmpeg -version | head -n 1 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000

CMD ["node", "-r", "./music/directCompatibilityPatch.js", "-r", "./music/directPlaybackPatch.js", "index-direct.js"]

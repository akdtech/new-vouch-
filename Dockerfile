FROM node:24.20.0-bookworm-slim

ENV NODE_ENV=production
ENV YTDLP_PATH=/usr/local/bin/yt-dlp
ENV FFMPEG_PATH=/usr/bin/ffmpeg
ENV YTDLP_POT_PROVIDER_URL=http://bgutil-pot.railway.internal:4416

# Direct music engine: FFmpeg + Python 3 + Deno for yt-dlp's current YouTube EJS challenge solver.
# BgUtils provides fresh YouTube Proof-of-Origin tokens to reduce Railway IP bot checks.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates python3 python3-pip unzip \
    && curl -L --fail --silent --show-error https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod 755 /usr/local/bin/yt-dlp \
    && python3 -m pip install --no-cache-dir --break-system-packages -U bgutil-ytdlp-pot-provider==2.0.0 \
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

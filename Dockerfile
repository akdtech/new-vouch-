FROM node:24.20.0-bookworm-slim

ENV NODE_ENV=production
ENV YTDLP_PATH=/usr/local/bin/yt-dlp
ENV FFMPEG_PATH=/usr/bin/ffmpeg
ENV YTDLP_POT_PROVIDER_URL=http://bgutil-pot.railway.internal:4416

# Direct music engine: FFmpeg + Chromium + Deno for current YouTube extraction.
# WebPoClient is installed as a browser-backed PO-token provider because the
# Railway IP is currently receiving YouTube bot checks even with BgUtils.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg chromium curl ca-certificates python3 python3-pip unzip \
    && curl -L --fail --silent --show-error https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod 755 /usr/local/bin/yt-dlp \
    && python3 -m pip install --no-cache-dir --break-system-packages -U yt-dlp-getpot-wpc \
    && curl -L --fail --silent --show-error https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip -o /tmp/deno.zip \
    && unzip -q /tmp/deno.zip -d /tmp/deno \
    && install -m 755 /tmp/deno/deno /usr/local/bin/deno \
    && rm -rf /tmp/deno /tmp/deno.zip \
    && python3 --version \
    && chromium --version \
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

CMD ["node", "-r", "./music/directCompatibilityPatch.js", "-r", "./music/directAutoplayPatch.js", "-r", "./music/directPlaybackPatch.js", "-r", "./music/directPipedPlaybackPatch.js", "-r", "./music/directInvidiousFallbackPatch.js", "-r", "./music/directPipedSearchPatch.js", "-r", "./music/directControlsPatch.js", "-r", "./music/directPanelPatch.js", "-r", "./music/directSyncPatch.js", "-r", "./music/directLiveStatePatch.js", "-r", "./music/directPlaylistPatch.js", "index-direct.js"]

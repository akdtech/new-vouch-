FROM ghcr.io/lavalink-devs/lavalink:4

USER root

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && curl -L --fail --silent --show-error \
       https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
       -o /usr/local/bin/yt-dlp \
    && chmod 755 /usr/local/bin/yt-dlp \
    && /usr/local/bin/yt-dlp --version \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

COPY application.yml /opt/Lavalink/application.yml
COPY application.properties /opt/Lavalink/application.properties

EXPOSE 2333

# DEATH Music 24/7 — GMAO

Professional Discord music/community bot for GMAO Gaming Community.

## This bot service only

This repository is the **bot service**. It connects to your existing Railway Lavalink service and existing yt-cipher service.

**Do not redeploy or modify `reliable-miracle` or `yt-cipher` for this bot update.**

## Music

- `/play` queues music without interrupting the current track.
- User-requested tracks always have priority over autoplay.
- Autoplay adds one random track only when the queue is empty.
- Recent autoplay tracks are avoided.
- 24/7 voice reconnects automatically to the configured GMAO Music channel.
- Current song appears in the Voice Channel Status.
- Bot activity updates to the current song.
- Music panel/buttons live in the GMAO Music voice channel's text chat.
- YouTube search with SoundCloud fallback.

## Commands

Commands are registered as a single GMAO guild command set. The deploy script clears old global commands first, preventing the global+guild duplicate-command problem.

## Railway variables

Keep your existing Lavalink variables, including:

- `LAVALINK_HOST=reliable-miracle.railway.internal`
- `LAVALINK_PORT=2333`
- `LAVALINK_SECURE=false`
- `LAVALINK_NAME=main`
- `LAVALINK_PASSWORD=<your existing Lavalink password>`

Also set:

- `DISCORD_TOKEN`
- `CLIENT_ID`
- `GUILD_ID`
- `MUSIC_VOICE_CHANNEL_ID=1532082737480077462`

Never commit secrets.

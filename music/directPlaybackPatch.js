"use strict";

const { spawn } = require("node:child_process");
const { createAudioResource, StreamType, AudioPlayerStatus } = require("@discordjs/voice");

const YTDLP = process.env.YTDLP_PATH || "/usr/local/bin/yt-dlp";
const FFMPEG = process.env.FFMPEG_PATH || "/usr/bin/ffmpeg";

function installDirectPlaybackPatch(DirectMusicManager) {
  if (!DirectMusicManager || DirectMusicManager.prototype.__deathDirectPlaybackPatched) return;
  DirectMusicManager.prototype.__deathDirectPlaybackPatched = true;

  DirectMusicManager.prototype.resolveAudioUrl = async function (track) {
    const url = track?.url;
    if (!url) throw new Error("Track has no playable URL.");

    return new Promise((resolve, reject) => {
      const child = spawn(YTDLP, [
        "--no-warnings", "--no-progress", "--no-playlist",
        "--js-runtimes", "deno", "--remote-components", "ejs:github",
        "--format", "bestaudio/best", "--get-url", url
      ], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "", settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill("SIGKILL"); } catch {}
        reject(new Error("yt-dlp stream URL lookup timed out."));
      }, 45000);
      child.stdout.on("data", c => { stdout += c.toString(); });
      child.stderr.on("data", c => { stderr += c.toString(); });
      child.on("error", error => {
        if (settled) return;
        settled = true; clearTimeout(timer); reject(error);
      });
      child.on("close", code => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        const streamUrl = stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
        if (code === 0 && streamUrl) return resolve(streamUrl);
        const detail = stderr.trim().split(/\r?\n/).filter(Boolean).slice(-8).join(" | ");
        reject(new Error(`yt-dlp could not resolve audio (code ${code}). ${detail}`.trim()));
      });
    });
  };

  DirectMusicManager.prototype.startTrack = async function (guildId, track, startMs = 0) {
    const state = this.getState(guildId);
    const player = this.players.get(guildId) || this.ensurePlayer(guildId);
    this.bindPlayerEvents(guildId, player);
    this.destroyStream(guildId);
    state.current = track;
    state.startedAt = Date.now();
    state.positionOffset = Math.max(0, Number(startMs || 0));
    state.paused = false;

    let streamUrl;
    try {
      streamUrl = await this.resolveAudioUrl(track);
    } catch (error) {
      console.error(`❌ Direct yt-dlp resolve failed [${guildId}]:`, error?.message || error);
      state.current = null; state.startedAt = 0; state.positionOffset = 0;
      throw error;
    }

    const ffArgs = [
      "-hide_banner", "-loglevel", "warning",
      "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5",
      ...(startMs > 0 ? ["-ss", String(startMs / 1000)] : []),
      "-i", streamUrl, "-vn", "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"
    ];
    const ff = spawn(FFMPEG, ffArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let ffStderr = "";
    ff.stderr.on("data", c => {
      ffStderr += c.toString();
      if (ffStderr.length > 12000) ffStderr = ffStderr.slice(-12000);
    });
    this.streams.set(guildId, { ff, streamUrl });
    ff.on("error", error => {
      if (state.current === track) console.error(`❌ FFmpeg stream error [${guildId}]:`, error?.message || error);
    });
    ff.on("close", code => {
      if (state.current !== track) return;
      if (code !== 0) console.warn(`⚠️ FFmpeg ended with code ${code}: ${ffStderr.trim().split(/\r?\n/).slice(-3).join(" | ")}`);
    });

    const resource = createAudioResource(ff.stdout, { inputType: StreamType.Raw, inlineVolume: true, metadata: track });
    resource.volume?.setVolume(Math.max(0.01, state.volume / 100));
    player.play(resource);
    await new Promise(resolve => setImmediate(resolve));

    console.log(`▶️ Direct playback started: ${track.title}`);
    console.log(`🔊 Direct audio resource status: ${player.state.status}`);
    await this.refreshPanel(guildId).catch(() => {});
    if (player.state.status === AudioPlayerStatus.Idle) {
      throw new Error("Discord audio player remained idle after starting the stream.");
    }
  };

  console.log("🛠️ DEATH direct playback patch loaded: yt-dlp URL resolution + FFmpeg reconnect stream.");
}

try {
  const DirectMusicManager = require("./DirectMusicManager");
  installDirectPlaybackPatch(DirectMusicManager);
} catch (error) {
  console.error("❌ Direct playback patch failed to load:", error?.message || error);
}

module.exports = { installDirectPlaybackPatch };

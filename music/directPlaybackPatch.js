"use strict";

const { spawn } = require("node:child_process");
const { PassThrough } = require("node:stream");
const { createAudioResource, StreamType, AudioPlayerStatus } = require("@discordjs/voice");

const YTDLP = process.env.YTDLP_PATH || "/usr/local/bin/yt-dlp";
const FFMPEG = process.env.FFMPEG_PATH || "/usr/bin/ffmpeg";
const POT_PROVIDER = process.env.YTDLP_POT_PROVIDER_URL || "http://bgutil-pot.railway.internal:4416";
const STARTUP_TIMEOUT_MS = 8000;
const PCM_BUFFER_BYTES = 1024 * 1024;

function conciseError(text, max = 900) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(-max);
}

function isYoutubeBotBlock(text) {
  const value = String(text || "").toLowerCase();
  return value.includes("sign in to confirm") || value.includes("not a bot") || value.includes("login_required");
}

function installDirectPlaybackPatch(DirectMusicManager) {
  if (!DirectMusicManager || DirectMusicManager.prototype.__deathDirectPlaybackPatched) return;
  DirectMusicManager.prototype.__deathDirectPlaybackPatched = true;

  DirectMusicManager.prototype.startTrack = async function (guildId, track, startMs = 0) {
    const state = this.getState(guildId);
    const player = this.players.get(guildId) || this.ensurePlayer(guildId);
    this.bindPlayerEvents(guildId, player);
    this.destroyStream(guildId);

    state.current = track;
    state.startedAt = Date.now();
    state.positionOffset = Math.max(0, Number(startMs || 0));
    state.paused = false;
    state.audioResource = null;

    const clientProfiles = ["web_embedded", "web_safari", "tv", "mweb", "android_vr", "default"];
    const failures = [];

    for (const client of clientProfiles) {
      this.destroyStream(guildId);
      try {
        const result = await new Promise((resolve, reject) => {
          const ytArgs = [
            "--no-warnings", "--no-progress", "--no-playlist", "--force-ipv4",
            "--js-runtimes", "deno", "--remote-components", "ejs:github",
            "--extractor-args", `youtube:player_client=${client};youtubepot-bgutilhttp:base_url=${POT_PROVIDER}`,
            "--retries", "1", "--fragment-retries", "1", "--retry-sleep", "linear=1::2",
            "--sleep-requests", "1", "--format", "bestaudio/best", "--output", "-", track.url
          ];

          const yt = spawn(YTDLP, ytArgs, { stdio: ["ignore", "pipe", "pipe"] });
          const ff = spawn(FFMPEG, [
            "-hide_banner", "-loglevel", "warning", "-nostdin", "-i", "pipe:0",
            ...(startMs > 0 ? ["-ss", String(startMs / 1000)] : []),
            "-vn", "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"
          ], { stdio: ["pipe", "pipe", "pipe"] });

          const pcm = new PassThrough({ highWaterMark: PCM_BUFFER_BYTES });
          ff.stdout.pipe(pcm);

          let ytStderr = "";
          let ffStderr = "";
          let settled = false;
          let gotYtBytes = false;
          let gotPcmBytes = false;
          let firstBytesTimer = null;

          const cleanup = () => {
            if (firstBytesTimer) clearTimeout(firstBytesTimer);
            try { yt.stdout.unpipe(ff.stdin); } catch {}
            try { ff.stdout.unpipe(pcm); } catch {}
            try { pcm.destroy(); } catch {}
            try { yt.kill("SIGKILL"); } catch {}
            try { ff.kill("SIGKILL"); } catch {}
          };
          const fail = error => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
          };
          const success = () => {
            if (settled) return;
            settled = true;
            if (firstBytesTimer) clearTimeout(firstBytesTimer);
            resolve({ yt, ff, pcm });
          };

          yt.stderr.on("data", chunk => {
            ytStderr += chunk.toString();
            if (ytStderr.length > 10000) ytStderr = ytStderr.slice(-10000);
          });
          ff.stderr.on("data", chunk => {
            ffStderr += chunk.toString();
            if (ffStderr.length > 10000) ffStderr = ffStderr.slice(-10000);
          });
          yt.stdout.on("data", chunk => { if (chunk?.length) gotYtBytes = true; });
          ff.stdout.on("data", chunk => {
            if (chunk?.length) {
              gotPcmBytes = true;
              if (!settled) success();
            }
          });
          ff.stdin.on("error", error => {
            if (error?.code !== "EPIPE") console.warn(`⚠️ FFmpeg stdin error (${client}): ${error?.message || error}`);
          });
          yt.stdout.on("error", error => { if (error?.code !== "EPIPE") fail(error); });
          ff.stdout.on("error", error => { if (error?.code !== "EPIPE") fail(error); });
          pcm.on("error", error => fail(error));

          yt.stdout.pipe(ff.stdin);
          yt.on("error", error => fail(error));
          ff.on("error", error => fail(error));
          yt.on("close", code => {
            if (code !== 0 && !gotYtBytes && !gotPcmBytes) {
              return fail(new Error(`yt-dlp ${client} exited with code ${code}: ${conciseError(ytStderr, 1600)}`.trim()));
            }
            if (code !== 0 && !gotPcmBytes) console.warn(`⚠️ yt-dlp ${client} ended with code ${code} before FFmpeg produced PCM.`);
          });
          ff.on("close", code => {
            if (!gotPcmBytes) return fail(new Error(`FFmpeg ${client} exited with code ${code}: ${conciseError(ffStderr, 1200)}`.trim()));
          });
          firstBytesTimer = setTimeout(() => {
            if (gotPcmBytes || player.state.status === AudioPlayerStatus.Buffering || player.state.status === AudioPlayerStatus.Playing) success();
            else fail(new Error(`No PCM audio received from FFmpeg client ${client} within ${STARTUP_TIMEOUT_MS / 1000}s. yt-dlp=${conciseError(ytStderr, 1000) || "none"}; ffmpeg=${conciseError(ffStderr, 500) || "none"}`));
          }, STARTUP_TIMEOUT_MS);
        });

        const { yt, ff, pcm } = result;
        this.streams.set(guildId, { yt, ff, pcm });
        const resource = createAudioResource(pcm, { inputType: StreamType.Raw, inlineVolume: true, metadata: track });
        resource.volume?.setVolume(Math.max(0.01, state.volume / 100));
        state.audioResource = resource;
        player.play(resource);
        Promise.resolve(this.refreshPanel(guildId)).catch(() => {});
        console.log(`▶️ Direct playback started: ${track.title}`);
        console.log(`🔊 Direct audio resource status: ${player.state.status}`);
        console.log(`✅ Direct yt-dlp stream client: ${client}`);
        return;
      } catch (error) {
        const message = error?.message || String(error);
        const short = conciseError(message, 1800);
        failures.push(`${client}: ${short}`);
        if (isYoutubeBotBlock(message)) console.warn(`🚧 YouTube bot check on ${client}; trying next client.`);
        else console.warn(`⚠️ Direct stream client ${client} failed: ${short}`);
      }
    }

    state.audioResource = null;
    state.current = null;
    state.startedAt = 0;
    state.positionOffset = 0;
    throw new Error(`No playable YouTube stream was produced. ${failures.join(" || ")}`);
  };

  console.log("🛠️ DEATH direct playback patch loaded: fast handoff + buffered PCM + resilient YouTube clients + BgUtils PO-token.");
}

try {
  const DirectMusicManager = require("./DirectMusicManager");
  installDirectPlaybackPatch(DirectMusicManager);
} catch (error) {
  console.error("❌ Direct playback patch failed to load:", error?.message || error);
}

module.exports = { installDirectPlaybackPatch };

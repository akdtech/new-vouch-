"use strict";

const { spawn } = require("node:child_process");
const { createAudioResource, StreamType, AudioPlayerStatus } = require("@discordjs/voice");

const YTDLP = process.env.YTDLP_PATH || "/usr/local/bin/yt-dlp";
const FFMPEG = process.env.FFMPEG_PATH || "/usr/bin/ffmpeg";
const POT_PROVIDER = process.env.YTDLP_POT_PROVIDER_URL || "http://bgutil-pot.railway.internal:4416";

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

    // YouTube is currently enforcing anti-bot checks on many Railway IPs.
    // Use the fresh BgUtils PO-token provider with mweb first, then retain
    // several client fallbacks for videos with client-specific restrictions.
    const clientProfiles = ["mweb", "tv", "android_vr", "default"];
    const failures = [];

    for (const client of clientProfiles) {
      this.destroyStream(guildId);
      try {
        const result = await new Promise((resolve, reject) => {
          const ytArgs = [
            "--no-warnings",
            "--no-progress",
            "--no-playlist",
            "--force-ipv4",
            "--js-runtimes", "deno",
            "--remote-components", "ejs:github",
            "--extractor-args", `youtube:player_client=${client};youtubepot-bgutilhttp:base_url=${POT_PROVIDER}`,
            "--retries", "3",
            "--fragment-retries", "3",
            "--retry-sleep", "linear=1::2",
            "--format", "bestaudio/best",
            "--output", "-",
            track.url
          ];

          const yt = spawn(YTDLP, ytArgs, { stdio: ["ignore", "pipe", "pipe"] });
          const ffArgs = [
            "-hide_banner",
            "-loglevel", "warning",
            "-nostdin",
            "-reconnect", "1",
            "-reconnect_streamed", "1",
            "-reconnect_delay_max", "5",
            "-i", "pipe:0",
            ...(startMs > 0 ? ["-ss", String(startMs / 1000)] : []),
            "-vn",
            "-f", "s16le",
            "-ar", "48000",
            "-ac", "2",
            "pipe:1"
          ];
          const ff = spawn(FFMPEG, ffArgs, { stdio: ["pipe", "pipe", "pipe"] });

          let ytStderr = "";
          let ffStderr = "";
          let settled = false;
          let gotYtBytes = false;
          let gotPcmBytes = false;
          let firstBytesTimer = null;

          const cleanup = () => {
            if (firstBytesTimer) clearTimeout(firstBytesTimer);
            try { yt.stdout.unpipe(ff.stdin); } catch {}
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
            resolve({ yt, ff });
          };

          yt.stderr.on("data", chunk => {
            ytStderr += chunk.toString();
            if (ytStderr.length > 12000) ytStderr = ytStderr.slice(-12000);
          });
          ff.stderr.on("data", chunk => {
            ffStderr += chunk.toString();
            if (ffStderr.length > 12000) ffStderr = ffStderr.slice(-12000);
          });

          yt.stdout.on("data", () => {
            gotYtBytes = true;
          });

          // Only declare success after FFmpeg has produced actual PCM audio.
          ff.stdout.on("data", () => {
            gotPcmBytes = true;
            if (!settled) success();
          });

          // FFmpeg can close its stdin while yt-dlp is still flushing bytes.
          // EPIPE is expected during teardown and must never become uncaught.
          ff.stdin.on("error", error => {
            if (error?.code !== "EPIPE") {
              console.warn(`⚠️ FFmpeg stdin error (${client}): ${error?.message || error}`);
            }
          });

          yt.stdout.on("error", error => {
            if (error?.code !== "EPIPE") fail(error);
          });
          ff.stdout.on("error", error => {
            if (error?.code !== "EPIPE") fail(error);
          });

          yt.stdout.pipe(ff.stdin);
          yt.on("error", error => fail(error));
          ff.on("error", error => fail(error));

          yt.on("close", code => {
            if (code !== 0 && !gotYtBytes && !gotPcmBytes) {
              const detail = ytStderr.trim().split(/\r?\n/).filter(Boolean).slice(-6).join(" | ");
              return fail(new Error(`yt-dlp ${client} exited with code ${code}: ${detail}`.trim()));
            }
            if (code !== 0 && !gotPcmBytes) {
              console.warn(`⚠️ yt-dlp ${client} ended with code ${code} before FFmpeg produced PCM.`);
            }
          });

          ff.on("close", code => {
            if (!gotPcmBytes) {
              const detail = ffStderr.trim().split(/\r?\n/).filter(Boolean).slice(-6).join(" | ");
              return fail(new Error(`FFmpeg ${client} exited with code ${code}: ${detail}`.trim()));
            }
          });

          firstBytesTimer = setTimeout(() => {
            if (gotPcmBytes || player.state.status === AudioPlayerStatus.Buffering || player.state.status === AudioPlayerStatus.Playing) {
              success();
            } else {
              const ytDetail = ytStderr.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" | ");
              const ffDetail = ffStderr.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" | ");
              fail(new Error(`No PCM audio received from FFmpeg client ${client} within 8 seconds. yt-dlp=${ytDetail || "none"}; ffmpeg=${ffDetail || "none"}`));
            }
          }, 8000);
        });

        const { yt, ff } = result;
        this.streams.set(guildId, { yt, ff });
        const resource = createAudioResource(ff.stdout, {
          inputType: StreamType.Raw,
          inlineVolume: true,
          metadata: track
        });
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
        failures.push(`${client}: ${message}`);
        console.warn(`⚠️ Direct stream client ${client} failed: ${message}`);
      }
    }

    state.audioResource = null;
    state.current = null;
    state.startedAt = 0;
    state.positionOffset = 0;
    throw new Error(`No playable YouTube stream was produced. ${failures.join(" || ")}`);
  };

  console.log("🛠️ DEATH direct playback patch loaded: BgUtils PO-token YouTube + resilient FFmpeg PCM pipeline.");
}

try {
  const DirectMusicManager = require("./DirectMusicManager");
  installDirectPlaybackPatch(DirectMusicManager);
} catch (error) {
  console.error("❌ Direct playback patch failed to load:", error?.message || error);
}

module.exports = { installDirectPlaybackPatch };

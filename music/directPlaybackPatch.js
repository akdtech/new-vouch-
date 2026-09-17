"use strict";

const { spawn } = require("node:child_process");
const { createAudioResource, StreamType, AudioPlayerStatus } = require("@discordjs/voice");

const YTDLP = process.env.YTDLP_PATH || "/usr/local/bin/yt-dlp";
const FFMPEG = process.env.FFMPEG_PATH || "/usr/bin/ffmpeg";

function installDirectPlaybackPatch(DirectMusicManager) {
  if (!DirectMusicManager || DirectMusicManager.prototype.__deathDirectPlaybackPatched) return;
  DirectMusicManager.prototype.__deathDirectPlaybackPatched = true;

  // Keep the YouTube stream and FFmpeg pipeline alive; do not extract a
  // separate signed media URL that can expire/403 on Railway.
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

    const clientProfiles = ["web_embedded", "default"];
    const failures = [];

    for (const client of clientProfiles) {
      this.destroyStream(guildId);
      try {
        const result = await new Promise((resolve, reject) => {
          const ytArgs = [
            "--no-warnings",
            "--no-progress",
            "--no-playlist",
            "--js-runtimes", "deno",
            "--remote-components", "ejs:github",
            "--extractor-args", `youtube:player_client=${client}`,
            "--retries", "5",
            "--fragment-retries", "5",
            "--retry-sleep", "linear=1::2",
            "--format", "bestaudio/best",
            "--output", "-",
            track.url
          ];

          const yt = spawn(YTDLP, ytArgs, { stdio: ["ignore", "pipe", "pipe"] });
          const ffArgs = [
            "-hide_banner",
            "-loglevel", "warning",
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
          let gotAudio = false;
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
            gotAudio = true;
            if (!settled) success();
          });

          yt.stdout.pipe(ff.stdin);

          yt.on("error", error => fail(error));
          ff.on("error", error => fail(error));

          yt.on("close", code => {
            if (code !== 0 && !gotAudio) {
              const detail = ytStderr.trim().split(/\r?\n/).filter(Boolean).slice(-6).join(" | ");
              return fail(new Error(`yt-dlp ${client} exited with code ${code}: ${detail}`.trim()));
            }
            if (code !== 0) {
              console.warn(`⚠️ yt-dlp ${client} ended with code ${code} after audio started.`);
            }
          });

          ff.on("close", code => {
            if (code !== 0 && !gotAudio) {
              const detail = ffStderr.trim().split(/\r?\n/).filter(Boolean).slice(-4).join(" | ");
              fail(new Error(`FFmpeg ${client} exited with code ${code}: ${detail}`.trim()));
            }
          });

          firstBytesTimer = setTimeout(() => {
            if (gotAudio || player.state.status === AudioPlayerStatus.Buffering || player.state.status === AudioPlayerStatus.Playing) {
              success();
            } else {
              fail(new Error(`No audio bytes received from yt-dlp client ${client} within 8 seconds.`));
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

        // Panel refresh must never delay playback/control interactions.
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

  console.log("🛠️ DEATH direct playback patch loaded: yt-dlp native streaming -> FFmpeg -> Discord.");
}

try {
  const DirectMusicManager = require("./DirectMusicManager");
  installDirectPlaybackPatch(DirectMusicManager);
} catch (error) {
  console.error("❌ Direct playback patch failed to load:", error?.message || error);
}

module.exports = { installDirectPlaybackPatch };

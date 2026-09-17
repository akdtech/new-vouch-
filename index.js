"use strict";

// Legacy compatibility entrypoint.
// DEATH Music 24/7 now uses only @discordjs/voice + yt-dlp + FFmpeg.
// Keep index.js safe so an old Railway start command can never load Lavalink/Kazagumo.
console.log("🎵 DEATH Music 24/7 — redirecting legacy entrypoint to DIRECT VOICE engine.");
require("./index-direct.js");

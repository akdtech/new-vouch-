require("dotenv").config();

module.exports = {
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.CLIENT_ID,
  guildId: process.env.GUILD_ID || "",

  musicVoiceChannelId:
    process.env.MUSIC_VOICE_CHANNEL_ID ||
    "1532082737480077462",

  lavalink: {
    name: process.env.LAVALINK_NAME || "main",
    host: process.env.LAVALINK_HOST || "localhost",
    port: Number(process.env.LAVALINK_PORT || 2333),
    password: process.env.LAVALINK_PASSWORD || "change-this-password",
    secure: String(process.env.LAVALINK_SECURE || "false").toLowerCase() === "true"
  },

  defaultVolume: Math.max(
    1,
    Math.min(100, Number(process.env.DEFAULT_VOLUME || 70))
  ),

  autoplayDefault:
    String(process.env.AUTOPLAY_DEFAULT || "true").toLowerCase() !== "false",

  modLogChannelId: process.env.MOD_LOG_CHANNEL_ID || "",
  welcomeChannelId: process.env.WELCOME_CHANNEL_ID || "",
  autoModEnabled:
    String(process.env.AUTO_MOD_ENABLED || "true").toLowerCase() !== "false"
};

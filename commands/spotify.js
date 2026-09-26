"use strict";
const { SlashCommandBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("spotify")
    .setDescription("Connect and control Spotify Connect playback.")
    .addSubcommand(s => s.setName("connect").setDescription("Connect your Spotify Premium account to this server."))
    .addSubcommand(s => s.setName("status").setDescription("Show the linked Spotify account and current playback."))
    .addSubcommand(s => s.setName("devices").setDescription("Show your available Spotify Connect devices."))
    .addSubcommand(s => s.setName("disconnect").setDescription("Disconnect your Spotify account from this server.")),

  async execute(interaction) {
    const spotify = interaction.client.spotify;
    if (!interaction.guildId) return interaction.reply({ content: "❌ Server only.", ephemeral: true });
    const sub = interaction.options.getSubcommand();

    if (sub === "connect") {
      const url = interaction.client.spotify.authUrl(interaction.user.id, interaction.guildId);
      return interaction.reply({
        content: \`🎧 **Connect Spotify Premium**\n\n[Authorize Spotify](\${url})\n\nAfter authorizing, return to Discord and use **/play**. Playback stays inside Spotify on your active Spotify Connect device — the Discord bot does not stream Spotify audio into the voice channel.\`,
        ephemeral: true
      });
    }

    if (sub === "disconnect") {
      await spotify.disconnect(interaction.user.id);
      if ((await spotify.getGuildController(interaction.guildId))?.discord_user_id === interaction.user.id) {
        await spotify.clearGuild(interaction.guildId);
      }
      return interaction.reply({ content: "✅ Spotify disconnected.", ephemeral: true });
    }

    if (sub === "devices") {
      const devices = await spotify.devices(interaction.user.id);
      if (!devices.length) return interaction.reply({
        content: "❌ No Spotify Connect devices are currently available. Open Spotify on your phone/PC first.",
        ephemeral: true
      });
      const text = devices.map(d =>
        \`\${d.is_active ? "🟢" : "⚪"} **\${d.name}** — \${d.type}\${d.is_restricted ? " (restricted)" : ""}\`
      ).join("\\n");
      return interaction.reply({ content: \`🎧 **Spotify devices**\\n\${text}\`, ephemeral: true });
    }

    const status = await spotify.status(interaction.guildId, interaction.user.id);
    const p = status.playback;
    if (!p?.item) {
      return interaction.reply({
        content: \`🎧 **Spotify connected:** \${status.controller.display_name || "Connected account"}\\n⏸️ Nothing is currently playing.\`,
        ephemeral: true
      });
    }
    const title = p.item.name || "Unknown";
    const artist = (p.item.artists || []).map(a => a.name).join(", ") || "Unknown artist";
    return interaction.reply({
      content: \`🎧 **Spotify:** \${status.controller.display_name || "Connected account"}\\n\${p.is_playing ? "▶️" : "⏸️"} **\${title}** — \${artist}\\n📱 Device: **\${p.device?.name || "Unknown"}**\`,
      ephemeral: true
    });
  }
};

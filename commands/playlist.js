const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("playlist")
    .setDescription("Create and play your saved DEATH music playlists.")
    .addSubcommand(s => s.setName("create").setDescription("Create an empty playlist.").addStringOption(o => o.setName("name").setDescription("Playlist name").setRequired(true)))
    .addSubcommand(s => s.setName("add").setDescription("Add a song to a playlist.").addStringOption(o => o.setName("name").setDescription("Playlist name").setRequired(true)).addStringOption(o => o.setName("song").setDescription("Song, artist or YouTube URL").setRequired(true)))
    .addSubcommand(s => s.setName("play").setDescription("Play a saved playlist.").addStringOption(o => o.setName("name").setDescription("Playlist name").setRequired(true)))
    .addSubcommand(s => s.setName("list").setDescription("List saved playlists."))
    .addSubcommand(s => s.setName("save").setDescription("Save the current queue as a playlist.").addStringOption(o => o.setName("name").setDescription("Playlist name").setRequired(true)))
    .addSubcommand(s => s.setName("delete").setDescription("Delete a playlist.").addStringOption(o => o.setName("name").setDescription("Playlist name").setRequired(true))),

  async execute(interaction, { music }) {
    if (!interaction.guildId) return interaction.reply({ content: "❌ Server only.", ephemeral: true });
    const action = interaction.options.getSubcommand();
    const name = interaction.options.getString("name");

    await interaction.deferReply({ ephemeral: true });
    try {
      if (action === "create") {
        const created = await music.playlistCreate(interaction.guildId, name, interaction.user.id);
        return interaction.editReply(`📚 Created playlist **${created}**.`);
      }

      if (action === "add") {
        const song = interaction.options.getString("song", true);
        const result = await music.search(song, interaction.user);
        const track = result?.tracks?.[0];
        if (!track) throw new Error("Song not found.");
        const position = await music.playlistAdd(interaction.guildId, name, track);
        return interaction.editReply(`➕ Added **${music.getTrackTitle(track)}** to **${String(name).toLowerCase()}** at #${position}.`);
      }

      if (action === "play") {
        const result = await music.playlistPlay(interaction.guildId, name);
        return interaction.editReply(result.startedNow ? `▶️ Playing playlist **${String(name).toLowerCase()}** — ${result.count} tracks loaded.` : `📚 Added playlist **${String(name).toLowerCase()}** to the queue.`);
      }

      if (action === "list") {
        const rows = await music.playlistList(interaction.guildId);
        if (!rows.length) return interaction.editReply("📚 You have no saved playlists yet. Use `/playlist create` to make one.");
        const text = rows.map((r,i) => `${i + 1}. **${r.name}** — ${r.tracks} track${r.tracks === 1 ? "" : "s"}`).join("\n");
        return interaction.editReply({ embeds: [new EmbedBuilder().setTitle("📚 DEATH Playlists").setDescription(text).setFooter({ text: "DEATH × GMAO • Persistent playlists" })] });
      }

      if (action === "save") {
        const result = await music.playlistSaveQueue(interaction.guildId, name, interaction.user.id);
        return interaction.editReply(`💾 Saved **${result.count}** tracks to playlist **${result.name}**.`);
      }

      if (action === "delete") {
        const deleted = await music.playlistDelete(interaction.guildId, name);
        return interaction.editReply(`🗑️ Deleted playlist **${deleted}**.`);
      }
    } catch (error) {
      console.error("❌ /playlist:", error);
      return interaction.editReply(`❌ ${error?.message || "Playlist operation failed."}`);
    }
  }
};

const { SlashCommandBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("loop")
    .setDescription("Set music loop mode.")
    .addStringOption(option =>
      option
        .setName("mode")
        .setDescription("Loop mode")
        .setRequired(true)
        .addChoices(
          { name: "Off", value: "none" },
          { name: "Current Track", value: "track" },
          { name: "Queue", value: "queue" }
        )
    ),

  async execute(interaction, { music }) {
    const mode = interaction.options.getString("mode", true);
    const result = await music.setLoop(interaction.guildId, mode);
    return interaction.reply(`🔁 Loop mode: **${result}**`);
  }
};

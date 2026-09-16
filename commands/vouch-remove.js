"use strict";

const {
  SlashCommandBuilder,
  PermissionFlagsBits
} = require("discord.js");
const { query } = require("../db");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("vouch-remove")
    .setDescription("Remove a vouch from this server (Administrator only).")
    .setDMPermission(false)
    .addIntegerOption(option =>
      option
        .setName("id")
        .setDescription("The vouch ID to remove")
        .setRequired(true)
        .setMinValue(1)
    ),

  async execute(interaction) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({
        content: "❌ Only a server Administrator can remove vouches.",
        ephemeral: true
      });
    }

    const id = interaction.options.getInteger("id", true);

    try {
      const result = await query(
        `DELETE FROM vouches
         WHERE id = $1 AND guild_discord_id = $2
         RETURNING id, vouched_discord_id`,
        [id, interaction.guildId]
      );

      if (!result.rowCount) {
        return interaction.reply({
          content: `❌ Vouch #${id} was not found in this server.`,
          ephemeral: true
        });
      }

      return interaction.reply(`🗑️ Vouch **#${id}** for <@${result.rows[0].vouched_discord_id}> was removed.`);
    } catch (error) {
      console.error("❌ /vouch-remove database error:", error);
      return interaction.reply({
        content: "❌ I couldn't remove that vouch.",
        ephemeral: true
      });
    }
  }
};

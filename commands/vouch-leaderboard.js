"use strict";

const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const { query } = require("../db");

const GMAO_PURPLE = 0x8B5CF6;

module.exports = {
  data: new SlashCommandBuilder()
    .setName("vouch-leaderboard")
    .setDescription("Show the most vouched members in this server.")
    .setDMPermission(false),

  async execute(interaction) {
    try {
      const result = await query(
        `SELECT vouched_discord_id,
                COUNT(*)::int AS count,
                AVG(stars)::numeric(10,2) AS average
         FROM vouches
         WHERE guild_discord_id = $1
         GROUP BY vouched_discord_id
         ORDER BY count DESC, average DESC
         LIMIT 10`,
        [interaction.guildId]
      );

      const lines = result.rows.length
        ? result.rows.map((row, index) => {
            const medals = ["🥇", "🥈", "🥉"];
            const rank = medals[index] || `**#${index + 1}**`;
            return `${rank} <@${row.vouched_discord_id}> — **${row.count}** vouches • **${Number(row.average).toFixed(2)}/5** ⭐`;
          }).join("\n")
        : "No vouches have been recorded in this server yet.";

      const embed = new EmbedBuilder()
        .setColor(GMAO_PURPLE)
        .setTitle("💎 | GMAO Vouch Leaderboard")
        .setDescription(lines)
        .setFooter({ text: "DEATH Music 24/7 • GMAO" })
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });
    } catch (error) {
      console.error("❌ /vouch-leaderboard database error:", error);
      return interaction.reply({
        content: "❌ I couldn't load the vouch leaderboard. Check PostgreSQL configuration.",
        ephemeral: true
      });
    }
  }
};

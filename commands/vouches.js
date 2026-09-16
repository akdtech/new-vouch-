"use strict";

const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const { query } = require("../db");

const GMAO_PURPLE = 0x8B5CF6;

function starBar(average) {
  const rounded = Math.max(0, Math.min(5, Math.round(Number(average))));
  return "⭐".repeat(rounded) + "☆".repeat(5 - rounded);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("vouches")
    .setDescription("View a member's GMAO vouch profile.")
    .setDMPermission(false)
    .addUserOption(option =>
      option
        .setName("user")
        .setDescription("Member whose vouches you want to view")
        .setRequired(true)
    ),

  async execute(interaction) {
    const target = interaction.options.getUser("user", true);

    try {
      const summary = await query(
        `SELECT COUNT(*)::int AS count,
                COALESCE(AVG(stars), 0)::numeric(10,2) AS average
         FROM vouches
         WHERE guild_discord_id = $1
           AND vouched_discord_id = $2`,
        [interaction.guildId, target.id]
      );

      const recent = await query(
        `SELECT voucher_discord_id, stars, review, created_at
         FROM vouches
         WHERE guild_discord_id = $1
           AND vouched_discord_id = $2
         ORDER BY created_at DESC
         LIMIT 5`,
        [interaction.guildId, target.id]
      );

      const stats = summary.rows[0];
      const recentText = recent.rows.length
        ? recent.rows.map((row, index) => {
            const review = String(row.review).slice(0, 180).replace(/@everyone|@here/gi, "@ mention");
            return `**${index + 1}. ${"⭐".repeat(row.stars)}** — <@${row.voucher_discord_id}>\n> ${review}`;
          }).join("\n\n")
        : "No vouches yet. Be the first to leave one with `/vouch`.";

      const embed = new EmbedBuilder()
        .setColor(GMAO_PURPLE)
        .setTitle("💎 | GMAO Vouch Profile")
        .setDescription(`Trusted feedback for <@${target.id}>`)
        .setThumbnail(target.displayAvatarURL({ size: 256 }))
        .addFields(
          {
            name: "👤 Member",
            value: `<@${target.id}>`,
            inline: true
          },
          {
            name: "⭐ Rating",
            value: `${starBar(stats.average)}\n**${Number(stats.average).toFixed(2)}/5**`,
            inline: true
          },
          {
            name: "📊 Total Vouches",
            value: `**${stats.count}**`,
            inline: true
          },
          {
            name: "💬 Recent Reviews",
            value: recentText.slice(0, 1024),
            inline: false
          }
        )
        .setFooter({ text: "DEATH Music 24/7 • GMAO" })
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });
    } catch (error) {
      console.error("❌ /vouches database error:", error);
      return interaction.reply({
        content: "❌ I couldn't load the vouch profile. Check PostgreSQL configuration.",
        ephemeral: true
      });
    }
  }
};

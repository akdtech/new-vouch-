"use strict";

const {
  SlashCommandBuilder,
  EmbedBuilder
} = require("discord.js");
const { query } = require("../db");

const GMAO_PURPLE = 0x8B5CF6;
const VOUCH_CHANNEL_ID = "1532143368623227061";

function stars(value) {
  return "⭐".repeat(value) + "☆".repeat(5 - value);
}

function safeReview(text) {
  return String(text || "")
    .replace(/@everyone/gi, "@ everyone")
    .replace(/@here/gi, "@ here")
    .trim()
    .slice(0, 1000);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("vouch")
    .setDescription("Leave a verified vouch and rating for a server member.")
    .setDMPermission(false)
    .addUserOption(option =>
      option
        .setName("user")
        .setDescription("Member you are vouching for")
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option
        .setName("stars")
        .setDescription("Your rating")
        .setRequired(true)
        .addChoices(
          { name: "1 star", value: 1 },
          { name: "2 stars", value: 2 },
          { name: "3 stars", value: 3 },
          { name: "4 stars", value: 4 },
          { name: "5 stars", value: 5 }
        )
    )
    .addStringOption(option =>
      option
        .setName("review")
        .setDescription("Your review")
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(1000)
    ),

  async execute(interaction) {
    if (!interaction.guildId) {
      return interaction.reply({
        content: "❌ This command can only be used inside a server.",
        ephemeral: true
      });
    }

    const target = interaction.options.getUser("user", true);
    const rating = interaction.options.getInteger("stars", true);
    const review = safeReview(interaction.options.getString("review", true));

    if (target.id === interaction.user.id) {
      return interaction.reply({
        content: "❌ You cannot vouch for yourself.",
        ephemeral: true
      });
    }

    if (target.bot) {
      return interaction.reply({
        content: "❌ You cannot vouch for a bot.",
        ephemeral: true
      });
    }

    const member = await interaction.guild.members.fetch(target.id).catch(() => null);
    if (!member) {
      return interaction.reply({
        content: "❌ That user is not a member of this server.",
        ephemeral: true
      });
    }

    if (!review || rating < 1 || rating > 5) {
      return interaction.reply({
        content: "❌ Choose a rating from 1–5 stars and write a review.",
        ephemeral: true
      });
    }

    try {
      const existing = await query(
        `SELECT id FROM vouches
         WHERE guild_discord_id = $1
           AND voucher_discord_id = $2
           AND vouched_discord_id = $3
         LIMIT 1`,
        [interaction.guildId, interaction.user.id, target.id]
      );

      if (existing.rowCount) {
        return interaction.reply({
          content: "⚠️ You have already vouched for this member in this server.",
          ephemeral: true
        });
      }

      const inserted = await query(
        `INSERT INTO vouches
          (voucher_discord_id, vouched_discord_id, guild_discord_id, stars, review)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [interaction.user.id, target.id, interaction.guildId, rating, review]
      );

      const insertedId = inserted.rows[0].id;

      const summary = await query(
        `SELECT
           COUNT(*)::int AS count,
           COALESCE(AVG(stars), 0)::numeric(10,2) AS average
         FROM vouches
         WHERE guild_discord_id = $1
           AND vouched_discord_id = $2`,
        [interaction.guildId, target.id]
      );

      const stats = summary.rows[0];
      const memberTag = member.user.tag || member.user.username;

      const embed = new EmbedBuilder()
        .setColor(GMAO_PURPLE)
        .setTitle("💎 | Verified Member Vouch")
        .setDescription(
          "A new community vouch has been recorded successfully.\n\n" +
          "Thank you for helping GMAO maintain a trusted community."
        )
        .setThumbnail(target.displayAvatarURL({ size: 256 }))
        .addFields(
          {
            name: "👤 Member",
            value: `<@${target.id}>\n\`${memberTag}\``,
            inline: true
          },
          {
            name: "⭐ Rating",
            value: `${stars(rating)}\n**${rating}/5**`,
            inline: true
          },
          {
            name: "🛡️ Status",
            value: "✅ Verified Member",
            inline: true
          },
          {
            name: "💬 Review",
            value: `> ${review}`,
            inline: false
          },
          {
            name: "👤 Vouched by",
            value: `<@${interaction.user.id}>`,
            inline: true
          },
          {
            name: "📅 Date",
            value: `<t:${Math.floor(Date.now() / 1000)}:d>`,
            inline: true
          },
          {
            name: "📊 Total Vouches",
            value: `**${stats.count}**`,
            inline: true
          },
          {
            name: "🆔 Vouch ID",
            value: `**${insertedId}**`,
            inline: true
          },
          {
            name: "📈 Average",
            value: `**${Number(stats.average).toFixed(2)}/5**`,
            inline: true
          }
        )
        .setFooter({
          text: "DEATH Music 24/7 • GMAO"
        })
        .setTimestamp();

      const vouchChannel = await interaction.guild.channels.fetch(VOUCH_CHANNEL_ID).catch(() => null);

      if (!vouchChannel || !vouchChannel.isTextBased()) {
        console.error(`❌ Vouch channel ${VOUCH_CHANNEL_ID} was not found or is not text-based.`);
        return interaction.reply({
          content: "❌ The vouch channel is not available. Please contact an administrator.",
          ephemeral: true
        });
      }

      await vouchChannel.send({
        content: `💎 <@${target.id}> received a new GMAO vouch!`,
        allowedMentions: { users: [target.id] },
        embeds: [embed]
      });

      return interaction.reply({
        content: `✅ Your vouch has been submitted and posted in <#${VOUCH_CHANNEL_ID}>.`,
        ephemeral: true
      });
    } catch (error) {
      console.error("❌ /vouch database error:", error);
      return interaction.reply({
        content: "❌ I couldn't save the vouch. Check the bot's PostgreSQL configuration.",
        ephemeral: true
      });
    }
  }
};

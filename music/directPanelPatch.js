"use strict";

/* DEATH Music 24/7 — focused, polished player panel. */
const MusicManager = require("./DirectMusicManager");
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { AudioPlayerStatus } = require("@discordjs/voice");

if (!MusicManager.prototype.__deathDirectPanelPatched) {
  MusicManager.prototype.__deathDirectPanelPatched = true;

  const clean = value => String(value || "").replace(/\s+/g, " ").trim();
  const format = (ms = 0) => {
    const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
  };
  const bar = (position, duration) => {
    const slots = 18;
    if (!duration) return "━━━━━━━━━━━━━━━━━━";
    const ratio = Math.max(0, Math.min(1, position / duration));
    const filled = Math.min(slots - 1, Math.floor(ratio * slots));
    return `${"━".repeat(filled)}●${"━".repeat(Math.max(0, slots - filled - 1))}`;
  };
  const btn = (id, label, emoji, style = ButtonStyle.Secondary, disabled = false) =>
    new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji(emoji).setStyle(style).setDisabled(disabled);

  const renderPanel = async function renderPanel(guildId) {
    const state = this.getState(guildId);
    const channel = await this.findPanelChannel(guildId);
    if (!channel) throw new Error("Music panel channel is not available.");

    const current = state.current;
    const player = this.players.get(guildId);
    const playing = Boolean(current && player?.state.status === AudioPlayerStatus.Playing && !state.paused);
    const paused = Boolean(current && (state.paused || player?.state.status === AudioPlayerStatus.Paused));
    const queued = state.queue.length;
    const volume = Number(state.volume || this.defaultVolume);
    const duration = Number(current?.length || 0);
    const position = this.getPosition(guildId);
    const title = clean(current?.title) || "Nothing is playing";
    const author = clean(current?.author || current?.uploader) || "DEATH Music 24/7";
    const auto = Boolean(state.autoplay);
    const relation = clean(current?.autoplayGroup) || (current?.isAutoplay ? "Related music" : "Manual selection");

    const embed = new EmbedBuilder()
      .setTitle("💀 DEATH MUSIC • 24/7")
      .setDescription(
        `### ${title}\n` +
        `🎤 **${author}**\n` +
        `> ${current?.isAutoplay ? "♾️ Autoplay • " : "🎧 Manual • "}${relation}\n\n` +
        `\`${bar(position, duration)}\`\n` +
        `\`${format(position)}\` / \`${format(duration)}\`  •  ${paused ? "⏸️ Paused" : playing ? "▶️ Playing" : "⏹️ Ready"}`
      )
      .addFields(
        { name: "🔊 Volume", value: `**${volume}%**`, inline: true },
        { name: "📜 Queue", value: `**${queued}**`, inline: true },
        { name: "♾️ Autoplay", value: auto ? "**ON**" : "OFF", inline: true }
      )
      .setFooter({ text: "DEATH × GMAO  •  Music 24/7  •  Made by DEATH" });

    if (current?.thumbnail && /^https?:\/\//i.test(current.thumbnail)) {
      try { embed.setThumbnail(current.thumbnail); } catch {}
    }

    const row1 = new ActionRowBuilder().addComponents(
      btn("death_music_pause", "Pause", "⏸️", ButtonStyle.Secondary, !current || paused),
      btn("death_music_resume", "Play", "▶️", ButtonStyle.Success, !current || !paused),
      btn("death_music_skip", "Skip", "⏭️", ButtonStyle.Primary, !current),
      btn("death_music_queue", "Queue", "📜")
    );
    const row2 = new ActionRowBuilder().addComponents(
      btn("death_music_autoplay", auto ? "Autoplay ON" : "Autoplay OFF", "♾️", auto ? ButtonStyle.Success : ButtonStyle.Secondary),
      btn("death_music_vol_down", "Volume −", "🔉"),
      btn("death_music_vol_up", "Volume +", "🔊")
    );

    const payload = { embeds: [embed], components: [row1, row2] };
    let message = null;
    if (state.panelMessageId && state.panelChannelId === channel.id) {
      try { message = await channel.messages.fetch(state.panelMessageId); } catch { message = null; }
    }
    if (message) await message.edit(payload);
    else {
      message = await channel.send(payload);
      state.panelMessageId = message.id;
      state.panelChannelId = channel.id;
    }
    return message;
  };

  MusicManager.prototype.ensurePanel = renderPanel;
  MusicManager.prototype.refreshPanel = function refreshPanel(guildId) {
    return renderPanel.call(this, guildId).catch(() => null);
  };

  console.log("🎨 DEATH stylish music panel loaded: 7 focused controls.");
}

module.exports = MusicManager;

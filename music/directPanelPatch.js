"use strict";

/* DEATH Music 24/7 — one persistent, live-synced player UI. */
const MusicManager = require("./DirectMusicManager");
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { AudioPlayerStatus } = require("@discordjs/voice");

if (!MusicManager.prototype.__deathDirectPanelPatched) {
  MusicManager.prototype.__deathDirectPanelPatched = true;

  const clean = value => String(value || "").replace(/\s+/g, " ").trim();
  const format = ms => {
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
  const button = (id, label, emoji, style = ButtonStyle.Secondary, disabled = false) =>
    new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji(emoji).setStyle(style).setDisabled(disabled);

  const isDeathPanel = message => {
    if (!message?.author?.id) return false;
    const title = clean(message.embeds?.[0]?.title);
    const titleMatch = /DEATH\s+MUSIC\s*[•·-]?\s*24\/7/i.test(title) || /DEATH\s+Music\s+24\/7/i.test(title);
    const componentMatch = message.components?.some(row =>
      row.components?.some(component => String(component.customId || "").startsWith("death_music_"))
    );
    return message.author.id === thisClientId(message) && (titleMatch || componentMatch);
  };

  // Kept separate so isDeathPanel can safely compare against the current bot.
  const thisClientId = message => message?.client?.user?.id || message?.author?.client?.user?.id || null;

  MusicManager.prototype.ensurePanel = async function stickyEnsurePanel(guildId) {
    const state = this.getState(guildId);
    if (state.panelEditPromise) return state.panelEditPromise;

    const run = async () => {
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
      const title = clean(current?.title) || (state.transitioning ? "Loading next track…" : "Nothing is playing");
      const author = clean(current?.author || current?.uploader) || "DEATH Music 24/7";
      const auto = Boolean(state.autoplay);
      const mode = current?.isAutoplay ? "♾️ Related autoplay" : "🎧 Manual selection";

      const embed = new EmbedBuilder()
        .setTitle("💀 DEATH MUSIC • 24/7")
        .setDescription(
          `### ${title}\n` +
          `🎤 **${author}**\n` +
          `> ${mode}\n\n` +
          `\`${bar(position, duration)}\`\n` +
          `\`${format(position)}\` / \`${format(duration)}\`  •  ${paused ? "⏸️ Paused" : playing ? "▶️ Playing" : state.transitioning ? "⏳ Loading" : "⏹️ Ready"}`
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
        button("death_music_pause", "Pause", "⏸️", ButtonStyle.Secondary, !current || paused || state.transitioning),
        button("death_music_resume", "Play", "▶️", ButtonStyle.Success, !current || !paused || state.transitioning),
        button("death_music_skip", "Skip", "⏭️", ButtonStyle.Primary, !current || state.transitioning),
        button("death_music_queue", "Queue", "📜")
      );
      const row2 = new ActionRowBuilder().addComponents(
        button("death_music_autoplay", auto ? "Autoplay ON" : "Autoplay OFF", "♾️", auto ? ButtonStyle.Success : ButtonStyle.Secondary),
        button("death_music_vol_down", "Volume −", "🔉"),
        button("death_music_vol_up", "Volume +", "🔊")
      );

      const payload = { embeds: [embed], components: [row1, row2] };
      let message = null;

      if (state.panelMessageId && state.panelChannelId === channel.id) {
        try { message = await channel.messages.fetch(state.panelMessageId); } catch { message = null; }
      }

      if (!message) {
        const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
        const panels = messages
          ? [...messages.values()].filter(m => {
              if (m.author?.id !== this.client.user.id) return false;
              const title = clean(m.embeds?.[0]?.title);
              const titleMatch = /DEATH\s+MUSIC\s*[•·-]?\s*24\/7/i.test(title) || /DEATH\s+Music\s+24\/7/i.test(title);
              const componentMatch = m.components?.some(row => row.components?.some(component => String(component.customId || "").startsWith("death_music_")));
              return titleMatch || componentMatch;
            })
          : [];

        message = panels[0] || null;
        if (message) {
          state.panelMessageId = message.id;
          state.panelChannelId = channel.id;
          for (const duplicate of panels.slice(1)) {
            try { await duplicate.delete(); } catch {}
          }
        }
      }

      if (message) {
        await message.edit(payload);
      } else {
        message = await channel.send(payload);
        state.panelMessageId = message.id;
        state.panelChannelId = channel.id;
      }
      return message;
    };

    const previous = state.panelEditPromise || Promise.resolve();
    const next = previous.catch(() => {}).then(run);
    state.panelEditPromise = next.finally(() => {
      if (state.panelEditPromise === next) state.panelEditPromise = null;
    });
    return state.panelEditPromise;
  };

  console.log("🎨 DEATH live panel loaded: one sticky message + serialized sync + 7 focused controls.");
}

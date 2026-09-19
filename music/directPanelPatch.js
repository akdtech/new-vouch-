"use strict";

/* DEATH Music 24/7 — one persistent, pinned, live-synced player UI. */
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
  const button = (id, label, emoji, style = ButtonStyle.Secondary) =>
    new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji(emoji).setStyle(style).setDisabled(false);

  MusicManager.prototype.ensurePanel = async function stickyEnsurePanel(guildId) {
    const state = this.getState(guildId);
    if (state.panelEditPromise) return state.panelEditPromise;

    const run = async () => {
      const channel = await this.findPanelChannel(guildId);
      if (!channel) throw new Error("Music panel channel is not available.");

      const player = this.players.get(guildId);
      const liveTrack = player?.state?.resource?.metadata;
      const current = liveTrack || state.current;
      if (liveTrack && liveTrack !== state.current) state.current = liveTrack;

      const playing = Boolean(current && player?.state.status === AudioPlayerStatus.Playing && !state.paused);
      const buffering = Boolean(current && player?.state.status === AudioPlayerStatus.Buffering);
      const paused = Boolean(current && (state.paused || player?.state.status === AudioPlayerStatus.Paused));
      const queued = state.queue.length;
      const volume = Number(state.volume || this.defaultVolume);
      const duration = Number(current?.length || 0);
      const position = this.getPosition(guildId);
      const title = clean(current?.title) || (state.transitioning ? "Loading next track…" : "Nothing is playing");
      const author = clean(current?.author || current?.uploader) || "DEATH Music 24/7";
      const auto = Boolean(state.autoplay);
      const mode = current?.isAutoplay ? "♾️ Related autoplay" : "🎧 Manual selection";
      const status = paused ? "⏸️ Paused" : playing ? "▶️ Playing" : buffering ? "⏳ Buffering" : state.transitioning ? "⏳ Loading" : "⏹️ Ready";

      const embed = new EmbedBuilder()
        .setColor(0x6C5CE7)
        .setAuthor({ name: "💀 DEATH MUSIC 24/7", iconURL: this.client.user.displayAvatarURL() })
        .setTitle(title)
        .setDescription(
          `🎤 **${author}**\n` +
          `> ${mode}\n\n` +
          `\`${bar(position, duration)}\`\n` +
          `\`${format(position)}\` / \`${format(duration)}\`  •  **${status}**`
        )
        .addFields(
          { name: "🔊 Volume", value: `**${volume}%**`, inline: true },
          { name: "📜 Queue", value: `**${queued}**`, inline: true },
          { name: "♾️ Autoplay", value: auto ? "**ON**" : "OFF", inline: true }
        )
        .setFooter({ text: "DEATH × GMAO  •  24/7 Music  •  Made by DEATH" })
        .setTimestamp();

      if (current?.thumbnail && /^https?:\/\//i.test(current.thumbnail)) {
        try { embed.setImage(current.thumbnail); } catch {}
      }

      // Never disable the controls. A persistent music panel should remain
      // clickable even for a few seconds while the next source is loading.
      // The handlers below safely turn a click into the appropriate recovery
      // action instead of leaving users with dead-looking buttons.
      const row1 = new ActionRowBuilder().addComponents(
        button("death_music_pause", "Pause", "⏸️", ButtonStyle.Secondary),
        button("death_music_resume", "Play", "▶️", ButtonStyle.Success),
        button("death_music_skip", "Skip", "⏭️", ButtonStyle.Primary),
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
              const author = clean(m.embeds?.[0]?.author?.name);
              const titleMatch = /DEATH\s+MUSIC\s*[•·-]?\s*24\/7/i.test(title) || /DEATH\s+Music\s+24\/7/i.test(title);
              const authorMatch = /DEATH\s+MUSIC\s+24\/7/i.test(author);
              const componentMatch = m.components?.some(row => row.components?.some(component => String(component.customId || "").startsWith("death_music_")));
              return titleMatch || authorMatch || componentMatch;
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

      if (message) await message.edit(payload);
      else {
        message = await channel.send(payload);
        state.panelMessageId = message.id;
        state.panelChannelId = channel.id;
      }

      if (message && !message.pinned) {
        await message.pin("DEATH Music 24/7 persistent control panel").catch(() => {});
      }
      return message;
    };

    const previous = state.panelEditPromise || Promise.resolve();
    const next = previous.catch(() => {}).then(run);
    let wrapped;
    wrapped = next.finally(() => {
      if (state.panelEditPromise === wrapped) state.panelEditPromise = null;
    });
    state.panelEditPromise = wrapped;
    return wrapped;
  };

  MusicManager.prototype.refreshPanel = async function deathRichRefreshPanel(guildId) {
    try {
      await this.ensurePanel(guildId);
      return true;
    } catch (error) {
      console.warn(`⚠️ Rich music panel refresh failed: ${error?.message || error}`);
      return false;
    }
  };

  console.log("🎨 DEATH rich sticky panel loaded: ONE live message + artwork + 7 focused controls; buttons always interactive.");
}

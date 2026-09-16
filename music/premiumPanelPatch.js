"use strict";

/*
 * Premium DEATH Music 24/7 panel.
 * Keeps the existing MusicManager controls, but presents them
 * in a cleaner, easier-to-use player layout.
 */
const Module = require("module");
const originalLoad = Module._load;
let patched = false;

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function format(ms = 0) {
  const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function progress(position, duration) {
  if (!duration || duration <= 0) return "━━━━━━━━━━━━━━━━━━";
  const ratio = Math.max(0, Math.min(1, position / duration));
  const slots = 18;
  const filled = Math.min(slots - 1, Math.floor(ratio * slots));
  return `${"━".repeat(filled)}🔘${"━".repeat(Math.max(0, slots - filled - 1))}`;
}

Module._load = function(request, parent, isMain) {
  const exported = originalLoad.apply(this, arguments);

  if (
    !patched &&
    typeof exported === "function" &&
    /(^|[\\/])music[\\/]MusicManager$/.test(request)
  ) {
    patched = true;

    exported.prototype.buildPanelPayload = function(guildId) {
      const player = this.getPlayer(guildId);
      const state = this.getState(guildId);
      const current = player?.queue?.current || null;

      const title = clean(current ? this.getTrackTitle(current) : "Nothing is playing");
      const author = clean(current ? this.getTrackAuthor(current) : "DEATH Music 24/7");
      const duration = Number(current?.info?.length || current?.length || 0);
      const position = Number(player?.position || 0);
      const volume = Number(player?.volume ?? this.defaultVolume);
      const queued = Math.max(0, Number(player?.queue?.length || 0));
      const paused = Boolean(player?.paused);
      const playing = Boolean(player?.playing || current) && !paused;

      const status = paused ? "⏸️ PAUSED" : playing ? "▶️ PLAYING" : "⏹️ IDLE";
      const loop = state.loop === "track" ? "Track" : state.loop === "queue" ? "Queue" : "Off";
      const auto = state.autoplay ? "ON" : "OFF";

      const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");

      const embed = new EmbedBuilder()
        .setTitle("🎵 DEATH Music 24/7")
        .setDescription(
          `**${title}**\n` +
          `🎤 **${author}**\n\n` +
          `\`${progress(position, duration)}\`\n` +
          `\`${format(position)} / ${format(duration)}\`  •  **${status}**`
        )
        .addFields(
          { name: "👤 Requested By", value: "Music Player", inline: true },
          { name: "🔊 Volume", value: `${volume}%`, inline: true },
          { name: "📜 Queue", value: `${queued} queued`, inline: true },
          { name: "🔁 Loop", value: loop, inline: true },
          { name: "♾️ AutoPlay", value: auto, inline: true },
          { name: "♾️ 24/7", value: state.permanent ? "Connected" : "Off", inline: true }
        )
        .setFooter({ text: "DEATH × GMAO • Use /play <song> or the controls below" });

      const button = (id, label, emoji, style = ButtonStyle.Secondary, disabled = false) =>
        new ButtonBuilder()
          .setCustomId(id)
          .setLabel(label)
          .setEmoji(emoji)
          .setStyle(style)
          .setDisabled(disabled);

      const row1 = new ActionRowBuilder().addComponents(
        button("death_music_vol_down", "Down", "🔉"),
        button("death_music_pause", "Pause", "⏸️", ButtonStyle.Primary, !current || paused),
        button("death_music_resume", "Resume", "▶️", ButtonStyle.Success, !current || !paused),
        button("death_music_skip", "Skip", "⏭️", ButtonStyle.Primary, !current),
        button("death_music_stop", "Stop", "⏹️", ButtonStyle.Danger, !current)
      );

      const row2 = new ActionRowBuilder().addComponents(
        button("death_music_vol_up", "Up", "🔊"),
        button("death_music_shuffle", "Shuffle", "🔀", ButtonStyle.Secondary, queued < 2),
        button("death_music_loop", `Loop: ${loop}`, "🔁"),
        button("death_music_autoplay", `AutoPlay: ${auto}`, "♾️", state.autoplay ? ButtonStyle.Success : ButtonStyle.Secondary),
        button("death_music_queue", "Queue", "📜")
      );

      const row3 = new ActionRowBuilder().addComponents(
        button("death_music_refresh", "Refresh", "🔄"),
        button("death_music_queue", "View Queue", "📋")
      );

      return { embeds: [embed], components: [row1, row2, row3] };
    };
  }

  return exported;
};

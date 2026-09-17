const { SlashCommandBuilder } = require("discord.js");

function userSafeMusicError(error) {
  const raw = String(error?.message || "Music error.");
  const lower = raw.toLowerCase();
  if (lower.includes("sign in to confirm") || lower.includes("not a bot")) {
    return "❌ YouTube is blocking this Railway source right now. DEATH Music is automatically switching to another playback source.";
  }
  if (lower.includes("no playable music source")) {
    return "❌ I couldn't get a playable audio source for that song right now. Autoplay recovery is still active.";
  }
  const compact = raw.replace(/\s+/g, " ").trim();
  return `❌ ${compact.slice(0, 1800)}${compact.length > 1800 ? "…" : ""}`;
}

function resultText(result, music) {
  const track = result?.track || result?.tracks?.[0];
  const title = music.getTrackTitle(track);
  if (result?.type === "playlist") {
    return result.startedNow
      ? `▶️ **Starting playlist:** ${result.tracks.length} tracks`
      : `🎵 **Added playlist to queue:** ${result.tracks.length} tracks`;
  }
  return result?.startedNow
    ? `▶️ **Now playing:** ${title}`
    : `🎵 **Added to queue:** ${title}`;
}

async function safeEdit(interaction, content) {
  try { return await interaction.editReply(content); }
  catch (error) {
    if (error?.code === 10008) { try { return await interaction.followUp(content); } catch {} }
    throw error;
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("play")
    .setDescription("Add a song or playlist to DEATH Music 24/7.")
    .addStringOption(option => option
      .setName("query")
      .setDescription("Song name, artist, YouTube URL or playlist")
      .setRequired(true)),

  async execute(interaction, { music }) {
    if (!interaction.guildId) return interaction.reply({ content: "❌ Server only.", ephemeral: true });

    const query = interaction.options.getString("query", true).trim();
    await interaction.deferReply();

    // Never leave Discord showing the command as "thinking" while a source
    // provider is recovering. The actual playback promise keeps running.
    const playback = music.play({
      guildId: interaction.guildId,
      voiceId: interaction.member?.voice?.channelId || music.getPermanentVoiceChannelId(),
      textId: interaction.channelId,
      query,
      requester: interaction.user
    });

    let timedOut = false;
    const early = await Promise.race([
      playback.then(result => ({ result })).catch(error => ({ error })),
      new Promise(resolve => setTimeout(() => resolve({ loading: true }), 1200))
    ]);

    if (early.loading) {
      await safeEdit(interaction, `⏳ **Loading:** ${query}\n🎵 DEATH Music is finding the fastest available audio source…`);
      playback.then(async result => {
        try { await safeEdit(interaction, resultText(result, music)); }
        catch (error) { if (error?.code !== 10008) console.error("❌ /play late response:", error); }
      }).catch(async error => {
        console.error("❌ /play:", error);
        try { await safeEdit(interaction, userSafeMusicError(error)); } catch {}
        try {
          const state = music.getState(interaction.guildId);
          if (!state.current && state.autoplay && !state.intentionalLeave) music.autoplayNext(interaction.guildId).catch(() => {});
        } catch {}
      });
      return;
    }

    if (early.error) {
      console.error("❌ /play:", early.error);
      return safeEdit(interaction, userSafeMusicError(early.error));
    }

    return safeEdit(interaction, resultText(early.result, music));
  }
};

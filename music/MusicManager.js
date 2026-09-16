"use strict";

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require("discord.js");

const DEFAULT_VOICE_CHANNEL = "1532082737480077462";

const AUTOPLAY_SEARCHES = [
  "popular music 2026",
  "top hits",
  "chill music",
  "gaming music",
  "night drive music",
  "electronic music",
  "hip hop hits",
  "pop hits",
  "rnb hits",
  "rock classics",
  "dance music",
  "lofi beats",
  "arabic hits",
  "throwback hits"
];

class MusicManager {
  constructor(kazagumo, client, config = {}) {
    this.kazagumo = kazagumo;
    this.client = client;
    this.config = config;

    this.players = new Map();
    this.states = new Map();

    this.searchCache = new Map();
    this.recentTracks = new Map();
    this.autoplayBusy = new Set();

    this.recoveryStarted = false;
    this.recoveryTimer = null;

    this.musicVoiceChannelId =
      process.env.MUSIC_VOICE_CHANNEL_ID ||
      config.musicVoiceChannelId ||
      DEFAULT_VOICE_CHANNEL;

    this.musicTextChannelId =
      process.env.MUSIC_TEXT_CHANNEL_ID ||
      config.musicTextChannelId ||
      "";

    this.musicGuildId =
      process.env.GUILD_ID ||
      config.guildId ||
      "";

    this.defaultAutoplay =
      String(
        process.env.AUTOPLAY_DEFAULT ??
        config.autoplayDefault ??
        "true"
      ).toLowerCase() !== "false";

    this.defaultVolume = Math.max(
      1,
      Math.min(
        100,
        Number(
          process.env.DEFAULT_VOLUME ||
          config.defaultVolume ||
          70
        )
      )
    );

    this.setupEvents();
  }

  // ============================================================
  // STATE
  // ============================================================

  getState(guildId) {
    if (!this.states.has(guildId)) {
      this.states.set(guildId, {
        autoplay: this.defaultAutoplay,
        loop: "none",
        permanent: guildId === this.musicGuildId,

        lastVoiceStatus: "",

        panelMessageId: null,
        panelChannelId: null,

        autoplayGeneration: 0,

        currentTitle: "",
        currentAuthor: "",
        currentStartedAt: 0
      });
    }

    return this.states.get(guildId);
  }

  getPermanentVoiceChannelId() {
    return this.musicVoiceChannelId;
  }

  getPermanentGuildId() {
    return this.musicGuildId;
  }

  getPlayer(guildId) {
    return this.kazagumo?.players?.get(guildId) || null;
  }

  getQueue(guildId) {
    const player = this.getPlayer(guildId);

    if (!player) return [];

    const queued = Array.isArray(player.queue)
      ? [...player.queue]
      : [...(player.queue?.items || [])];

    return player.queue?.current
      ? [player.queue.current, ...queued]
      : queued;
  }

  getCurrent(guildId) {
    return this.getPlayer(guildId)?.queue?.current || null;
  }

  // ============================================================
  // HELPERS
  // ============================================================

  cleanQuery(query) {
    return String(query || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  isYouTubeUrl(query) {
    return /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(
      query
    );
  }

  extractYouTubeId(query) {
    try {
      const url = new URL(query);

      if (url.hostname === "youtu.be") {
        return url.pathname.replace("/", "").trim();
      }

      if (url.searchParams.get("v")) {
        return url.searchParams.get("v").trim();
      }

      const match = url.pathname.match(
        /\/(?:shorts|embed|live)\/([^/?]+)/i
      );

      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  getTrackId(track) {
    return (
      track?.track ||
      track?.info?.identifier ||
      track?.info?.uri ||
      track?.identifier ||
      track?.uri ||
      null
    );
  }

  getTrackTitle(track) {
    return (
      track?.info?.title ||
      track?.title ||
      "Unknown track"
    );
  }

  getTrackAuthor(track) {
    return (
      track?.info?.author ||
      track?.author ||
      "Unknown artist"
    );
  }

  formatDuration(ms = 0) {
    const total = Math.max(
      0,
      Math.floor(Number(ms || 0) / 1000)
    );

    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;

    if (hours) {
      return `${hours}:${String(minutes).padStart(
        2,
        "0"
      )}:${String(seconds).padStart(2, "0")}`;
    }

    return `${minutes}:${String(seconds).padStart(
      2,
      "0"
    )}`;
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ============================================================
  // LAVALINK
  // ============================================================

  async waitForNode(timeout = 30000) {
    const start = Date.now();

    while (Date.now() - start < timeout) {
      const nodes = this.kazagumo?.shoukaku?.nodes;

      if (nodes) {
        for (const [, node] of nodes) {
          if (node?.state === 1) {
            return node;
          }
        }
      }

      await this.sleep(1000);
    }

    return null;
  }

  // ============================================================
  // SEARCH
  // ============================================================

  async search(query, requester = null) {
    query = this.cleanQuery(query);

    if (!query) return null;

    if (this.isYouTubeUrl(query)) {
      const id = this.extractYouTubeId(query);

      for (const identifier of [query, id].filter(Boolean)) {
        try {
          const result = await this.kazagumo.search(
            identifier,
            { requester }
          );

          if (result?.tracks?.length) {
            return result;
          }
        } catch (error) {
          console.warn(
            "⚠️ YouTube URL search failed:",
            error?.message || error
          );
        }
      }

      return null;
    }

    const key = query.toLowerCase();

    const cached = this.searchCache.get(key);

    if (cached && cached.expires > Date.now()) {
      return cached.result;
    }

    const searches = [
      `ytmsearch:${query}`,
      `ytsearch:${query}`,
      query,
      `scsearch:${query}`
    ];

    for (const identifier of searches) {
      try {
        const result = await this.kazagumo.search(
          identifier,
          { requester }
        );

        if (result?.tracks?.length) {
          this.searchCache.set(key, {
            result,
            expires: Date.now() + 60000
          });

          return result;
        }
      } catch (error) {
        console.warn(
          `⚠️ Music search failed for ${identifier}:`,
          error?.message || error
        );
      }
    }

    return null;
  }

  // ============================================================
  // PLAYER
  // ============================================================

  async createPlayer(guildId, voiceId, textId = voiceId) {
    let player = this.getPlayer(guildId);

    if (player) {
      if (
        player.voiceId !== voiceId &&
        typeof player.setVoiceChannel === "function"
      ) {
        await player
          .setVoiceChannel(voiceId)
          .catch(error => {
            console.error(
              "❌ Failed to move music player:",
              error?.message || error
            );
          });
      }

      this.players.set(guildId, player);

      return player;
    }

    const node = await this.waitForNode();

    if (!node) {
      throw new Error(
        "Lavalink is not connected yet."
      );
    }

    player = await this.kazagumo.createPlayer({
      guildId,
      voiceId,
      textId: textId || voiceId,
      deaf: true,
      volume: this.defaultVolume
    });

    this.players.set(guildId, player);

    const state = this.getState(guildId);

    state.permanent =
      voiceId === this.musicVoiceChannelId;

    return player;
  }

  // ============================================================
  // 24/7
  // ============================================================

  async ensure247(guildId = this.musicGuildId) {
    if (!guildId || !this.musicVoiceChannelId) {
      return null;
    }

    const guild =
      this.client.guilds.cache.get(guildId);

    if (!guild) {
      console.warn(
        `⚠️ GMAO guild ${guildId} is not cached yet.`
      );

      return null;
    }

    const voiceChannel =
      guild.channels.cache.get(
        this.musicVoiceChannelId
      );

    if (
      !voiceChannel ||
      !voiceChannel.isVoiceBased()
    ) {
      console.error(
        `❌ MUSIC_VOICE_CHANNEL_ID ${this.musicVoiceChannelId} is not a voice channel.`
      );

      return null;
    }

    try {
      const player = await this.createPlayer(
        guildId,
        voiceChannel.id,
        voiceChannel.id
      );

      const state = this.getState(guildId);

      state.permanent = true;

      try {
        await this.ensurePanel(guildId);

        console.log(
          "🎛️ Music control panel is ready."
        );
      } catch (panelError) {
        console.error(
          "❌ Music panel could not be created:",
          panelError?.message || panelError
        );
      }

      await this.updateVoiceStatus(
        voiceChannel.id,
        "🎵 DEATH Music 24/7 • Ready"
      );

      if (
        !player.playing &&
        !player.paused &&
        !player.queue?.current &&
        !(player.queue?.length > 0)
      ) {
        if (state.autoplay) {
          const started =
            await this.autoplayNext(
              guildId,
              player
            );

          if (!started) {
            console.warn(
              "⚠️ Autoplay did not find a track. Retrying in 10 seconds."
            );

            setTimeout(() => {
              const currentPlayer =
                this.getPlayer(guildId);

              const currentState =
                this.getState(guildId);

              if (
                currentState.autoplay &&
                currentPlayer &&
                !currentPlayer.playing &&
                !currentPlayer.paused &&
                !currentPlayer.queue?.current &&
                !(currentPlayer.queue?.length > 0)
              ) {
                this.autoplayNext(
                  guildId,
                  currentPlayer
                ).catch(() => {});
              }
            }, 10000);
          }
        }
      }

      console.log(
        `♾️ 24/7 voice connected: ${guild.name} / ${voiceChannel.name}`
      );

      return player;
    } catch (error) {
      console.error(
        "❌ 24/7 voice connection failed:",
        error?.message || error
      );

      return null;
    }
  }

  async join(guild, voiceChannel) {
    if (!guild || !voiceChannel) {
      throw new Error(
        "Voice channel is required."
      );
    }

    return this.createPlayer(
      guild.id,
      voiceChannel.id,
      voiceChannel.id
    );
  }

  async leave(guildId) {
    const player = this.getPlayer(guildId);

    if (!player) {
      return false;
    }

    const state = this.getState(guildId);

    state.permanent = false;
    state.autoplay = false;

    await player.destroy().catch(() => {});

    this.players.delete(guildId);
    this.states.delete(guildId);
    this.autoplayBusy.delete(guildId);
    this.recentTracks.delete(guildId);

    return true;
  }

  // ============================================================
  // PLAY
  // ============================================================

  async play({
    guildId,
    voiceId,
    textId,
    query,
    requester
  }) {
    query = this.cleanQuery(query);

    if (!guildId) {
      throw new Error(
        "Guild ID is required."
      );
    }

    if (!query) {
      throw new Error(
        "Please provide a song name or URL."
      );
    }

    const destinationVoice =
      guildId === this.musicGuildId &&
      this.musicVoiceChannelId
        ? this.musicVoiceChannelId
        : voiceId;

    if (!destinationVoice) {
      throw new Error(
        "No music voice channel is configured."
      );
    }

    const player = await this.createPlayer(
      guildId,
      destinationVoice,
      destinationVoice
    );

    const result = await this.search(
      query,
      requester
    );

    if (!result?.tracks?.length) {
      throw new Error(
        `Track not found for "${query}".`
      );
    }

    const tracks = result.tracks;

    const wasPlaying = Boolean(
      player.playing ||
      player.paused ||
      player.queue?.current
    );

    const state = this.getState(guildId);

    state.autoplayGeneration =
      (state.autoplayGeneration || 0) + 1;

    const isPlaylist =
      result.type === "PLAYLIST_LOADED" ||
      result.type === "playlist" ||
      result.type === "PLAYLIST";

    if (isPlaylist) {
      player.queue.add(tracks);
    } else {
      player.queue.add(tracks[0]);
    }

    if (
      !wasPlaying &&
      !player.playing &&
      !player.paused
    ) {
      await player.play();

      return {
        type: isPlaylist
          ? "playlist"
          : "track",
        tracks,
        track: tracks[0],
        player,
        startedNow: true,
        queued: false
      };
    }

    return {
      type: isPlaylist
        ? "playlist"
        : "track",
      tracks,
      track: tracks[0],
      player,
      startedNow: false,
      queued: true
    };
  }

  // ============================================================
  // AUTOPLAY
  // ============================================================

  async autoplayNext(
    guildId,
    player = this.getPlayer(guildId)
  ) {
    if (!player) {
      return false;
    }

    const state = this.getState(guildId);

    if (!state.autoplay) {
      return false;
    }

    if (this.autoplayBusy.has(guildId)) {
      return false;
    }

    if (
      player.playing ||
      player.paused ||
      player.queue?.current ||
      (player.queue?.length || 0) > 0
    ) {
      return false;
    }

    this.autoplayBusy.add(guildId);

    const generation =
      state.autoplayGeneration || 0;

    try {
      const recent =
        this.recentTracks.get(guildId) || [];

      let chosen = null;

      for (
        let attempt = 0;
        attempt < 8 && !chosen;
        attempt++
      ) {
        const seed =
          AUTOPLAY_SEARCHES[
            Math.floor(
              Math.random() *
              AUTOPLAY_SEARCHES.length
            )
          ];

        const identifiers = [
          `ytmsearch:${seed}`,
          `ytsearch:${seed}`,
          seed,
          `scsearch:${seed}`
        ];

        let result = null;

        for (const identifier of identifiers) {
          try {
            const found =
              await this.kazagumo.search(
                identifier,
                {
                  requester: this.client.user
                }
              );

            if (found?.tracks?.length) {
              result = found;
              break;
            }
          } catch (error) {
            console.warn(
              `⚠️ Autoplay search failed for ${identifier}:`,
              error?.message || error
            );
          }
        }

        if (!result?.tracks?.length) {
          continue;
        }

        const candidates =
          result.tracks.filter(track => {
            const id =
              this.getTrackId(track);

            return (
              id &&
              !recent.includes(id)
            );
          });

        if (candidates.length) {
          chosen =
            candidates[
              Math.floor(
                Math.random() *
                candidates.length
              )
            ];
        }
      }

      if (
        !chosen ||
        (state.autoplayGeneration || 0) !==
          generation
      ) {
        return false;
      }

      if (
        player.playing ||
        player.paused ||
        player.queue?.current ||
        (player.queue?.length || 0) > 0
      ) {
        return false;
      }

      const id =
        this.getTrackId(chosen);

      if (id) {
        const nextRecent =
          [...recent, id].slice(-10);

        this.recentTracks.set(
          guildId,
          nextRecent
        );
      }

      player.queue.add(chosen);

      if (
        !player.playing &&
        !player.paused
      ) {
        await player.play();
      }

      console.log(
        `♾️ Autoplay queued: ${this.getTrackTitle(chosen)}`
      );

      return true;
    } catch (error) {
      console.error(
        "❌ Autoplay error:",
        error?.message || error
      );

      return false;
    } finally {
      this.autoplayBusy.delete(guildId);
    }
  }

  // ============================================================
  // VOICE STATUS
  // ============================================================

  async updateVoiceStatus(
    channelId,
    status
  ) {
    if (!channelId) {
      return false;
    }

    const state =
      this.getState(
        this.musicGuildId || "global"
      );

    const clean =
      String(status || "").slice(0, 500);

    /*
     * IMPORTANT:
     * Do NOT repeatedly change the status
     * if it is already showing this exact
     * song/status.
     */
    if (
      state.lastVoiceStatus === clean
    ) {
      return true;
    }

    try {
      await this.client.rest.put(
        `/channels/${channelId}/voice-status`,
        {
          body: {
            status: clean
          }
        }
      );

      state.lastVoiceStatus = clean;

      return true;
    } catch (error) {
      console.warn(
        `⚠️ Voice status update failed for ${channelId}:`,
        error?.message || error
      );

      return false;
    }
  }

  // ============================================================
  // CURRENT SONG
  // ============================================================

  async updateNowPlaying(
    player,
    track
  ) {
    if (!player || !track) {
      return;
    }

    const guildId =
      player.guildId;

    const title =
      this.getTrackTitle(track);

    const author =
      this.getTrackAuthor(track);

    const voiceId =
      player.voiceId ||
      this.musicVoiceChannelId;

    /*
     * THIS IS THE IMPORTANT PART.
     *
     * The voice status is changed ONLY
     * when playerStart fires.
     *
     * Therefore:
     *
     * Song A starts
     * -> Song A stays visible
     *
     * Song A finishes
     * -> Song B starts
     * -> Song B replaces Song A
     */
    await this.updateVoiceStatus(
      voiceId,
      `🎵 ${title}`
    );

    /*
     * Keep Discord bot activity synchronized
     * with the current song.
     */
    try {
      this.client.user.setPresence({
        activities: [
          {
            name: title.slice(0, 128),
            type: 2
          }
        ],
        status: "online"
      });
    } catch {}

    /*
     * Store the current song.
     */
    const state =
      this.getState(guildId);

    state.currentTitle =
      title;

    state.currentAuthor =
      author;

    state.currentStartedAt =
      Date.now();

    /*
     * Update the music panel.
     */
    await this.refreshPanel(
      guildId
    ).catch(() => {});
  }

  // ============================================================
  // PANEL CHANNEL
  // ============================================================

  async findPanelChannel(guildId) {
    const guild =
      this.client.guilds.cache.get(
        guildId
      );

    if (!guild) {
      throw new Error(
        "GMAO server is not available."
      );
    }

    const me =
      guild.members.me;

    const preferredIds = [
      this.musicTextChannelId,
      this.getPlayer(guildId)?.voiceId,
      this.musicVoiceChannelId
    ].filter(Boolean);

    for (const id of preferredIds) {
      const channel =
        guild.channels.cache.get(id);

      if (
        !channel?.isTextBased?.() ||
        !channel?.isSendable?.()
      ) {
        continue;
      }

      if (
        me &&
        !channel
          .permissionsFor(me)
          ?.has("SendMessages")
      ) {
        continue;
      }

      return channel;
    }

    const fallback =
      guild.channels.cache.find(
        channel => {
          if (
            !channel?.isTextBased?.() ||
            !channel?.isSendable?.()
          ) {
            return false;
          }

          if (
            me &&
            !channel
              .permissionsFor(me)
              ?.has("SendMessages")
          ) {
            return false;
          }

          return true;
        }
      );

    if (fallback) {
      return fallback;
    }

    throw new Error(
      "I cannot find a text channel where I can send the music control panel."
    );
  }

  // ============================================================
  // MUSIC PANEL
  // ============================================================

  buildPanelPayload(guildId) {
    const player =
      this.getPlayer(guildId);

    const state =
      this.getState(guildId);

    const current =
      player?.queue?.current;

    const title =
      current
        ? this.getTrackTitle(current)
        : "Nothing is playing";

    const author =
      current
        ? this.getTrackAuthor(current)
        : "DEATH Music 24/7";

    const duration =
      current?.info?.length ||
      current?.length ||
      0;

    const position =
      player?.position || 0;

    const volume =
      player?.volume ??
      this.defaultVolume;

    const embed =
      new EmbedBuilder()
        .setTitle(
          "💀 DEATH Music 24/7"
        )
        .setDescription(
          `**${title}**\nArtist: **${author}**`
        )
        .addFields(
          {
            name: "Duration",
            value:
              this.formatDuration(
                duration
              ),
            inline: true
          },
          {
            name: "Position",
            value:
              this.formatDuration(
                position
              ),
            inline: true
          },
          {
            name: "Volume",
            value:
              `${volume}%`,
            inline: true
          },
          {
            name: "Loop",
            value:
              state.loop ||
              "none",
            inline: true
          },
          {
            name: "Autoplay",
            value:
              state.autoplay
                ? "ON"
                : "OFF",
            inline: true
          },
          {
            name: "24/7 Voice",
            value:
              state.permanent
                ? "ON"
                : "OFF",
            inline: true
          }
        )
        .setFooter({
          text:
            "DEATH × GMAO • Music controls"
        })
        .setTimestamp();

    const row1 =
      new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId(
              "death_music_pause"
            )
            .setLabel("Pause")
            .setEmoji("⏸️")
            .setStyle(
              ButtonStyle.Primary
            ),

          new ButtonBuilder()
            .setCustomId(
              "death_music_resume"
            )
            .setLabel("Resume")
            .setEmoji("▶️")
            .setStyle(
              ButtonStyle.Success
            ),

          new ButtonBuilder()
            .setCustomId(
              "death_music_skip"
            )
            .setLabel("Skip")
            .setEmoji("⏭️")
            .setStyle(
              ButtonStyle.Primary
            ),

          new ButtonBuilder()
            .setCustomId(
              "death_music_stop"
            )
            .setLabel("Stop")
            .setEmoji("⏹️")
            .setStyle(
              ButtonStyle.Danger
            ),

          new ButtonBuilder()
            .setCustomId(
              "death_music_shuffle"
            )
            .setLabel("Shuffle")
            .setEmoji("🔀")
            .setStyle(
              ButtonStyle.Secondary
            )
        );

    const row2 =
      new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId(
              "death_music_queue"
            )
            .setLabel("Queue")
            .setEmoji("📜")
            .setStyle(
              ButtonStyle.Secondary
            ),

          new ButtonBuilder()
            .setCustomId(
              "death_music_loop"
            )
            .setLabel("Loop")
            .setEmoji("🔁")
            .setStyle(
              ButtonStyle.Secondary
            ),

          new ButtonBuilder()
            .setCustomId(
              "death_music_vol_down"
            )
            .setLabel("Vol -")
            .setEmoji("🔉")
            .setStyle(
              ButtonStyle.Secondary
            ),

          new ButtonBuilder()
            .setCustomId(
              "death_music_vol_up"
            )
            .setLabel("Vol +")
            .setEmoji("🔊")
            .setStyle(
              ButtonStyle.Secondary
            ),

          new ButtonBuilder()
            .setCustomId(
              "death_music_autoplay"
            )
            .setLabel(
              `Autoplay ${
                state.autoplay
                  ? "ON"
                  : "OFF"
              }`
            )
            .setEmoji("♾️")
            .setStyle(
              state.autoplay
                ? ButtonStyle.Success
                : ButtonStyle.Secondary
            )
        );

    const row3 =
      new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId(
              "death_music_refresh"
            )
            .setLabel("Refresh")
            .setEmoji("🔄")
            .setStyle(
              ButtonStyle.Secondary
            )
        );

    return {
      embeds: [embed],
      components: [
        row1,
        row2,
        row3
      ]
    };
  }

  async ensurePanel(guildId) {
    const state =
      this.getState(guildId);

    const channel =
      await this.findPanelChannel(
        guildId
      );

    if (
      state.panelMessageId &&
      state.panelChannelId ===
        channel.id
    ) {
      try {
        const existing =
          await channel.messages.fetch(
            state.panelMessageId
          );

        if (existing) {
          await existing.edit(
            this.buildPanelPayload(
              guildId
            )
          );

          return existing;
        }
      } catch {}
    }

    try {
      const messages =
        await channel.messages.fetch({
          limit: 50
        });

      const existing =
        messages.find(
          message =>
            message.author?.id ===
              this.client.user.id &&
            message.embeds?.[0]
              ?.title ===
              "💀 DEATH Music 24/7"
        );

      if (existing) {
        state.panelMessageId =
          existing.id;

        state.panelChannelId =
          channel.id;

        await existing.edit(
          this.buildPanelPayload(
            guildId
          )
        );

        return existing;
      }
    } catch (error) {
      console.warn(
        "⚠️ Could not inspect music panel messages:",
        error?.message ||
          error
      );
    }

    const message =
      await channel.send(
        this.buildPanelPayload(
          guildId
        )
      );

    state.panelMessageId =
      message.id;

    state.panelChannelId =
      channel.id;

    return message;
  }

  async sendPanel(guildId) {
    const state =
      this.getState(guildId);

    const channel =
      await this.findPanelChannel(
        guildId
      );

    const message =
      await channel.send(
        this.buildPanelPayload(
          guildId
        )
      );

    state.panelMessageId =
      message.id;

    state.panelChannelId =
      channel.id;

    return message;
  }

  async refreshPanel(guildId) {
    if (!guildId) {
      return false;
    }

    const state =
      this.getState(guildId);

    if (
      !state.panelMessageId ||
      !state.panelChannelId
    ) {
      return false;
    }

    const channel =
      this.client.channels.cache.get(
        state.panelChannelId
      );

    if (
      !channel?.isTextBased?.()
    ) {
      return false;
    }

    try {
      const message =
        await channel.messages.fetch(
          state.panelMessageId
        );

      await message.edit(
        this.buildPanelPayload(
          guildId
        )
      );

      return true;
    } catch {
      return false;
    }
  }

  // ============================================================
  // CONTROLS
  // ============================================================

  async pause(guildId) {
    const player =
      this.getPlayer(guildId);

    if (!player) {
      throw new Error(
        "There is no music player in this server."
      );
    }

    await player.pause(true);

    await this.refreshPanel(
      guildId
    );

    return true;
  }

  async resume(guildId) {
    const player =
      this.getPlayer(guildId);

    if (!player) {
      throw new Error(
        "There is no music player in this server."
      );
    }

    await player.pause(false);

    await this.refreshPanel(
      guildId
    );

    return true;
  }

  async skip(guildId) {
    const player =
      this.getPlayer(guildId);

    if (!player) {
      throw new Error(
        "There is no music player in this server."
      );
    }

    await player.skip();

    return true;
  }

  async shuffle(guildId) {
    const player =
      this.getPlayer(guildId);

    if (!player) {
      throw new Error(
        "There is no music player in this server."
      );
    }

    if (
      typeof player.queue?.shuffle ===
      "function"
    ) {
      player.queue.shuffle();
    }

    await this.refreshPanel(
      guildId
    );

    return true;
  }

  async stop(guildId) {
    const player =
      this.getPlayer(guildId);

    if (!player) {
      return false;
    }

    const state =
      this.getState(guildId);

    try {
      player.queue.clear();
    } catch {}

    state.autoplay = false;

    state.autoplayGeneration =
      (state.autoplayGeneration || 0) + 1;

    if (
      typeof player.stop ===
      "function"
    ) {
      await player.stop()
        .catch(() => {});
    }

    await this.refreshPanel(
      guildId
    );

    return true;
  }

  async setVolume(
    guildId,
    volume
  ) {
    const player =
      this.getPlayer(guildId);

    if (!player) {
      throw new Error(
        "There is no music player in this server."
      );
    }

    volume = Math.max(
      1,
      Math.min(
        100,
        Number(volume)
      )
    );

    await player.setVolume(
      volume
    );

    await this.refreshPanel(
      guildId
    );

    return volume;
  }

  async setLoop(
    guildId,
    mode
  ) {
    const player =
      this.getPlayer(guildId);

    if (!player) {
      throw new Error(
        "There is no music player in this server."
      );
    }

    if (
      ![
        "none",
        "track",
        "queue"
      ].includes(mode)
    ) {
      mode = "none";
    }

    if (
      typeof player.setLoop ===
      "function"
    ) {
      player.setLoop(mode);
    }

    this.getState(
      guildId
    ).loop = mode;

    await this.refreshPanel(
      guildId
    );

    return mode;
  }

  // ============================================================
  // RECOVERY
  // ============================================================

  async recoverPlayers() {
    const node =
      await this.waitForNode(3000);

    if (!node) {
      return;
    }

    await this.ensure247(
      this.musicGuildId
    );

    for (
      const [
        guildId,
        player
      ] of this.players
    ) {
      if (
        !player ||
        !this.kazagumo.players.get(
          guildId
        )
      ) {
        this.players.delete(
          guildId
        );
      }
    }
  }

  startRecoveryLoop() {
    if (
      this.recoveryStarted
    ) {
      return;
    }

    this.recoveryStarted = true;

    this.recoveryTimer =
      setInterval(
        () => {
          this.recoverPlayers()
            .catch(error => {
              console.error(
                "❌ Music recovery error:",
                error?.message ||
                  error
              );
            });
        },
        30000
      );

    this.ensure247(
      this.musicGuildId
    ).catch(error => {
      console.error(
        "❌ Initial music startup error:",
        error?.message ||
          error
      );
    });
  }

  // ============================================================
  // VOICE STATE
  // ============================================================

  async handleVoiceStateUpdate(
    oldState,
    newState
  ) {
    if (
      newState.guild?.id !==
      this.musicGuildId
    ) {
      return;
    }

    if (
      newState.member?.user?.bot
    ) {
      return;
    }

    const player =
      this.getPlayer(
        this.musicGuildId
      );

    if (!player) {
      await this.ensure247(
        this.musicGuildId
      );
    }
  }

  // ============================================================
  // SHUTDOWN
  // ============================================================

  async shutdown() {
    if (
      this.recoveryTimer
    ) {
      clearInterval(
        this.recoveryTimer
      );
    }

    this.recoveryTimer = null;
    this.recoveryStarted = false;

    for (
      const [
        guildId,
        player
      ] of this.players
    ) {
      await player
        .destroy()
        .catch(() => {});

      this.players.delete(
        guildId
      );
    }

    this.searchCache.clear();
    this.autoplayBusy.clear();
  }

  async destroy() {
    return this.shutdown();
  }

  async leavePermanent(
    guildId
  ) {
    return this.leave(
      guildId
    );
  }

  // ============================================================
  // EVENTS
  // ============================================================

  setupEvents() {

    /*
     * NEW SONG STARTED
     *
     * This is the ONLY place that
     * changes the displayed song name.
     */
    this.kazagumo.on(
      "playerStart",
      async (
        player,
        track
      ) => {
        console.log(
          `▶️ Track started: ${this.getTrackTitle(track)}`
        );

        await this.updateNowPlaying(
          player,
          track
        );
      }
    );

    /*
     * SONG ENDED
     */
    this.kazagumo.on(
      "playerEnd",
      async player => {
        console.log(
          `⏹️ Track ended | guild=${player?.guildId || "unknown"}`
        );

        /*
         * IMPORTANT:
         *
         * Do NOT reset the voice status here.
         *
         * The previous song name stays visible
         * until the next track actually starts.
         */
        await this.refreshPanel(
          player?.guildId
        ).catch(() => {});
      }
    );

    /*
     * QUEUE EMPTY
     *
     * Autoplay will find the next song.
     * When that song actually starts,
     * playerStart changes the displayed name.
     */
    this.kazagumo.on(
      "playerEmpty",
      async player => {
        const guildId =
          player?.guildId;

        if (!guildId) {
          return;
        }

        console.log(
          `📭 Queue empty | guild=${guildId}`
        );

        await this.refreshPanel(
          guildId
        ).catch(() => {});

        const state =
          this.getState(
            guildId
          );

        if (
          state.autoplay
        ) {
          await this.autoplayNext(
            guildId,
            player
          );
        }
      }
    );

    this.kazagumo.on(
      "playerClosed",
      player => {
        console.warn(
          `🔌 Player closed | guild=${player?.guildId || "unknown"}`
        );
      }
    );

    this.kazagumo.on(
      "playerException",
      async (
        player,
        error
      ) => {
        console.error(
          `❌ Player exception | guild=${player?.guildId || "unknown"}:`,
          error?.message ||
            error
        );

        if (
          player?.guildId
        ) {
          await this.sleep(
            1000
          );

          const state =
            this.getState(
              player.guildId
            );

          if (
            state.autoplay &&
            !player.playing &&
            !player.paused
          ) {
            await this.autoplayNext(
              player.guildId,
              player
            );
          }
        }
      }
    );

    this.kazagumo.on(
      "playerStuck",
      async (
        player,
        data
      ) => {
        console.warn(
          "⚠️ Player stuck:",
          data || ""
        );

        if (
          player?.guildId
        ) {
          await this.sleep(
            1500
          );

          if (
            !player.playing &&
            !player.paused
          ) {
            await player
              .play()
              .catch(() => {});
          }
        }
      }
    );

    // ========================================================
    // LAVALINK
    // ========================================================

    this.kazagumo.shoukaku?.on(
      "ready",
      name => {
        console.log(
          `🟢 Lavalink node READY: ${name}`
        );

        this.ensure247(
          this.musicGuildId
        ).catch(error => {
          console.error(
            "❌ Music startup after Lavalink ready failed:",
            error?.message ||
              error
          );
        });
      }
    );

    this.kazagumo.shoukaku?.on(
      "error",
      (
        name,
        error
      ) => {
        console.error(
          `🔴 Lavalink ${name} error:`,
          error?.message ||
            error
        );
      }
    );

    this.kazagumo.shoukaku?.on(
      "close",
      (
        name,
        code,
        reason
      ) => {
        console.warn(
          `🟠 Lavalink ${name} closed: code=${code} reason=${reason || "none"}`
        );
      }
    );

    this.kazagumo.shoukaku?.on(
      "disconnect",
      name => {
        console.warn(
          `🟠 Lavalink ${name} disconnected.`
        );
      }
    );
  }
}

module.exports = MusicManager;

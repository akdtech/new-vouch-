"use strict";

const { spawn } = require("node:child_process");
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder
} = require("discord.js");
const {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType
} = require("@discordjs/voice");

const DEFAULT_VOICE_CHANNEL = "1532082737480077462";
const YTDLP = process.env.YTDLP_PATH || "/usr/local/bin/yt-dlp";
const FFMPEG = process.env.FFMPEG_PATH || "/usr/bin/ffmpeg";

const AUTOPLAY_GROUPS = [
  {
    name: "Hindi Music",
    seeds: [
      "best Hindi songs 2026",
      "latest Hindi songs 2026",
      "Hindi hits 2026",
      "Bollywood hits 2026",
      "Hindi romantic songs",
      "Hindi party songs"
    ]
  },
  {
    name: "English TikTok Viral",
    seeds: [
      "TikTok viral songs 2026",
      "TikTok viral hits 2026",
      "viral English songs 2026",
      "TikTok trending songs",
      "viral pop songs 2026",
      "TikTok top songs"
    ]
  },
  {
    name: "Top English",
    seeds: [
      "top English songs 2026",
      "best English songs 2026",
      "top hits 2026",
      "global top songs 2026",
      "best pop hits 2026",
      "English chart hits 2026"
    ]
  }
];

class DirectMusicManager {
  constructor(client, config = {}) {
    this.client = client;
    this.config = config;
    this.players = new Map();
    this.states = new Map();
    this.connections = new Map();
    this.streams = new Map();
    this.recoveryTimer = null;
    this.recoveryStarted = false;

    this.musicVoiceChannelId =
      process.env.MUSIC_VOICE_CHANNEL_ID ||
      config.musicVoiceChannelId ||
      DEFAULT_VOICE_CHANNEL;
    this.musicTextChannelId =
      process.env.MUSIC_PANEL_CHANNEL_ID ||
      process.env.MUSIC_TEXT_CHANNEL_ID ||
      config.musicTextChannelId ||
      "";
    this.musicGuildId =
      process.env.GUILD_ID ||
      config.guildId ||
      "";
    this.defaultAutoplay =
      String(process.env.AUTOPLAY_DEFAULT ?? config.autoplayDefault ?? "true").toLowerCase() !== "false";
    this.defaultVolume = Math.max(1, Math.min(100, Number(process.env.DEFAULT_VOLUME || config.defaultVolume || 70)));

    console.log("🎵 DEATH Music Engine v2: @discordjs/voice + FFmpeg + Audius/direct streams");
    console.log("🚫 Lavalink/Kazagumo/YouTube extraction disabled.");
    console.log(`🎵 FFmpeg: ${FFMPEG}`);

    this.setupPlayerEvents();
  }

  getState(guildId) {
    if (!this.states.has(guildId)) {
      this.states.set(guildId, {
        autoplay: this.defaultAutoplay,
        loop: "none",
        permanent: guildId === this.musicGuildId,
        volume: this.defaultVolume,
        current: null,
        queue: [],
        paused: false,
        startedAt: 0,
        positionOffset: 0,
        autoplayGroupIndex: 0,
        recent: [],
        panelMessageId: null,
        panelChannelId: null,
        manualGeneration: 0,
        autoplayBusy: false,
        intentionalLeave: false,
        retryTimer: null
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
    const player = this.players.get(guildId);
    if (!player) return null;
    const state = this.getState(guildId);
    const queue = [...state.queue];
    queue.current = state.current;
    return {
      queue,
      volume: state.volume,
      position: this.getPosition(guildId),
      playing: player.state.status === AudioPlayerStatus.Playing,
      paused: player.state.status === AudioPlayerStatus.Paused,
      pause: () => this.pause(guildId),
      resume: () => this.resume(guildId),
      seek: ms => this.seek(guildId, ms)
    };
  }

  getQueue(guildId) {
    const state = this.getState(guildId);
    return state.current ? [state.current, ...state.queue] : [...state.queue];
  }

  getCurrent(guildId) {
    return this.getState(guildId).current;
  }

  getTrackId(track) {
    return track?.identifier || track?.id || track?.url || null;
  }

  getTrackTitle(track) {
    return track?.title || "Unknown track";
  }

  getTrackAuthor(track) {
    return track?.author || track?.uploader || "Unknown artist";
  }

  formatDuration(ms = 0) {
    const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
  }

  getPosition(guildId) {
    const state = this.getState(guildId);
    if (!state.current || !state.startedAt || state.paused) return state.positionOffset || 0;
    return Math.max(0, (Date.now() - state.startedAt) + (state.positionOffset || 0));
  }

  cleanQuery(query) {
    return String(query || "").replace(/\s+/g, " ").trim();
  }

  isYouTubeUrl(query) {
    return /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(query);
  }

  async runYtDlp(args, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const child = spawn(YTDLP, [
        "--no-warnings",
        "--no-progress",
        "--js-runtimes", "node",
        ...args
      ], { stdio: ["ignore", "pipe", "pipe"] });

      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        reject(new Error("yt-dlp timed out."));
      }, timeout);

      child.stdout.on("data", chunk => { stdout += chunk.toString(); });
      child.stderr.on("data", chunk => { stderr += chunk.toString(); });
      child.on("error", error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", code => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) resolve({ stdout, stderr });
        else reject(new Error(stderr.trim().split("\n").slice(-3).join(" ") || `yt-dlp exited with code ${code}`));
      });
    });
  }

  async search(query, requester) {
    const clean = this.cleanQuery(query);
    if (!clean) throw new Error("Please provide a song name.");

    // Direct audio URLs are supported without any extractor.
    if (/^https?:\/\//i.test(clean) && !/youtube\.com|youtu\.be/i.test(clean)) {
      return {
        type: "track",
        tracks: [{
          identifier: clean, id: clean, url: clean,
          title: "Direct audio stream", author: "Direct URL",
          length: 0, requester, source: "direct"
        }]
      };
    }

    const base = "https://discoveryprovider.audius.co/v1";
    const endpoint = new URL(base + "/tracks/search");
    endpoint.searchParams.set("query", clean);
    endpoint.searchParams.set("limit", "8");
    endpoint.searchParams.set("sort_method", "relevant");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(endpoint, {
        signal: controller.signal,
        headers: { "User-Agent": "DEATH-GMAO-Music/1.0" }
      });
      if (!response.ok) throw new Error("Music catalog returned HTTP " + response.status);
      const json = await response.json();
      const list = Array.isArray(json?.data) ? json.data : [];
      const tracks = list.filter(t => t?.id).map(t => ({
        identifier: String(t.id),
        id: String(t.id),
        url: base + "/tracks/" + encodeURIComponent(t.id) + "/stream",
        title: t.title || "Unknown track",
        author: t.user?.name || t.user?.handle || "Audius artist",
        length: Number(t.duration || 0) * 1000,
        requester: requester || this.client.user,
        thumbnail: t.artwork?.["480x480"] || t.artwork?.["150x150"] || null,
        source: "audius"
      }));
      if (!tracks.length) throw new Error("No playable track found for \"" + clean + "\" on the open music catalog.");
      return { type: "track", tracks };
    } finally {
      clearTimeout(timer);
    }
  }

  normalizeTrack(info, requester) {
    const id = info?.id || info?.identifier;
    const url = info?.webpage_url || info?.original_url || (id ? `https://www.youtube.com/watch?v=${id}` : info?.url);
    return {
      identifier: id || url,
      id: id || url,
      url,
      title: info?.title || "Unknown track",
      author: info?.uploader || info?.channel || "Unknown artist",
      length: Number(info?.duration || 0) * 1000,
      requester: requester || this.client.user,
      thumbnail: info?.thumbnail || null,
      isAutoplay: false
    };
  }

  async ensureConnection(guildId, voiceId) {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) throw new Error("Server is not available.");
    const channel = guild.channels.cache.get(voiceId);
    if (!channel?.isVoiceBased?.()) throw new Error("Configured music voice channel is invalid.");

    const existing = this.connections.get(guildId);
    if (existing && existing.state.status !== VoiceConnectionStatus.Destroyed) {
      try {
        await entersState(existing, VoiceConnectionStatus.Ready, 10000);
        return existing;
      } catch {}
    }

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false
    });

    this.connections.set(guildId, connection);
    connection.on("error", error => console.warn(`⚠️ Voice connection error [${guildId}]:`, error?.message || error));
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      const state = this.getState(guildId);
      if (state.intentionalLeave) return;
      console.warn(`🟠 Discord voice disconnected [${guildId}], attempting recovery.`);
      await this.reconnect(guildId, voiceId).catch(error => console.warn("⚠️ Voice recovery failed:", error?.message || error));
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 20000);
    return connection;
  }

  ensurePlayer(guildId) {
    let player = this.players.get(guildId);
    if (player) return player;

    player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play }
    });
    this.players.set(guildId, player);
    const connection = this.connections.get(guildId);
    if (connection) connection.subscribe(player);
    return player;
  }

  setupPlayerEvents() {
    this.client.on("ready", () => {
      for (const guild of this.client.guilds.cache.values()) {
        if (guild.id === this.musicGuildId) {
          this.ensure247(guild.id).catch(error => console.error("❌ Direct music startup:", error?.message || error));
        }
      }
    });
  }

  bindPlayerEvents(guildId, player) {
    if (player.__deathBound) return;
    player.__deathBound = true;

    player.on(AudioPlayerStatus.Playing, () => {
      const state = this.getState(guildId);
      state.paused = false;
      state.startedAt = state.startedAt || Date.now();
      const track = state.current;
      if (track) {
        console.log(`🎵 PLAYING: ${this.getTrackTitle(track)}${track.isAutoplay ? ` [${track.autoplayGroup || "Autoplay"}]` : ""}`);
        this.updatePresence(track);
        this.updateVoiceStatus(guildId, `🎵 ${this.getTrackTitle(track)}`).catch(() => {});
        this.refreshPanel(guildId).catch(() => {});
      }
    });

    player.on(AudioPlayerStatus.Idle, () => {
      // Discord can emit Idle for the resource that was just replaced.
      // Never let that stale event tear down the NEW resource or trigger
      // autoplay/queue recovery while a replacement is already installed.
      const liveResource = player.state?.resource;
      if (liveResource && !liveResource.ended) {
        return;
      }
      const state = this.getState(guildId);
      if (state.transitioning) return;
      this.handleTrackEnd(guildId).catch(error => console.error("❌ Track transition:", error?.message || error));
    });

    player.on("error", error => {
      console.error(`❌ Direct audio error [${guildId}]:`, error?.message || error);
      this.handleTrackEnd(guildId, true).catch(() => {});
    });
  }

  async ensure247(guildId) {
    if (!guildId) return null;
    const state = this.getState(guildId);
    state.permanent = true;
    state.intentionalLeave = false;

    const voiceId = this.musicVoiceChannelId;
    const connection = await this.ensureConnection(guildId, voiceId);
    const player = this.ensurePlayer(guildId);
    this.bindPlayerEvents(guildId, player);

    await this.ensurePanel(guildId).catch(error => console.warn("⚠️ Music panel:", error?.message || error));
    console.log(`♾️ 24/7 direct voice connected: ${guildId}`);

    if (!state.current && !state.queue.length && state.autoplay && player.state.status !== AudioPlayerStatus.Playing) {
      await this.autoplayNext(guildId).catch(error => console.warn("⚠️ Autoplay startup:", error?.message || error));
    }
    return player;
  }

  async join(guild, voiceChannel) {
    const guildId = guild.id;
    const state = this.getState(guildId);
    state.intentionalLeave = false;
    state.permanent = guildId === this.musicGuildId;
    const connection = await this.ensureConnection(guildId, voiceChannel.id);
    const player = this.ensurePlayer(guildId);
    this.bindPlayerEvents(guildId, player);
    if (!state.current && !state.queue.length && state.autoplay) await this.autoplayNext(guildId).catch(() => {});
    return player;
  }

  async reconnect(guildId, voiceId) {
    const state = this.getState(guildId);
    if (state.intentionalLeave) return;
    const old = this.connections.get(guildId);
    try { old?.destroy(); } catch {}
    this.connections.delete(guildId);
    await new Promise(resolve => setTimeout(resolve, 1500));
    await this.ensureConnection(guildId, voiceId);
    const player = this.ensurePlayer(guildId);
    this.bindPlayerEvents(guildId, player);
    if (!state.current && !state.queue.length && state.autoplay) await this.autoplayNext(guildId).catch(() => {});
  }

  async leave(guildId) {
    const state = this.getState(guildId);
    state.intentionalLeave = true;
    state.autoplay = false;
    if (state.retryTimer) clearTimeout(state.retryTimer);
    this.destroyStream(guildId);
    try { this.players.get(guildId)?.stop(true); } catch {}
    try { this.connections.get(guildId)?.destroy(); } catch {}
    this.players.delete(guildId);
    this.connections.delete(guildId);
    this.states.delete(guildId);
    return true;
  }

  async play({ guildId, voiceId, query, requester }) {
    const clean = this.cleanQuery(query);
    if (!clean) throw new Error("Please provide a song name or URL.");
    const destinationVoice = guildId === this.musicGuildId ? this.musicVoiceChannelId : voiceId;
    if (!destinationVoice) throw new Error("No voice channel is available.");

    const state = this.getState(guildId);
    const player = await this.ensureConnection(guildId, destinationVoice).then(() => this.ensurePlayer(guildId));
    this.bindPlayerEvents(guildId, player);

    const result = await this.search(clean, requester);
    const track = result.tracks[0];
    if (!track) throw new Error(`Track not found for "${clean}".`);

    state.manualGeneration++;
    track.isAutoplay = false;

    const playerBusy = player.state.status === AudioPlayerStatus.Playing || player.state.status === AudioPlayerStatus.Paused || Boolean(state.transitioning);
    if (state.current?.isAutoplay && playerBusy) {
      // Manual /play always wins over autoplay, but uses the same atomic handoff.
      await this.startTrack(guildId, track, 0, { handoff: true });
      return { type: "track", tracks: [track], track, player: this.getPlayer(guildId), startedNow: true, queued: false };
    }

    // If Discord is idle, never let stale state.current block a new play.
    if (!playerBusy && player.state.status === AudioPlayerStatus.Idle) {
      await this.startTrack(guildId, track, 0, { handoff: true });
      return { type: "track", tracks: [track], track, player: this.getPlayer(guildId), startedNow: true, queued: false };
    }
    state.queue.push(track);
    await this.refreshPanel(guildId).catch(() => {});
    return { type: "track", tracks: [track], track, player: this.getPlayer(guildId), startedNow: false, queued: true };
  }

  async startTrack(guildId, track, startMs = 0) {
    const state = this.getState(guildId);
    const player = this.players.get(guildId) || this.ensurePlayer(guildId);

    this.destroyStream(guildId);
    state.current = track;
    state.startedAt = Date.now();
    state.positionOffset = Math.max(0, Number(startMs || 0));
    state.paused = false;

    // Clean engine: FFmpeg reads the source directly. No Lavalink,
    // no Kazagumo, no YouTube extractor and no proxy chain.
    const ff = spawn(FFMPEG, [
      "-hide_banner", "-loglevel", "error",
      "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5",
      "-i", track.url,
      ...(startMs > 0 ? ["-ss", String(startMs / 1000)] : []),
      "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"
    ], { stdio: ["ignore", "pipe", "pipe"] });

    this.streams.set(guildId, { ff });

    let stderr = "";
    ff.stderr.on("data", chunk => {
      stderr += chunk.toString();
      if (stderr.length > 2500) stderr = stderr.slice(-2500);
    });
    ff.on("error", error => console.warn("⚠️ FFmpeg error:", error?.message || error));
    ff.on("close", code => {
      if (code !== 0 && state.current === track) {
        console.warn("⚠️ FFmpeg source ended:", code, stderr.trim().split("\\n").slice(-2).join(" "));
      }
    });

    const resource = createAudioResource(ff.stdout, {
      inputType: StreamType.Raw,
      inlineVolume: true,
      metadata: track
    });
    resource.volume?.setVolume(Math.max(0.01, state.volume / 100));
    player.play(resource);

    await this.refreshPanel(guildId).catch(() => {});
    console.log("▶️ CLEAN PLAYBACK STARTED:", track.title, "[" + track.source + "]");
  }

  destroyStream(guildId) {
    const stream = this.streams.get(guildId);
    if (!stream) return;
    try { stream.yt?.stdout?.unpipe(stream.ff?.stdin); } catch {}
    try { stream.yt?.kill("SIGKILL"); } catch {}
    try { stream.ff?.kill("SIGKILL"); } catch {}
    this.streams.delete(guildId);
  }

  async handleTrackEnd(guildId, fromError = false) {
    const state = this.getState(guildId);
    const player = this.players.get(guildId);
    const ended = state.current;
    if (!ended) return;

    if (state.loop === "track" && !ended.isAutoplay) {
      await this.startTrack(guildId, ended).catch(() => {});
      return;
    }

    this.destroyStream(guildId);

    if (state.loop === "queue" && !ended.isAutoplay) state.queue.push({ ...ended, requester: ended.requester });
    state.current = null;
    state.startedAt = 0;
    state.positionOffset = 0;

    const next = state.queue.shift();
    if (next) {
      await this.startTrack(guildId, next).catch(error => console.warn("⚠️ Next track failed:", error?.message || error));
      return;
    }

    await this.refreshPanel(guildId).catch(() => {});
    if (state.autoplay && !state.intentionalLeave) {
      await this.autoplayNext(guildId, fromError).catch(() => {});
    }
  }

  async autoplayNext(guildId) {
    const state = this.getState(guildId);
    const player = this.players.get(guildId) || this.ensurePlayer(guildId);
    if (!state.autoplay || state.intentionalLeave || state.autoplayBusy) return false;
    if (state.current || state.queue.length || player.state.status === AudioPlayerStatus.Playing || player.state.status === AudioPlayerStatus.Paused) return false;

    state.autoplayBusy = true;
    try {
      const groupIndex = state.autoplayGroupIndex % AUTOPLAY_GROUPS.length;
      const group = AUTOPLAY_GROUPS[groupIndex];
      const seed = group.seeds[Math.floor(Math.random() * group.seeds.length)];
      console.log(`🔎 Direct autoplay [${group.name}]: ${seed}`);
      const result = await this.search(seed, this.client.user);
      const recent = new Set(state.recent);
      const candidates = result.tracks.filter(t => t.url && !recent.has(this.getTrackId(t)));
      const chosen = candidates[0] || result.tracks[0];
      if (!chosen) return false;

      chosen.isAutoplay = true;
      chosen.autoplayGroup = group.name;
      const id = this.getTrackId(chosen);
      if (id) state.recent = [...state.recent, id].slice(-15);
      state.autoplayGroupIndex = (groupIndex + 1) % AUTOPLAY_GROUPS.length;

      await this.startTrack(guildId, chosen);
      console.log(`🎵 AUTOPLAY STARTED: ${chosen.title} [${group.name}]`);
      return true;
    } catch (error) {
      console.warn(`⚠️ Direct autoplay search/play failed: ${error?.message || error}`);
      if (state.retryTimer) clearTimeout(state.retryTimer);
      state.retryTimer = setTimeout(() => {
        state.retryTimer = null;
        this.autoplayNext(guildId).catch(() => {});
      }, 15000);
      return false;
    } finally {
      state.autoplayBusy = false;
    }
  }

  async pause(guildId) {
    const player = this.players.get(guildId);
    if (!player) throw new Error("Music player is not active.");
    player.pause();
    const state = this.getState(guildId);
    state.positionOffset = this.getPosition(guildId);
    state.paused = true;
    await this.refreshPanel(guildId).catch(() => {});
  }

  async resume(guildId) {
    const player = this.players.get(guildId);
    if (!player) throw new Error("Music player is not active.");
    player.unpause();
    const state = this.getState(guildId);
    state.startedAt = Date.now();
    state.paused = false;
    await this.refreshPanel(guildId).catch(() => {});
  }

  async skip(guildId) {
    const state = this.getState(guildId);
    if (!state.current) throw new Error("Nothing is playing.");
    const player = this.players.get(guildId);
    this.destroyStream(guildId);
    state.current = null;
    state.startedAt = 0;
    state.positionOffset = 0;
    try { player?.stop(true); } catch {}
    await this.handleTrackEnd(guildId).catch(() => {});
  }

  async stop(guildId) {
    const state = this.getState(guildId);
    this.destroyStream(guildId);
    state.queue = [];
    state.current = null;
    state.startedAt = 0;
    state.positionOffset = 0;
    try { this.players.get(guildId)?.stop(true); } catch {}
    await this.refreshPanel(guildId).catch(() => {});
  }

  async shuffle(guildId) {
    const state = this.getState(guildId);
    for (let i = state.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [state.queue[i], state.queue[j]] = [state.queue[j], state.queue[i]];
    }
    await this.refreshPanel(guildId).catch(() => {});
  }

  async setLoop(guildId, mode) {
    if (!["none", "track", "queue"].includes(mode)) throw new Error("Invalid loop mode.");
    this.getState(guildId).loop = mode;
    await this.refreshPanel(guildId).catch(() => {});
    return mode;
  }

  async setVolume(guildId, level) {
    const state = this.getState(guildId);
    state.volume = Math.max(1, Math.min(100, Number(level) || this.defaultVolume));
    const current = state.current;
    if (current) {
      const position = this.getPosition(guildId);
      await this.startTrack(guildId, current, position).catch(() => {});
    }
    await this.refreshPanel(guildId).catch(() => {});
    return state.volume;
  }

  async seek(guildId, ms) {
    const state = this.getState(guildId);
    if (!state.current) throw new Error("Nothing is playing.");
    const target = Math.max(0, Number(ms) || 0);
    await this.startTrack(guildId, state.current, target);
  }

  async updateVoiceStatus(guildId, status) {
    const channelId = this.musicVoiceChannelId;
    try {
      await this.client.rest.put(`/channels/${channelId}/voice-status`, { body: { status: String(status || "").slice(0, 500) } });
      return true;
    } catch {
      return false;
    }
  }

  updatePresence(track) {
    try {
      this.client.user.setPresence({
        activities: [{ name: this.getTrackTitle(track).slice(0, 128), type: 2 }],
        status: "online"
      });
    } catch {}
  }

  async findPanelChannel(guildId) {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) throw new Error("Server is not available.");
    const me = guild.members.me;
    const ids = [this.musicTextChannelId].filter(Boolean);
    for (const id of ids) {
      const channel = guild.channels.cache.get(id);
      if (channel?.isTextBased?.() && channel?.isSendable?.() && (!me || channel.permissionsFor(me)?.has("SendMessages"))) return channel;
    }
    const named = guild.channels.cache.find(c => {
      if (!c?.isTextBased?.() || !c?.isSendable?.()) return false;
      if (me && !c.permissionsFor(me)?.has("SendMessages")) return false;
      const n = String(c.name || "").toLowerCase();
      return n.includes("music");
    });
    if (named) return named;
    const fallback = guild.systemChannel?.isTextBased?.() && guild.systemChannel?.isSendable?.() ? guild.systemChannel : guild.channels.cache.find(c => c?.isTextBased?.() && c?.isSendable?.() && (!me || c.permissionsFor(me)?.has("SendMessages")));
    if (!fallback) throw new Error("No writable text channel found for the music panel.");
    return fallback;
  }

  buildPanelPayload(guildId) {
    const state = this.getState(guildId);
    const current = state.current;
    const duration = current?.length || 0;
    const position = this.getPosition(guildId);
    const embed = new EmbedBuilder()
      .setTitle("💀 DEATH Music 24/7")
      .setDescription(current ? `🎵 **${this.getTrackTitle(current)}**\nArtist: **${this.getTrackAuthor(current)}**` : "🎵 **Nothing is playing**\nAutoplay is ready to continue music.")
      .addFields(
        { name: "Duration", value: this.formatDuration(duration), inline: true },
        { name: "Position", value: this.formatDuration(position), inline: true },
        { name: "Volume", value: `${state.volume}%`, inline: true },
        { name: "Loop", value: state.loop, inline: true },
        { name: "Autoplay", value: state.autoplay ? "ON" : "OFF", inline: true },
        { name: "Queue", value: String(state.queue.length), inline: true }
      )
      .setFooter({ text: "DEATH × GMAO • Direct Voice Music" })
      .setTimestamp();

    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("death_music_pause").setLabel("Pause").setEmoji("⏸️").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("death_music_resume").setLabel("Resume").setEmoji("▶️").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("death_music_skip").setLabel("Skip").setEmoji("⏭️").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("death_music_stop").setLabel("Stop").setEmoji("⏹️").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("death_music_shuffle").setLabel("Shuffle").setEmoji("🔀").setStyle(ButtonStyle.Secondary)
    );
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("death_music_queue").setLabel("Queue").setEmoji("📜").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("death_music_loop").setLabel("Loop").setEmoji("🔁").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("death_music_vol_down").setLabel("Vol -").setEmoji("🔉").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("death_music_vol_up").setLabel("Vol +").setEmoji("🔊").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("death_music_autoplay").setLabel(`Autoplay ${state.autoplay ? "ON" : "OFF"}`).setEmoji("♾️").setStyle(state.autoplay ? ButtonStyle.Success : ButtonStyle.Secondary)
    );
    const row3 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("death_music_refresh").setLabel("Refresh").setEmoji("🔄").setStyle(ButtonStyle.Secondary)
    );
    return { embeds: [embed], components: [row1, row2, row3] };
  }

  async ensurePanel(guildId) {
    const state = this.getState(guildId);
    const channel = await this.findPanelChannel(guildId);
    if (state.panelMessageId && state.panelChannelId === channel.id) {
      try {
        const msg = await channel.messages.fetch(state.panelMessageId);
        await msg.edit(this.buildPanelPayload(guildId));
        return msg;
      } catch {}
    }
    const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    const existing = messages?.find(m => m.author?.id === this.client.user.id && m.embeds?.[0]?.title === "💀 DEATH Music 24/7");
    if (existing) {
      state.panelMessageId = existing.id;
      state.panelChannelId = channel.id;
      await existing.edit(this.buildPanelPayload(guildId)).catch(() => {});
      return existing;
    }
    const message = await channel.send(this.buildPanelPayload(guildId));
    state.panelMessageId = message.id;
    state.panelChannelId = channel.id;
    return message;
  }

  async refreshPanel(guildId) {
    const state = this.getState(guildId);
    if (!state.panelMessageId || !state.panelChannelId) return false;
    try {
      const guild = this.client.guilds.cache.get(guildId);
      const channel = guild?.channels.cache.get(state.panelChannelId);
      const message = await channel?.messages.fetch(state.panelMessageId);
      if (!message) return false;
      await message.edit(this.buildPanelPayload(guildId));
      return true;
    } catch {
      return false;
    }
  }

  startRecoveryLoop() {
    if (this.recoveryStarted) return;
    this.recoveryStarted = true;
    this.recoveryTimer = setInterval(() => {
      for (const guildId of [this.musicGuildId]) {
        if (!guildId) continue;
        const state = this.getState(guildId);
        if (!state.permanent || state.intentionalLeave) continue;
        const connection = this.connections.get(guildId);
        if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) {
          this.ensure247(guildId).catch(() => {});
        }
      }
    }, 30000);
    console.log("🛡️ Direct music recovery loop active.");
  }

  async handleVoiceStateUpdate(oldState, newState) {
    if (newState.guild?.id !== this.musicGuildId) return;
    if (newState.id !== this.client.user?.id) return;
    const state = this.getState(newState.guild.id);
    if (state.intentionalLeave) return;
    if (newState.channelId !== this.musicVoiceChannelId) {
      console.warn("🟠 DEATH was moved/disconnected from the permanent music channel; reconnecting.");
      await this.reconnect(newState.guild.id, this.musicVoiceChannelId).catch(() => {});
    }
  }

  async handleMemberJoin() {}

  async shutdown() {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    for (const guildId of this.connections.keys()) {
      this.destroyStream(guildId);
      try { this.players.get(guildId)?.stop(true); } catch {}
      try { this.connections.get(guildId)?.destroy(); } catch {}
    }
    this.connections.clear();
    this.players.clear();
  }
}

module.exports = DirectMusicManager;

"use strict";
const crypto = require("node:crypto");
const { Pool } = require("pg");
const API = "https://api.spotify.com/v1";
const ACCOUNTS = "https://accounts.spotify.com";

class SpotifyController {
  constructor({ callbackUrl }) {
    this.clientId = process.env.SPOTIFY_CLIENT_ID || "";
    this.clientSecret = process.env.SPOTIFY_CLIENT_SECRET || "";
    this.callbackUrl = callbackUrl;
    this.scopes = [
      "user-read-private","user-read-email","user-read-playback-state",
      "user-read-currently-playing","user-modify-playback-state"
    ].join(" ");
    this.states = new Map();
    this.pool = process.env.DATABASE_URL ? new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.DATABASE_POOL_MAX || 5),
      ssl: String(process.env.DATABASE_SSL || "false").toLowerCase() === "true"
        ? { rejectUnauthorized: false } : undefined
    }) : null;
  }

  requireConfigured() {
    if (!this.clientId || !this.clientSecret) throw new Error("Spotify is not configured on Railway. Add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET.");
    if (!this.pool) throw new Error("DATABASE_URL is required for Spotify account storage.");
  }

  async init() {
    if (!this.pool) return;
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS spotify_connections (
        discord_user_id TEXT PRIMARY KEY,
        spotify_account_id TEXT NOT NULL,
        spotify_user_id TEXT,
        display_name TEXT,
        refresh_token TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS spotify_guild_controllers (
        guild_id TEXT PRIMARY KEY,
        discord_user_id TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  }

  authUrl(discordUserId, guildId) {
    this.requireConfigured();
    const state = crypto.randomBytes(32).toString("hex");
    this.states.set(state, { discordUserId, guildId, expiresAt: Date.now() + 600000 });
    const url = new URL("/authorize", ACCOUNTS);
    url.search = new URLSearchParams({
      response_type: "code", client_id: this.clientId, scope: this.scopes,
      redirect_uri: this.callbackUrl, state, show_dialog: "true"
    }).toString();
    return url.toString();
  }

  async callback(code, state) {
    this.requireConfigured();
    const pending = this.states.get(state);
    this.states.delete(state);
    if (!pending || pending.expiresAt < Date.now()) throw new Error("Spotify authorization expired. Run /spotify connect again.");

    const response = await fetch(`${ACCOUNTS}/api/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", code, redirect_uri: this.callbackUrl,
        client_id: this.clientId, client_secret: this.clientSecret
      })
    });
    const token = await response.json();
    if (!response.ok) throw new Error(token?.error_description || token?.error || "Spotify token exchange failed.");

    const profile = await this.apiWithToken(token.access_token, "/me");
    await this.pool.query(`
      INSERT INTO spotify_connections
        (discord_user_id, spotify_account_id, spotify_user_id, display_name, refresh_token, updated_at)
      VALUES ($1,$2,$3,$4,$5,NOW())
      ON CONFLICT (discord_user_id) DO UPDATE SET
        spotify_account_id=EXCLUDED.spotify_account_id,
        spotify_user_id=EXCLUDED.spotify_user_id,
        display_name=EXCLUDED.display_name,
        refresh_token=EXCLUDED.refresh_token,
        updated_at=NOW()`,
      [pending.discordUserId, profile.account_id || profile.id, profile.id || null,
       profile.display_name || null, token.refresh_token]
    );
    if (pending.guildId) await this.bindGuild(pending.guildId, pending.discordUserId);
    return { ...pending, displayName: profile.display_name || profile.id || "Spotify user" };
  }

  async getConnection(discordUserId) {
    this.requireConfigured();
    const { rows } = await this.pool.query(
      "SELECT discord_user_id, spotify_account_id, spotify_user_id, display_name FROM spotify_connections WHERE discord_user_id=$1",
      [discordUserId]);
    return rows[0] || null;
  }

  async disconnect(discordUserId) {
    this.requireConfigured();
    await this.pool.query("DELETE FROM spotify_connections WHERE discord_user_id=$1", [discordUserId]);
    await this.pool.query("DELETE FROM spotify_guild_controllers WHERE discord_user_id=$1", [discordUserId]);
  }

  async getGuildController(guildId) {
    this.requireConfigured();
    const { rows } = await this.pool.query(`
      SELECT g.discord_user_id, c.display_name
      FROM spotify_guild_controllers g
      LEFT JOIN spotify_connections c ON c.discord_user_id=g.discord_user_id
      WHERE g.guild_id=$1`, [guildId]);
    return rows[0] || null;
  }

  async bindGuild(guildId, discordUserId) {
    await this.pool.query(`
      INSERT INTO spotify_guild_controllers (guild_id, discord_user_id, updated_at)
      VALUES ($1,$2,NOW())
      ON CONFLICT (guild_id) DO UPDATE SET
        discord_user_id=EXCLUDED.discord_user_id, updated_at=NOW()`,
      [guildId, discordUserId]);
  }

  async clearGuild(guildId) {
    this.requireConfigured();
    await this.pool.query("DELETE FROM spotify_guild_controllers WHERE guild_id=$1", [guildId]);
  }

  async token(discordUserId) {
    this.requireConfigured();
    const { rows } = await this.pool.query(
      "SELECT refresh_token FROM spotify_connections WHERE discord_user_id=$1", [discordUserId]);
    if (!rows[0]) throw new Error("Spotify is not connected. Run /spotify connect first.");

    const response = await fetch(`${ACCOUNTS}/api/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token", refresh_token: rows[0].refresh_token,
        client_id: this.clientId, client_secret: this.clientSecret
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error_description || data?.error || "Spotify token refresh failed.");
    if (data.refresh_token) {
      await this.pool.query(
        "UPDATE spotify_connections SET refresh_token=$1, updated_at=NOW() WHERE discord_user_id=$2",
        [data.refresh_token, discordUserId]);
    }
    return data.access_token;
  }

  async apiWithToken(accessToken, path, options = {}) {
    const response = await fetch(`${API}${path}`, {
      ...options,
      headers: {
        accept: "application/json",
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...(options.headers || {}),
        authorization: `Bearer ${accessToken}`
      }
    });
    if (response.status === 204) return null;
    const text = await response.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch {}
    if (!response.ok) {
      const error = new Error(data?.error?.message || data?.error_description || `Spotify API HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  async api(discordUserId, path, options = {}) {
    return this.apiWithToken(await this.token(discordUserId), path, options);
  }

  async resolveController(guildId, discordUserId) {
    const bound = await this.getGuildController(guildId);
    if (bound) return bound;
    const own = await this.getConnection(discordUserId);
    if (!own) throw new Error("Connect your Spotify Premium account with /spotify connect first.");
    await this.bindGuild(guildId, discordUserId);
    return { discord_user_id: discordUserId, display_name: own.display_name || "Spotify user" };
  }

  async search(discordUserId, query) {
    let q = String(query || "").trim();
    const match = q.match(/open\\.spotify\\.com\\/track\\/([A-Za-z0-9]+)/i);
    if (match) q = `track:${match[1]}`;
    if (!q) throw new Error("Enter a song name or Spotify track link.");
    const url = new URL("/search", API);
    url.search = new URLSearchParams({ q, type: "track", limit: "5" }).toString();
    const data = await this.api(discordUserId, url.pathname + url.search);
    return data?.tracks?.items || [];
  }

  async devices(discordUserId) {
    const data = await this.api(discordUserId, "/me/player/devices");
    return Array.isArray(data?.devices) ? data.devices : [];
  }

  async activeDevice(discordUserId) {
    const devices = (await this.devices(discordUserId)).filter(d => d?.id && !d.is_restricted);
    return devices.find(d => d.is_active) || devices[0] || null;
  }

  async playQuery(guildId, requesterId, query) {
    const controller = await this.resolveController(guildId, requesterId);
    const tracks = await this.search(controller.discord_user_id, query);
    const track = tracks[0];
    if (!track) throw new Error(`No Spotify track found for "${query}".`);
    const device = await this.activeDevice(controller.discord_user_id);
    if (!device) throw new Error("Open Spotify on your phone/PC first, then run /play again.");
    await this.api(controller.discord_user_id, `/me/player/play?device_id=${encodeURIComponent(device.id)}`, {
      method: "PUT", body: JSON.stringify({ uris: [track.uri] })
    });
    return {
      controller,
      track: {
        identifier: track.id, id: track.id,
        url: track.external_urls?.spotify || `https://open.spotify.com/track/${track.id}`,
        title: track.name,
        author: (track.artists || []).map(a => a.name).join(", ") || "Unknown artist",
        length: Number(track.duration_ms || 0),
        thumbnail: track.album?.images?.[0]?.url || null,
        spotifyUri: track.uri, source: "spotify"
      }
    };
  }

  async status(guildId, requesterId) {
    const c = await this.resolveController(guildId, requesterId);
    return { controller: c, playback: await this.api(c.discord_user_id, "/me/player") };
  }

  async pause(guildId, requesterId) {
    const c = await this.resolveController(guildId, requesterId);
    await this.api(c.discord_user_id, "/me/player/pause", { method: "PUT" }); return c;
  }
  async resume(guildId, requesterId) {
    const c = await this.resolveController(guildId, requesterId);
    await this.api(c.discord_user_id, "/me/player/play", { method: "PUT", body: JSON.stringify({}) }); return c;
  }
  async next(guildId, requesterId) {
    const c = await this.resolveController(guildId, requesterId);
    await this.api(c.discord_user_id, "/me/player/next", { method: "POST" }); return c;
  }
  async previous(guildId, requesterId) {
    const c = await this.resolveController(guildId, requesterId);
    await this.api(c.discord_user_id, "/me/player/previous", { method: "POST" }); return c;
  }
  async shuffle(guildId, requesterId, enabled = true) {
    const c = await this.resolveController(guildId, requesterId);
    await this.api(c.discord_user_id, `/me/player/shuffle?state=${Boolean(enabled)}`, { method: "PUT" }); return c;
  }
  async repeat(guildId, requesterId, state = "off") {
    const c = await this.resolveController(guildId, requesterId);
    const value = ["track","context","off"].includes(state) ? state : "off";
    await this.api(c.discord_user_id, `/me/player/repeat?state=${value}`, { method: "PUT" }); return c;
  }
  async volume(guildId, requesterId, value) {
    const c = await this.resolveController(guildId, requesterId);
    const volume = Math.max(0, Math.min(100, Number(value)));
    await this.api(c.discord_user_id, `/me/player/volume?volume_percent=${volume}`, { method: "PUT" });
    return { controller: c, volume };
  }
}
module.exports = SpotifyController;

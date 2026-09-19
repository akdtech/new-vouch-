"use strict";

/* Persistent playlists backed by the Railway PostgreSQL database. */
const { Pool } = require("pg");
const MusicManager = require("./DirectMusicManager");

let pool = null;
let initPromise = null;

function db() {
  if (!process.env.DATABASE_URL) throw new Error("Playlist storage is not configured (DATABASE_URL is missing).");
  if (!pool) pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 8000,
    ssl: String(process.env.PGSSL || "false").toLowerCase() === "true" ? { rejectUnauthorized: false } : undefined
  });
  return pool;
}

async function init() {
  if (!initPromise) {
    initPromise = db().query(`
      CREATE TABLE IF NOT EXISTS death_music_playlists (
        guild_id TEXT NOT NULL,
        name TEXT NOT NULL,
        owner_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (guild_id, name)
      );
      CREATE TABLE IF NOT EXISTS death_music_playlist_tracks (
        guild_id TEXT NOT NULL,
        playlist_name TEXT NOT NULL,
        position INTEGER NOT NULL,
        identifier TEXT,
        url TEXT NOT NULL,
        title TEXT NOT NULL,
        author TEXT,
        length BIGINT NOT NULL DEFAULT 0,
        thumbnail TEXT,
        PRIMARY KEY (guild_id, playlist_name, position),
        FOREIGN KEY (guild_id, playlist_name) REFERENCES death_music_playlists(guild_id, name) ON DELETE CASCADE
      );
    `).catch(error => { initPromise = null; throw error; });
  }
  return initPromise;
}

function normalizeName(name) {
  const value = String(name || "").trim().replace(/\s+/g, " ").toLowerCase();
  if (!value) throw new Error("Please provide a playlist name.");
  if (value.length > 80) throw new Error("Playlist name must be 80 characters or fewer.");
  return value;
}

MusicManager.prototype.playlistCreate = async function(guildId, name, ownerId) {
  await init(); const n = normalizeName(name);
  try { await db().query(`INSERT INTO death_music_playlists (guild_id,name,owner_id) VALUES ($1,$2,$3)`, [guildId,n,ownerId||null]); }
  catch (e) { if (e?.code === "23505") throw new Error(`Playlist **${n}** already exists.`); throw e; }
  return n;
};

MusicManager.prototype.playlistAdd = async function(guildId, name, track) {
  await init(); const n = normalizeName(name);
  const exists = await db().query(`SELECT 1 FROM death_music_playlists WHERE guild_id=$1 AND name=$2`, [guildId,n]);
  if (!exists.rowCount) throw new Error(`Playlist **${n}** does not exist. Create it first.`);
  if (!track?.url) throw new Error("That track has no playable URL.");
  const next = await db().query(`SELECT COALESCE(MAX(position),0)+1 AS next FROM death_music_playlist_tracks WHERE guild_id=$1 AND playlist_name=$2`, [guildId,n]);
  const position = Number(next.rows[0]?.next || 1);
  await db().query(`INSERT INTO death_music_playlist_tracks (guild_id,playlist_name,position,identifier,url,title,author,length,thumbnail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [guildId,n,position,track.identifier||track.id||null,track.url,String(track.title||"Unknown track").slice(0,500),String(track.author||"Unknown artist").slice(0,300),Number(track.length||0),track.thumbnail||null]);
  return position;
};

MusicManager.prototype.playlistList = async function(guildId) {
  await init();
  const r = await db().query(`SELECT p.name, COUNT(t.position)::int AS tracks FROM death_music_playlists p LEFT JOIN death_music_playlist_tracks t ON t.guild_id=p.guild_id AND t.playlist_name=p.name WHERE p.guild_id=$1 GROUP BY p.guild_id,p.name ORDER BY p.name`, [guildId]);
  return r.rows;
};

MusicManager.prototype.playlistGet = async function(guildId, name) {
  await init(); const n = normalizeName(name);
  const r = await db().query(`SELECT identifier,url,title,author,length,thumbnail FROM death_music_playlist_tracks WHERE guild_id=$1 AND playlist_name=$2 ORDER BY position`, [guildId,n]);
  if (!r.rowCount) {
    const exists = await db().query(`SELECT 1 FROM death_music_playlists WHERE guild_id=$1 AND name=$2`, [guildId,n]);
    if (!exists.rowCount) throw new Error(`Playlist **${n}** does not exist.`);
  }
  return r.rows.map(x => ({ identifier:x.identifier, id:x.identifier, url:x.url, title:x.title, author:x.author||"Unknown artist", length:Number(x.length||0), thumbnail:x.thumbnail||null, requester:this.client.user, isAutoplay:false }));
};

MusicManager.prototype.playlistDelete = async function(guildId, name) {
  await init(); const n = normalizeName(name);
  const r = await db().query(`DELETE FROM death_music_playlists WHERE guild_id=$1 AND name=$2`, [guildId,n]);
  if (!r.rowCount) throw new Error(`Playlist **${n}** does not exist.`);
  return n;
};

MusicManager.prototype.playlistSaveQueue = async function(guildId, name, ownerId) {
  await init(); const n = normalizeName(name);
  const tracks = this.getQueue(guildId).filter(t => t?.url);
  if (!tracks.length) throw new Error("There is no music in the current queue to save.");
  await db().query(`INSERT INTO death_music_playlists (guild_id,name,owner_id) VALUES ($1,$2,$3) ON CONFLICT (guild_id,name) DO UPDATE SET owner_id=COALESCE(EXCLUDED.owner_id,death_music_playlists.owner_id)`, [guildId,n,ownerId||null]);
  await db().query(`DELETE FROM death_music_playlist_tracks WHERE guild_id=$1 AND playlist_name=$2`, [guildId,n]);
  for (let i=0;i<tracks.length;i++) { const t=tracks[i]; await db().query(`INSERT INTO death_music_playlist_tracks (guild_id,playlist_name,position,identifier,url,title,author,length,thumbnail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [guildId,n,i+1,t.identifier||t.id||null,t.url,String(t.title||"Unknown track").slice(0,500),String(t.author||"Unknown artist").slice(0,300),Number(t.length||0),t.thumbnail||null]); }
  return {name:n,count:tracks.length};
};

MusicManager.prototype.playlistPlay = async function(guildId, name) {
  const tracks = await this.playlistGet(guildId,name);
  if (!tracks.length) throw new Error("That playlist is empty.");
  const state = this.getState(guildId);
  const player = this.players.get(guildId) || await this.ensure247(guildId);
  if (!state.current && player?.state?.status !== "playing" && player?.state?.status !== "paused") {
    const first=tracks.shift(); state.queue.push(...tracks); await this.startTrack(guildId,first); return {startedNow:true,count:tracks.length+1,first};
  }
  state.queue.push(...tracks); return {startedNow:false,count:tracks.length,first:tracks[0]||null};
};

console.log("📚 DEATH playlists loaded: persistent PostgreSQL music libraries.");

// FINAL PATCH MUST LOAD LAST so it owns search/playback/autoplay truth.
require("./directFinalFixPatch");

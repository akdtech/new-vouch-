"use strict";

/* DEATH direct autoplay intelligence: short songs + related artist/genre chaining. */
const MusicManager = require("./DirectMusicManager");
const MAX_AUTOPLAY_MS = 8 * 60 * 1000;
const IDEAL_MIN_MS = 90 * 1000;
const IDEAL_MAX_MS = 6 * 60 * 1000;
const AUTOPLAY_BLOCK_MS = 15 * 60 * 1000;
const BAD_TITLE = /\b(\d+\s*(?:hour|hr)s?|hour\s*mix|\bmix\b|playlist|compilation|continuous|nonstop|radio|medley|full\s*album|album|collection|lofi\s*mix|sleep\s*music|long\s*version)\b/i;
const STOP_WORDS = new Set(["the","a","an","and","or","of","to","for","in","on","at","with","from","is","it","my","your","me","you","official","video","audio","music","song","songs","lyrics","lyric","remix","edit","version","full","hd","4k","feat","ft"]);

function clean(value){return String(value || "").replace(/\s+/g," ").trim();}
function artistIsUseful(artist){const v=clean(artist).toLowerCase();return v&&!['unknown artist','various artists','various','youtube','youtube music','topic','unknown'].includes(v);}
function words(value){return clean(value).toLowerCase().replace(/[^a-z0-9\s]/gi," ").split(/\s+/).filter(w=>w.length>=3&&!STOP_WORDS.has(w));}
function artistMatches(a,b){const l=clean(a).toLowerCase(),r=clean(b).toLowerCase();return !!l&&!!r&&(l===r||l.includes(r)||r.includes(l));}
function trackId(track){return track?.identifier||track?.id||track?.url;}
function isAutoplayCandidate(track){const title=clean(track?.title),length=Number(track?.length||0);return Number.isFinite(length)&&length>0&&length<=MAX_AUTOPLAY_MS&&!BAD_TITLE.test(title);}
function candidateScore(track,context,recent){const title=clean(track?.title),artist=clean(track?.author||track?.uploader),length=Number(track?.length||0),haystack=`${title} ${artist}`.toLowerCase();let score=0;if(artistMatches(artist,context.artist))score+=150;for(const word of context.words||[])if(haystack.includes(word))score+=20;if(length>=IDEAL_MIN_MS&&length<=IDEAL_MAX_MS)score+=25;else if(length>IDEAL_MAX_MS)score-=5;else score-=5;const id=trackId(track);if(id&&recent.includes(id))score-=1000;return score;}
function isYoutubeBotBlock(error){const text=String(error?.message||error||"").toLowerCase();return text.includes("sign in to confirm")||text.includes("not a bot")||text.includes("login_required");}

const originalPlay=MusicManager.prototype.play;
MusicManager.prototype.play=async function patchedPlay(args){
  const result=await originalPlay.call(this,args),state=this.getState(args.guildId),track=result?.track||state.current||null,title=clean(track?.title),artist=clean(track?.author||track?.uploader),query=clean(args?.query);
  state.autoplayBlockedUntil=0;
  state.autoplayBlockNoticeUntil=0;
  state.autoplayContext={artist:artistIsUseful(artist)?artist:"",title,query,words:[...new Set([...words(title),...words(query)])].slice(0,8)};
  console.log(`🎯 Autoplay context: ${artist||"search/genre"}${title?` — ${title}`:""}`);
  return result;
};

MusicManager.prototype.autoplayNext=async function contextAwareAutoplay(guildId){
  const state=this.getState(guildId),player=this.players.get(guildId);
  if(!player||!state.autoplay||state.intentionalLeave||state.autoplayBusy)return false;
  if(state.current||state.queue.length)return false;
  if(Number(state.autoplayBlockedUntil||0)>Date.now())return false;
  state.autoplayBusy=true;
  try{
    const context=state.autoplayContext||{},recent=Array.isArray(state.recent)?state.recent:[];
    const artist=clean(context.artist);
    const contextTitle=clean(context.title);
    const contextQuery=clean(context.query);
    const contextWords=Array.isArray(context.words)&&context.words.length ? context.words : words(`${contextTitle} ${contextQuery}`);
    const queries=[];

    if(artist){
      queries.push(`${artist} songs`);
      if(contextWords.length)queries.push(`${artist} ${contextWords.slice(0,2).join(" ")} songs`);
    }
    if(contextWords.length){
      queries.push(`${contextWords.slice(0,3).join(" ")} songs`);
      if(contextQuery)queries.push(`${contextQuery} similar songs`);
    }
    if(!queries.length)queries.push("popular songs 2026");

    let chosen=null,chosenScore=-Infinity;
    for(const query of [...new Set(queries)]){
      if(/\bundefined\b|\bnull\b/i.test(query))continue;
      try{
        const result=await this.search(query,this.client.user);
        const candidates=(result?.tracks||[]).filter(isAutoplayCandidate).filter(track=>!recent.includes(trackId(track))).map(track=>({track,score:candidateScore(track,{artist,words:contextWords},recent)})).sort((a,b)=>b.score-a.score);
        if(!candidates.length)continue;
        const topScore=candidates[0].score,top=candidates.filter(item=>item.score>=topScore-15).slice(0,5),picked=top[Math.floor(Math.random()*top.length)];
        if(picked&&picked.score>chosenScore){chosen=picked.track;chosenScore=picked.score;}
        if(chosen&&chosenScore>=150)break;
      }catch(error){
        if(isYoutubeBotBlock(error))throw error;
        console.warn(`⚠️ Context autoplay search failed: ${query} — ${error?.message||error}`);
      }
    }

    if(!chosen){
      const fallback=await this.search("popular songs 2026",this.client.user).catch(error=>{if(isYoutubeBotBlock(error))throw error;return null;});
      chosen=(fallback?.tracks||[]).filter(isAutoplayCandidate).find(track=>!recent.includes(trackId(track)))||null;
    }
    if(!chosen||!isAutoplayCandidate(chosen)){console.warn("⚠️ No short individual autoplay track found; refusing long-track fallback.");return false;}

    const id=trackId(chosen);if(id)state.recent=[...recent,id].slice(-20);
    chosen.isAutoplay=true;chosen.autoplayGroup=artist?`Same artist / related: ${artist}`:"Related search / genre";
    const chosenArtist=clean(chosen.author||chosen.uploader);
    state.autoplayContext={
      artist:artistIsUseful(chosenArtist)?chosenArtist:artist,
      title:clean(chosen.title),
      query:contextQuery||clean(chosen.title),
      words:[...new Set([...(contextWords||[]),...words(chosen.title)])].slice(0,10)
    };

    await this.startTrack(guildId,chosen);
    console.log(`🎯 Short-track autoplay started: ${this.getTrackTitle(chosen)} — ${this.getTrackAuthor(chosen)} | ${chosen.autoplayGroup} | max=8m`);
    return true;
  }catch(error){
    if(isYoutubeBotBlock(error)){
      state.autoplayBlockedUntil=Date.now()+AUTOPLAY_BLOCK_MS;
      if(Number(state.autoplayBlockNoticeUntil||0)<=Date.now()){
        state.autoplayBlockNoticeUntil=Date.now()+AUTOPLAY_BLOCK_MS;
        console.warn("⏸️ Autoplay paused temporarily because YouTube is returning bot-check responses. Retry window=15m.");
      }
    }
    console.error("❌ Context autoplay error:",error?.message||error);
    state.current=null;
    return false;
  }finally{state.autoplayBusy=false;}
};

console.log("🎯 DEATH smart autoplay loaded: related songs + hard 8-minute maximum + artist/genre chaining + safe autoplay query handling.");

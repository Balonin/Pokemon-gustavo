const express = require('express');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;

/* ------------------------------------------------------------------ */
/* Storage: Postgres when DATABASE_URL is set, in-memory otherwise.     */
/* ------------------------------------------------------------------ */
let store;
let dbReady = Promise.resolve();   // listen only after tables/columns exist (see initDb)

if (DATABASE_URL) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
  });

  async function initDb() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        gm_name TEXT NOT NULL,
        gm_token TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS members (
        token TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS pokemon (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        owner TEXT NOT NULL,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS teams (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        owner TEXT NOT NULL,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS npcs (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        avatar TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS battles (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_battles_room ON battles(room_id);
      ALTER TABLE members ADD COLUMN IF NOT EXISTS avatar TEXT NOT NULL DEFAULT '';
      ALTER TABLE members ADD COLUMN IF NOT EXISTS theme TEXT NOT NULL DEFAULT '';
      ALTER TABLE members ADD COLUMN IF NOT EXISTS char_name TEXT NOT NULL DEFAULT '';
      ALTER TABLE npcs ADD COLUMN IF NOT EXISTS theme TEXT NOT NULL DEFAULT '';
      ALTER TABLE rooms ADD COLUMN IF NOT EXISTS banned TEXT NOT NULL DEFAULT '[]';
      CREATE TABLE IF NOT EXISTS media (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        owner TEXT NOT NULL DEFAULT '',
        mime TEXT NOT NULL,
        data BYTEA NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_pokemon_room ON pokemon(room_id);
      CREATE INDEX IF NOT EXISTS idx_teams_room ON teams(room_id);
      CREATE INDEX IF NOT EXISTS idx_members_room ON members(room_id);
      CREATE INDEX IF NOT EXISTS idx_npcs_room ON npcs(room_id);
    `);
  }
  dbReady = initDb().catch(e => console.error('DB init failed:', e));

  store = {
    async createRoom(room) {
      await pool.query(
        'INSERT INTO rooms (id, name, gm_name, gm_token) VALUES ($1,$2,$3,$4)',
        [room.id, room.name, room.gmName, room.gmToken]
      );
    },
    async getRoom(id) {
      const r = await pool.query('SELECT * FROM rooms WHERE id = $1', [id]);
      if (!r.rows[0]) return null;
      const x = r.rows[0];
      return { id: x.id, name: x.name, gmName: x.gm_name, gmToken: x.gm_token, banned: parseNameList(x.banned) };
    },
    async renameRoom(id, name) { await pool.query('UPDATE rooms SET name = $2 WHERE id = $1', [id, name]); },
    async setRoomBanned(id, list) { await pool.query('UPDATE rooms SET banned = $2 WHERE id = $1', [id, JSON.stringify(list)]); },
    // every token (device) of that name in the room
    async removeMember(roomId, name) { await pool.query('DELETE FROM members WHERE room_id = $1 AND name = $2', [roomId, name]); },
    async deleteMediaOf(roomId, owner) { await pool.query('DELETE FROM media WHERE room_id = $1 AND owner = $2', [roomId, owner]); },
    // everything in the campaign goes with it; explicit deletes (in one transaction) instead of trusting
    // ON DELETE CASCADE, in case an old database has a table without it
    async deleteRoom(id) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const t of ['battles', 'pokemon', 'teams', 'npcs', 'media', 'members']) {
          await client.query(`DELETE FROM ${t} WHERE room_id = $1`, [id]);
        }
        await client.query('DELETE FROM rooms WHERE id = $1', [id]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
    async addMember(m) {
      await pool.query(
        'INSERT INTO members (token, room_id, name, role, avatar, theme, char_name) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [m.token, m.roomId, m.name, m.role, m.avatar || '', themeText(m.theme), m.character || '']
      );
    },
    async getMember(token) {
      const r = await pool.query('SELECT * FROM members WHERE token = $1', [token]);
      if (!r.rows[0]) return null;
      const x = r.rows[0];
      return { token: x.token, roomId: x.room_id, name: x.name, role: x.role, avatar: x.avatar || '', theme: parseTheme(x.theme), character: x.char_name || '' };
    },
    async listMembers(roomId) {
      const r = await pool.query('SELECT name, role, avatar, theme, char_name FROM members WHERE room_id = $1 ORDER BY created_at', [roomId]);
      return r.rows.map(x => ({ name: x.name, role: x.role, avatar: x.avatar, theme: parseTheme(x.theme), character: x.char_name || '' }));
    },
    /* the same person may hold several tokens (one per device): keep the avatar in sync on all of them */
    async setMemberAvatar(roomId, name, avatar) {
      await pool.query('UPDATE members SET avatar = $3 WHERE room_id = $1 AND name = $2', [roomId, name, avatar]);
    },
    async setMemberTheme(roomId, name, theme) {
      await pool.query('UPDATE members SET theme = $3 WHERE room_id = $1 AND name = $2', [roomId, name, themeText(theme)]);
    },
    async setMemberCharacter(roomId, name, character) {
      await pool.query('UPDATE members SET char_name = $3 WHERE room_id = $1 AND name = $2', [roomId, name, character]);
    },
    async listNpcs(roomId) {
      const r = await pool.query('SELECT id, name, avatar, theme FROM npcs WHERE room_id = $1 ORDER BY created_at', [roomId]);
      return r.rows.map(x => ({ ...x, theme: parseTheme(x.theme) }));
    },
    async getNpc(id) {
      const r = await pool.query('SELECT id, room_id, name, avatar, theme FROM npcs WHERE id = $1', [id]);
      if (!r.rows[0]) return null;
      const x = r.rows[0];
      return { id: x.id, roomId: x.room_id, name: x.name, avatar: x.avatar || '', theme: parseTheme(x.theme) };
    },
    async upsertNpc(npc) {
      await pool.query(
        `INSERT INTO npcs (id, room_id, name, avatar, theme) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (id) DO UPDATE SET name = $3, avatar = $4, theme = $5`,
        [npc.id, npc.roomId, npc.name, npc.avatar, themeText(npc.theme)]
      );
    },
    async deleteNpc(id, owner) {
      await pool.query('DELETE FROM pokemon WHERE owner = $1', [owner]);
      await pool.query('DELETE FROM npcs WHERE id = $1', [id]);
    },
    async listBattles(roomId) {
      const r = await pool.query('SELECT id, data FROM battles WHERE room_id = $1 ORDER BY updated_at DESC', [roomId]);
      return r.rows.map(x => ({ id: x.id, ...x.data }));
    },
    async getBattle(id) {
      const r = await pool.query('SELECT id, room_id, data FROM battles WHERE id = $1', [id]);
      if (!r.rows[0]) return null;
      const x = r.rows[0];
      return { id: x.id, roomId: x.room_id, ...x.data };
    },
    async upsertBattle(id, roomId, data) {
      await pool.query(
        `INSERT INTO battles (id, room_id, data, updated_at) VALUES ($1,$2,$3,NOW())
         ON CONFLICT (id) DO UPDATE SET data = $3, updated_at = NOW()`,
        [id, roomId, data]
      );
    },
    async deleteBattle(id) { await pool.query('DELETE FROM battles WHERE id = $1', [id]); },
    async putMedia(f) {
      await pool.query('INSERT INTO media (id, room_id, owner, mime, data) VALUES ($1,$2,$3,$4,$5)', [f.id, f.roomId, f.owner, f.mime, f.data]);
    },
    async getMediaInfo(id) {   // without the bytes
      const r = await pool.query('SELECT id, room_id, owner, mime FROM media WHERE id = $1', [id]);
      if (!r.rows[0]) return null;
      const x = r.rows[0];
      return { id: x.id, roomId: x.room_id, owner: x.owner, mime: x.mime };
    },
    async getMedia(id) {
      const r = await pool.query('SELECT id, room_id, mime, data FROM media WHERE id = $1', [id]);
      if (!r.rows[0]) return null;
      const x = r.rows[0];
      return { id: x.id, roomId: x.room_id, mime: x.mime, data: x.data };
    },
    async deleteMedia(id) { await pool.query('DELETE FROM media WHERE id = $1', [id]); },
    async listPokemon(roomId) {
      const r = await pool.query('SELECT id, owner, data FROM pokemon WHERE room_id = $1', [roomId]);
      return r.rows.map(x => ({ id: x.id, owner: x.owner, ...x.data }));
    },
    async getPokemon(id) {
      const r = await pool.query('SELECT id, room_id, owner, data FROM pokemon WHERE id = $1', [id]);
      if (!r.rows[0]) return null;
      const x = r.rows[0];
      return { id: x.id, roomId: x.room_id, owner: x.owner, ...x.data };
    },
    async upsertPokemon(id, roomId, owner, data) {
      await pool.query(
        `INSERT INTO pokemon (id, room_id, owner, data, updated_at) VALUES ($1,$2,$3,$4,NOW())
         ON CONFLICT (id) DO UPDATE SET data = $4, updated_at = NOW()`,
        [id, roomId, owner, data]
      );
    },
    async deletePokemon(id) { await pool.query('DELETE FROM pokemon WHERE id = $1', [id]); },
    async listTeams(roomId) {
      const r = await pool.query('SELECT id, owner, data FROM teams WHERE room_id = $1', [roomId]);
      return r.rows.map(x => ({ id: x.id, owner: x.owner, ...x.data }));
    },
    async getTeam(id) {
      const r = await pool.query('SELECT id, room_id, owner, data FROM teams WHERE id = $1', [id]);
      if (!r.rows[0]) return null;
      const x = r.rows[0];
      return { id: x.id, roomId: x.room_id, owner: x.owner, ...x.data };
    },
    async upsertTeam(id, roomId, owner, data) {
      await pool.query(
        `INSERT INTO teams (id, room_id, owner, data, updated_at) VALUES ($1,$2,$3,$4,NOW())
         ON CONFLICT (id) DO UPDATE SET data = $4, updated_at = NOW()`,
        [id, roomId, owner, data]
      );
    },
    async deleteTeam(id) { await pool.query('DELETE FROM teams WHERE id = $1', [id]); }
  };
  console.log('Storage: PostgreSQL');
} else {
  const mem = { rooms: {}, members: {}, pokemon: {}, teams: {}, npcs: {}, battles: {}, media: {} };
  store = {
    async createRoom(room) { mem.rooms[room.id] = room; },
    async getRoom(id) { return mem.rooms[id] || null; },
    async renameRoom(id, name) { if (mem.rooms[id]) mem.rooms[id].name = name; },
    async setRoomBanned(id, list) { if (mem.rooms[id]) mem.rooms[id].banned = [...list]; },
    async removeMember(roomId, name) {
      Object.entries(mem.members).forEach(([t, x]) => { if (x.roomId === roomId && x.name === name) delete mem.members[t]; });
    },
    async deleteMediaOf(roomId, owner) {
      Object.entries(mem.media).forEach(([id, f]) => { if (f.roomId === roomId && f.owner === owner) delete mem.media[id]; });
    },
    async deleteRoom(id) {
      ['battles', 'pokemon', 'teams', 'npcs', 'media', 'members'].forEach(t => {
        Object.entries(mem[t]).forEach(([k, x]) => { if (x.roomId === id) delete mem[t][k]; });
      });
      delete mem.rooms[id];
    },
    async addMember(m) { mem.members[m.token] = { avatar: '', theme: null, character: '', ...m }; },
    async getMember(token) { return mem.members[token] || null; },
    async listMembers(roomId) {
      return Object.values(mem.members).filter(m => m.roomId === roomId)
        .map(m => ({ name: m.name, role: m.role, avatar: m.avatar || '', theme: m.theme || null, character: m.character || '' }));
    },
    async setMemberAvatar(roomId, name, avatar) {
      Object.values(mem.members).forEach(m => { if (m.roomId === roomId && m.name === name) m.avatar = avatar; });
    },
    async setMemberTheme(roomId, name, theme) {
      Object.values(mem.members).forEach(m => { if (m.roomId === roomId && m.name === name) m.theme = theme; });
    },
    async setMemberCharacter(roomId, name, character) {
      Object.values(mem.members).forEach(m => { if (m.roomId === roomId && m.name === name) m.character = character; });
    },
    async listNpcs(roomId) {
      return Object.values(mem.npcs).filter(n => n.roomId === roomId)
        .map(n => ({ id: n.id, name: n.name, avatar: n.avatar, theme: n.theme || null }));
    },
    async getNpc(id) { return mem.npcs[id] || null; },
    async upsertNpc(npc) { mem.npcs[npc.id] = { ...npc }; },
    async deleteNpc(id, owner) {
      Object.values(mem.pokemon).forEach(p => { if (p.owner === owner) delete mem.pokemon[p.id]; });
      delete mem.npcs[id];
    },
    async listBattles(roomId) {
      return Object.values(mem.battles).filter(b => b.roomId === roomId)
        .sort((x, y) => y.updatedAt - x.updatedAt).map(b => ({ id: b.id, ...b.data }));
    },
    async getBattle(id) {
      const b = mem.battles[id];
      return b ? { id: b.id, roomId: b.roomId, ...b.data } : null;
    },
    async upsertBattle(id, roomId, data) { mem.battles[id] = { id, roomId, data, updatedAt: Date.now() }; },
    async deleteBattle(id) { delete mem.battles[id]; },
    async putMedia(f) { mem.media[f.id] = { ...f }; },
    async getMedia(id) { return mem.media[id] || null; },
    async getMediaInfo(id) { const f = mem.media[id]; return f ? { id: f.id, roomId: f.roomId, owner: f.owner, mime: f.mime } : null; },
    async deleteMedia(id) { delete mem.media[id]; },
    async listPokemon(roomId) {
      return Object.values(mem.pokemon).filter(p => p.roomId === roomId)
        .map(p => ({ id: p.id, owner: p.owner, ...p.data }));
    },
    async getPokemon(id) {
      const p = mem.pokemon[id];
      return p ? { id: p.id, roomId: p.roomId, owner: p.owner, ...p.data } : null;
    },
    async upsertPokemon(id, roomId, owner, data) { mem.pokemon[id] = { id, roomId, owner, data }; },
    async deletePokemon(id) { delete mem.pokemon[id]; },
    async listTeams(roomId) {
      return Object.values(mem.teams).filter(t => t.roomId === roomId)
        .map(t => ({ id: t.id, owner: t.owner, ...t.data }));
    },
    async getTeam(id) {
      const t = mem.teams[id];
      return t ? { id: t.id, roomId: t.roomId, owner: t.owner, ...t.data } : null;
    },
    async upsertTeam(id, roomId, owner, data) { mem.teams[id] = { id, roomId, owner, data }; },
    async deleteTeam(id) { delete mem.teams[id]; }
  };
  console.log('Storage: IN-MEMORY (data is lost on restart — set DATABASE_URL for persistence)');
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
function parseNameList(s) {
  try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v.map(String) : []; } catch (e) { return []; }
}
// a blocked name is refused ignoring case ("Diogo" also blocks "diogo")
const isBlocked = (room, name) => (room.banned || []).some(b => b.toLowerCase() === name.toLowerCase());
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function roomCode(n = 6) {
  let out = '';
  const bytes = crypto.randomBytes(n);
  for (let i = 0; i < n; i++) out += CODE_CHARS[bytes[i] % CODE_CHARS.length];
  return out;
}
function token() { return crypto.randomBytes(24).toString('hex'); }
function uid() { return crypto.randomBytes(10).toString('hex'); }

async function auth(req, res, next) {
  const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!t) return res.status(401).json({ error: 'sem_token' });
  const member = await store.getMember(t);
  if (!member) return res.status(401).json({ error: 'token_invalido' });
  req.member = member;
  next();
}
const isGM = m => m.role === 'gm';

/* NPC fichas are owned by "npc:<id>", so a player can never claim them by typing a name */
const NPC_PREFIX = 'npc:';
const npcOwner = id => NPC_PREFIX + id;
function cleanTrainerName(raw) {
  const name = String(raw || '').trim().slice(0, 40);
  if (name.toLowerCase().startsWith(NPC_PREFIX)) return '';
  return name;
}

/* avatar: '' (placeholder), 'mon:<sprite id>' (Pokémon sprite; forms use ids like 10229) or a small raster data URL.
   SVG is refused on purpose: it can carry scripts. Returns null when invalid. */
const AVATAR_MAX = 200000;
function cleanAvatar(raw) {
  const a = String(raw || '');
  if (a === '') return '';
  if (/^mon:\d{1,5}$/.test(a)) return a;
  if (a.length <= AVATAR_MAX && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/.test(a)) return a;
  return null;
}

/* ------------------------------------------------------------------ */
/* Trainer theme music                                                 */
/* A theme is { kind, ref, title }:                                    */
/*   file       ref = media id (uploaded audio, served at /media/<id>) */
/*   audio      ref = https URL of an audio file                       */
/*   youtube    ref = video id                                          */
/*   spotify    ref = "track/<id>" (or album/playlist/episode)          */
/*   soundcloud ref = https://soundcloud.com/... URL                   */
/* Embeds are always built from these parts, never from a pasted URL. */
/* ------------------------------------------------------------------ */
const MEDIA_MAX = 8 * 1024 * 1024;
const IMAGE_MIMES = ['image/webp', 'image/png', 'image/jpeg'];
const IMAGE_MAX = 2 * 1024 * 1024;   // the client sends a framed 320×320 picture, far smaller than this
function parseTheme(text) {
  if (!text) return null;
  try { return typeof text === 'string' ? JSON.parse(text) : text; } catch (e) { return null; }
}
function themeText(theme) { return theme ? JSON.stringify(theme) : ''; }

function parseThemeLink(raw) {
  const text = String(raw || '').trim();
  const sp = /^spotify:(track|album|playlist|episode):([A-Za-z0-9]{10,40})$/.exec(text);   // app "copy URI"
  if (sp) return { kind: 'spotify', ref: `${sp[1]}/${sp[2]}` };
  let u;
  try { u = new URL(text); } catch (e) { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.replace(/^(www\.|m\.|music\.)/, '');
  const ytId = id => (/^[A-Za-z0-9_-]{11}$/.test(id || '') ? { kind: 'youtube', ref: id } : null);
  if (host === 'youtu.be') return ytId(u.pathname.slice(1).split('/')[0]);
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') return ytId(u.searchParams.get('v'));
    const m = /^\/(shorts|embed|live|v)\/([^/?#]+)/.exec(u.pathname);
    return m ? ytId(m[2]) : null;
  }
  if (host === 'open.spotify.com') {
    const m = /^\/(?:intl-[a-z-]+\/)?(?:embed\/)?(track|album|playlist|episode)\/([A-Za-z0-9]{10,40})/.exec(u.pathname);
    return m ? { kind: 'spotify', ref: `${m[1]}/${m[2]}` } : null;
  }
  if (host === 'soundcloud.com' || host === 'on.soundcloud.com') {
    return /^\/[A-Za-z0-9_\-/.]+$/.test(u.pathname) && u.pathname.length > 1
      ? { kind: 'soundcloud', ref: `https://${host}${u.pathname}` } : null;
  }
  if (u.protocol === 'https:' && /\.(mp3|ogg|oga|wav|m4a|aac|flac|opus|webm)$/i.test(u.pathname)) {
    return { kind: 'audio', ref: u.href };
  }
  return null;
}

// Title of a linked song through each service's public oEmbed (no key needed); falls back to the service name.
async function linkTitle(theme, raw) {
  const oembed = {
    youtube: `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + theme.ref)}`,
    spotify: `https://open.spotify.com/oembed?url=${encodeURIComponent('https://open.spotify.com/' + theme.ref)}`,
    soundcloud: `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(theme.ref)}`
  }[theme.kind];
  const fallback = { youtube: 'YouTube', spotify: 'Spotify', soundcloud: 'SoundCloud',
    audio: decodeURIComponent(new URL(raw).pathname.split('/').pop() || 'Áudio') }[theme.kind];
  if (!oembed) return fallback;
  try {
    const r = await fetch(oembed, { signal: AbortSignal.timeout(4000) });
    const j = r.ok ? await r.json() : {};
    return String(j.title || fallback).slice(0, 120);
  } catch (e) { return fallback; }
}

/* body.theme: null (remove) | { link } | { file: mediaId, title }. Returns { theme } or { error }.
   A player can only use a file they uploaded; the GM any file of the room (for NPCs). */
async function cleanThemeInput(input, member) {
  if (input === null) return { theme: null };
  if (!input || typeof input !== 'object') return { error: 'tema_invalido' };
  if (input.file) {
    const f = await store.getMediaInfo(String(input.file));
    if (!f || f.roomId !== member.roomId || (!isGM(member) && f.owner !== member.name)) return { error: 'tema_invalido' };
    return { theme: { kind: 'file', ref: f.id, title: String(input.title || 'Música').slice(0, 120) } };
  }
  const t = parseThemeLink(input.link);
  if (!t) return { error: 'link_invalido' };
  return { theme: { ...t, title: await linkTitle(t, input.link) } };
}
// an uploaded file belongs to one trainer: drop it once they stop using it
async function releaseTheme(oldTheme, newTheme) {
  if (oldTheme && oldTheme.kind === 'file' && !(newTheme && newTheme.kind === 'file' && newTheme.ref === oldTheme.ref)) {
    await store.deleteMedia(oldTheme.ref);
  }
}

/* one entry per trainer name, even if they joined from several devices */
function uniqueMembers(rows) {
  const byName = new Map();
  rows.forEach(r => {
    const cur = byName.get(r.name);
    if (!cur) { byName.set(r.name, { name: r.name, role: r.role, avatar: r.avatar || '', theme: r.theme || null, character: r.character || '' }); return; }
    if (r.role === 'gm') cur.role = 'gm';
    if (!cur.avatar && r.avatar) cur.avatar = r.avatar;
    if (!cur.theme && r.theme) cur.theme = r.theme;
    if (!cur.character && r.character) cur.character = r.character;
  });
  return [...byName.values()];
}

/* ------------------------------------------------------------------ */
/* Battles                                                             */
/* A battle has two sides (a/b), each a trainer with a party of up to 6 fichas.
   Like the games, a player only learns about the other side what shows up on the
   field: the Pokémon out now and the ones already used. Moves, stats, the rest of
   the party and exact HP never leave the server for them.                        */
/* ------------------------------------------------------------------ */
const SIDES = ['a', 'b'];
const PARTY_MAX = 6;
const otherSide = s => (s === 'a' ? 'b' : 'a');

/* HP as the opponent sees it: a percentage of the bar. The GM's client stores maxHp
   next to hp whenever it changes HP (the formula lives in the frontend). */
function hpPct(p) {
  const bt = p.battle || {};
  if (bt.hp === undefined || bt.hp === null) return 100;
  if (bt.hp <= 0) return 0;
  if (!bt.maxHp) return 100;
  return Math.max(1, Math.min(100, Math.round((bt.hp / bt.maxHp) * 100)));
}
function fieldView(p, tera) {
  const bt = p.battle || {};
  const stages = {};
  Object.entries(bt.stages || {}).forEach(([k, v]) => { if (v) stages[k] = v; });
  const [t1, t2] = typesInBattle(p);
  return { species: p.species, nickname: p.nickname || '', level: p.level, shiny: !!p.shiny, megaActive: megaActiveOf(p),
    type1: t1, type2: t2, hpPct: hpPct(p), stages,
    status: STATUS_KEYS.includes(bt.status) ? bt.status : null, confused: !!bt.confused, tera: tera || null,
    dmax: bt.dmax === 'gmax' || bt.dmax === 'dmax' ? bt.dmax : null };
}
const STATUS_KEYS = ['brn', 'par', 'slp', 'psn', 'tox', 'frz'];
// A ficha's `mega` is only which Mega it *can* use; it's active while battle.mega = { form, t1, t2, ability }.
function megaActiveOf(p) { const m = (p.battle || {}).mega; return m && m.form ? m.form : ''; }
function typesInBattle(p) {
  const m = (p.battle || {}).mega;
  if (m && m.form && m.t1) return [m.t1, m.t2 || ''];
  if (p.megaBase) return [p.megaBase.type1, p.megaBase.type2 || ''];   // fichas saved while Mega used to swap types
  return [p.type1, p.type2 || ''];
}
const TERA_TYPES = ['Normal', 'Fogo', 'Água', 'Grama', 'Elétrico', 'Gelo', 'Lutador', 'Venenoso', 'Solo',
  'Voador', 'Psíquico', 'Inseto', 'Pedra', 'Fantasma', 'Dragão', 'Sombrio', 'Aço', 'Fada', 'Astral'];
async function trainerInfo(roomId) {
  const info = {};
  uniqueMembers(await store.listMembers(roomId)).forEach(x => { info[x.name] = { name: x.character || x.name, avatar: x.avatar, theme: x.theme || null }; });
  (await store.listNpcs(roomId)).forEach(n => { info[npcOwner(n.id)] = { name: n.name, avatar: n.avatar || '', theme: n.theme || null }; });
  return info;
}
/* Battle log. Entries are written by the server from what the GM does (switches, HP and
   stage changes, the end) and keep ficha ids; each player gets them filtered and resolved. */
const LOG_MAX = 300;
const STAGE_STATS = ['atk', 'def', 'spa', 'spd', 'spe'];
function pushLog(data, entry) {
  data.log = [...(data.log || []), { t: new Date().toISOString(), ...entry }].slice(-LOG_MAX);
}
// What changed between two `battle` states of a ficha, as log entries.
function battleChangeEvents(before, after) {
  const b0 = before || {}, b1 = after || {};
  const max = b1.maxHp || b0.maxHp || 0;
  const hp0 = (b0.hp === undefined || b0.hp === null) ? (max || null) : b0.hp;
  const hp1 = (b1.hp === undefined || b1.hp === null) ? hp0 : b1.hp;
  const st0 = b0.stages || {}, st1 = b1.stages || {};
  const changed = STAGE_STATS.filter(k => (st0[k] || 0) !== (st1[k] || 0));
  const s0 = b0.status || null, s1 = b1.status || null;
  // "Restaurar": back to full HP with every stage, status and confusion cleared
  const clean = !STAGE_STATS.some(k => st1[k]) && !s1 && !b1.confused;
  if (max && hp1 === max && clean && (changed.length || s0 || b0.confused)) return [{ k: 'restore' }];
  const ev = [];
  if (hp0 !== null && hp1 !== hp0) ev.push({ k: 'hp', delta: hp1 - hp0, hp: hp1, max });
  if (hp1 !== null && hp1 <= 0 && (hp0 === null || hp0 > 0)) ev.push({ k: 'faint' });
  changed.forEach(k => ev.push({ k: 'stage', stat: k, delta: (st1[k] || 0) - (st0[k] || 0), now: st1[k] || 0 }));
  if (s0 !== s1) ev.push({ k: 'status', status: s1, was: s0 });
  if (!!b0.confused !== !!b1.confused) ev.push({ k: 'confuse', on: !!b1.confused });
  return ev;
}
// The log as a player may read it: nothing about the opponent's Pokémon that never showed up,
// and the opponent's HP changes only as a percentage of the bar. A spectator (`you` = null)
// reads both sides that way.
function logForPlayer(b, you, byId) {
  const nameOf = id => { const p = byId(id); return p ? (p.nickname || p.species) : '?'; };
  return (b.log || [])
    .filter(e => !e.side || e.side === you || !e.mon || b.revealed[e.side].includes(e.mon))
    .map(e => {
      const out = { t: e.t, k: e.k };
      if (e.side) out.side = e.side;
      if (e.mon) out.name = nameOf(e.mon);
      if (e.prev && e.k === 'send') out.prevName = nameOf(e.prev);
      if (e.k === 'hp') {
        if (you && e.side === you) Object.assign(out, { delta: e.delta, hp: e.hp, max: e.max });
        else out.pct = e.max ? Math.max(1, Math.round((Math.abs(e.delta) / e.max) * 100)) * Math.sign(e.delta) : 0;
        if (e.why) out.why = e.why;
      }
      if (/^(weather|terrain)(-end)?$/.test(e.k)) out.kind = e.kind;
      if (e.k === 'stage') Object.assign(out, { stat: e.stat, delta: e.delta, now: e.now });
      if (e.k === 'end') out.winner = e.winner;
      if (e.k === 'status') Object.assign(out, { status: e.status, was: e.was });
      if (e.k === 'confuse') out.on = e.on;
      if (e.k === 'tera') out.type = e.type;
      if (e.k === 'dmax') out.gmax = !!e.gmax;
      if (e.k === 'mega') out.form = e.form;
      return out;
    });
}

// Dynamax / Gigantamax doubles max and current HP (hp undefined = full stays full); ending it halves them back
function growDmax(bt, kind) {
  const out = { ...(bt || {}), dmax: kind };
  if (out.hp !== undefined && out.hp !== null) out.hp = out.hp * 2;
  if (out.maxHp) out.maxHp = out.maxHp * 2;
  return out;
}
function shrinkDmax(bt) {
  const { dmax, ...out } = bt || {};
  if (out.hp !== undefined && out.hp !== null) out.hp = Math.ceil(out.hp / 2);
  if (out.maxHp) out.maxHp = Math.round(out.maxHp / 2);
  return out;
}
async function endDmaxOf(monId, roomId) {
  const p = await store.getPokemon(monId);
  if (p && p.battle && p.battle.dmax) await setMonBattle(p, roomId, shrinkDmax(p.battle));
}

/* Weather and terrain: one of each per battle, public to everyone who sees it. `turns` null = no
   limit (the primal weathers). The GM counts the turns down by hand; reaching 0 ends it.
   The names, effects and look live in the frontend (WEATHER / TERRAIN). */
const WEATHER_KINDS = ['sun', 'rain', 'sand', 'hail', 'snow', 'harshsun', 'heavyrain', 'winds'];
const TERRAIN_KINDS = ['electric', 'grassy', 'misty', 'psychic'];
const FIELD_TURNS_MAX = 99;
// body: { kind, turns } starts one (replacing the current), { delta } moves the turn count, { clear: true } ends it
function applyFieldEffect(data, key, kinds, body) {
  const cur = data[key] || null;
  const end = () => { if (cur) pushLog(data, { k: key + '-end', kind: cur.kind }); data[key] = null; };
  if (body.clear) { end(); return true; }
  if (body.delta !== undefined) {
    const d = parseInt(body.delta, 10);
    if (!cur || cur.turns === null || !d) return false;
    const turns = Math.min(FIELD_TURNS_MAX, cur.turns + d);
    if (turns <= 0) end(); else data[key] = { ...cur, turns };
    return true;
  }
  if (!kinds.includes(body.kind)) return false;
  const turns = body.turns === null ? null : Math.max(1, Math.min(FIELD_TURNS_MAX, parseInt(body.turns, 10) || 5));
  data[key] = { kind: body.kind, turns };
  pushLog(data, { k: key, kind: body.kind });
  return true;
}
// why an HP change happened, when it's end-of-turn damage/healing (goes to the log)
const RESIDUAL_REASONS = ['sand', 'hail', 'brn', 'psn', 'tox', 'grassy'];

// Tera type a side's Pokémon is using in this battle (null if it hasn't terastallized)
function teraOf(b, side, monId) {
  const t = (b.tera || {})[side];
  return t && t.mon === monId ? t.type : null;
}

// The battle's Pokémon by id; an ended battle shows how it finished, not the (already healed) current HP
function battleMonLookup(b, roomMons) {
  const final = b.status === 'ended' && b.final ? b.final : null;
  return id => {
    const p = roomMons.find(x => x.id === id);
    return p && final && final[id] ? { ...p, battle: final[id] } : p;
  };
}
// A side as someone who doesn't fight on it sees it: the Pokémon on the field, the party size and
// the ones already used. Moves, Status, ability and exact HP stay on the server.
function publicSideView(b, s, byId) {
  const active = byId(b.active[s]);
  return {
    partySize: b.party[s].map(byId).filter(Boolean).length,
    active: active ? fieldView(active, teraOf(b, s, active.id)) : null,
    // every Pokémon of theirs that has been on the field, in order of appearance
    seen: b.revealed[s].map(byId).filter(Boolean).map(p => ({
      species: p.species, nickname: p.nickname || '', level: p.level, shiny: !!p.shiny, megaActive: megaActiveOf(p),
      fainted: hpPct(p) === 0, active: p.id === b.active[s],
      art: p.customArt || null   // for the end-of-battle art only (the arena keeps the official sprite)
    }))
  };
}
function battleHeader(b, info) {
  return { id: b.id, name: b.name, status: b.status, winner: b.winner || null, createdAt: b.createdAt, endedAt: b.endedAt,
    weather: b.weather || null, terrain: b.terrain || null,
    trainers: { a: info[b.sides.a.owner] || { name: '—', avatar: '' }, b: info[b.sides.b.owner] || { name: '—', avatar: '' } } };
}

function playerBattleView(b, me, roomMons, info) {
  const you = b.sides.a.owner === me ? 'a' : 'b';
  const final = b.status === 'ended' && b.final ? b.final : null;
  const byId = battleMonLookup(b, roomMons);
  return {
    ...battleHeader(b, info), you,
    mine: {
      party: b.party[you].filter(id => byId(id)), active: b.active[you], used: b.revealed[you].filter(id => byId(id)),
      final: final ? Object.fromEntries(b.party[you].filter(id => final[id]).map(id => [id, final[id]])) : null,
      tera: (b.tera || {})[you] || null, mega: (b.mega || {})[you] || null
    },
    foe: publicSideView(b, otherSide(you), byId),
    log: logForPlayer(b, you, byId)
  };
}
// A player watching a battle they don't fight in: both sides as an opponent would see them.
function spectatorBattleView(b, roomMons, info) {
  const byId = battleMonLookup(b, roomMons);
  return {
    ...battleHeader(b, info), spectator: true,
    field: { a: publicSideView(b, 'a', byId), b: publicSideView(b, 'b', byId) },
    log: logForPlayer(b, null, byId)
  };
}

/* who the GM may assign as owner of a new ficha: themself, any member, or an NPC of the room */
async function isValidOwner(roomId, owner) {
  if (owner.startsWith(NPC_PREFIX)) {
    const npc = await store.getNpc(owner.slice(NPC_PREFIX.length));
    return !!npc && npc.roomId === roomId;
  }
  return (await store.listMembers(roomId)).some(x => x.name === owner);
}

/* The Mega's own sheet, attached to the ficha: the ability and moves it uses while Mega-evolved
   (a Battle Bound's signature passive/move). Everything else comes from the ficha itself. */
function cleanMegaSheet(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  return {
    ability: String(x.ability || '').slice(0, 80),
    moves: (Array.isArray(x.moves) ? x.moves : []).filter(mv => mv && typeof mv === 'object' && !Array.isArray(mv)).slice(0, 4)
  };
}

/* Homebrew extra Status the GM gives a Pokémon: { hp, atk, … } whole numbers (−99…99), zeros dropped;
   null when there's none. Added before the cap of 90 (the frontend's finalStatsFor). Only the GM sets it. */
const STAT_KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
function cleanBonus(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const out = {};
  STAT_KEYS.forEach(k => {
    const v = Math.max(-99, Math.min(99, parseInt(x[k], 10) || 0));
    if (v) out[k] = v;
  });
  return Object.keys(out).length ? out : null;
}

/* A ficha's custom picture: { id: <media id>, pixel } (pixel art is shown without smoothing) or null.
   Shown on the sheet and in the end-of-battle art; the battle itself keeps the official sprite. */
function cleanCustomArt(x) {
  if (!x || typeof x !== 'object' || !/^[0-9a-f]{20}$/.test(String(x.id || ''))) return null;
  return { id: x.id, pixel: !!x.pixel };
}
async function releaseArt(p) { if (p && p.customArt && p.customArt.id) await store.deleteMedia(p.customArt.id); }

/* strip fields the client must not control */
function cleanMonData(body) {
  const allowed = ['species','nickname','type1','type2','level','natureName','natureUp','natureDown',
    'base100','stage','maxStage','committed','legendary','distributed','ability','notes','moves','shiny',
    'order','battle','teraType','mega','megaBase','megaSheet','bonus','customArt'];
  const out = {};
  allowed.forEach(k => { if (body[k] !== undefined) out[k] = body[k]; });
  if (out.megaSheet !== undefined) out.megaSheet = cleanMegaSheet(out.megaSheet);
  if (out.bonus !== undefined) out.bonus = cleanBonus(out.bonus);
  if (out.customArt !== undefined) out.customArt = cleanCustomArt(out.customArt);
  out.updatedAt = new Date().toISOString();
  return out;
}
function cleanTeamData(body) {
  return {
    name: String(body.name || 'Time sem nome').slice(0, 80),
    size: Math.min(12, Math.max(1, parseInt(body.size) || 6)),
    pokemonIds: Array.isArray(body.pokemonIds) ? body.pokemonIds.slice(0, 12) : [],
    updatedAt: new Date().toISOString()
  };
}

/* ------------------------------------------------------------------ */
/* Rooms                                                               */
/* ------------------------------------------------------------------ */
app.post('/api/rooms', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim().slice(0, 80);
    const gmName = cleanTrainerName(req.body.gmName);
    if (!gmName) return res.status(400).json({ error: 'nome_obrigatorio' });

    let id = roomCode();
    for (let i = 0; i < 5 && await store.getRoom(id); i++) id = roomCode();

    const gmToken = token();
    await store.createRoom({ id, name: name || ('Sala de ' + gmName), gmName, gmToken });
    await store.addMember({ token: gmToken, roomId: id, name: gmName, role: 'gm' });
    res.json({ roomId: id, name: name || ('Sala de ' + gmName), token: gmToken, role: 'gm', name_: gmName });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'erro_interno' });
  }
});

app.post('/api/rooms/:id/join', async (req, res) => {
  try {
    const roomId = String(req.params.id || '').toUpperCase();
    const name = cleanTrainerName(req.body.name);
    if (!name) return res.status(400).json({ error: 'nome_obrigatorio' });
    const room = await store.getRoom(roomId);
    if (!room) return res.status(404).json({ error: 'sala_nao_encontrada' });
    if (isBlocked(room, name)) return res.status(403).json({ error: 'nome_bloqueado' });
    // rejoining under the same name (new device) keeps the avatar and theme already chosen
    const same = uniqueMembers(await store.listMembers(roomId)).find(x => x.name === name);
    const avatar = same ? same.avatar : '';
    const t = token();
    await store.addMember({ token: t, roomId, name, role: 'player', avatar, theme: same ? same.theme : null, character: same ? same.character : '' });
    res.json({ roomId, name: room.name, token: t, role: 'player', avatar });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'erro_interno' });
  }
});

/* The GM renames the campaign, or deletes it with everything in it: fichas, teams, NPCs, battles,
   uploaded music and everyone's access. Deleting asks for the campaign's name back (`confirm`),
   so a stray request can't wipe it. */
app.put('/api/room', auth, async (req, res) => {
  try {
    if (!isGM(req.member)) return res.status(403).json({ error: 'so_mestre' });
    const name = String(req.body.name || '').trim().slice(0, 80);
    if (!name) return res.status(400).json({ error: 'nome_campanha_obrigatorio' });
    await store.renameRoom(req.member.roomId, name);
    res.json({ ok: true, name });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'erro_interno' });
  }
});

app.delete('/api/room', auth, async (req, res) => {
  try {
    if (!isGM(req.member)) return res.status(403).json({ error: 'so_mestre' });
    const room = await store.getRoom(req.member.roomId);
    if (!room) return res.status(404).json({ error: 'sala_nao_encontrada' });
    if (String((req.body || {}).confirm || '').trim() !== room.name.trim()) return res.status(400).json({ error: 'confirmacao_invalida' });
    await store.deleteRoom(room.id);
    res.json({ ok: true });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'erro_interno' });
  }
});

/* The GM removes a player from the campaign: every token (device) under that name stops working.
   Optionally deletes what is theirs — fichas, teams, uploaded music and the battles they fight in —
   and blocks the name from joining again (a name block: there are no passwords yet, so someone with
   the code can still come in under another name). Kept fichas stay with the GM, under the old name. */
app.delete('/api/members/:name', auth, async (req, res) => {
  try {
    const m = req.member;
    if (!isGM(m)) return res.status(403).json({ error: 'so_mestre' });
    const name = String(req.params.name || '');
    const member = uniqueMembers(await store.listMembers(m.roomId)).find(x => x.name === name);
    if (!member) return res.status(404).json({ error: 'jogador_nao_encontrado' });
    if (member.role === 'gm' || name === m.name) return res.status(400).json({ error: 'nao_remove_mestre' });
    const body = req.body || {};
    if (body.deleteData) {
      for (const b of await store.listBattles(m.roomId)) {
        if (SIDES.some(s => b.sides[s].owner === name)) await store.deleteBattle(b.id);
      }
      for (const p of await store.listPokemon(m.roomId)) {
        if (p.owner === name) { await store.deletePokemon(p.id); await releaseArt(p); }   // a GM-uploaded picture isn't his
      }
      for (const t of await store.listTeams(m.roomId)) if (t.owner === name) await store.deleteTeam(t.id);
      await store.deleteMediaOf(m.roomId, name);
    } else {
      await releaseTheme(member.theme, null);   // the theme lives on the member rows that are going away
    }
    await store.removeMember(m.roomId, name);
    if (body.block) {
      const room = await store.getRoom(m.roomId);
      if (!isBlocked(room, name)) await store.setRoomBanned(m.roomId, [...(room.banned || []), name]);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'erro_interno' });
  }
});

app.delete('/api/room/banned/:name', auth, async (req, res) => {
  try {
    if (!isGM(req.member)) return res.status(403).json({ error: 'so_mestre' });
    const room = await store.getRoom(req.member.roomId);
    const name = String(req.params.name || '');
    await store.setRoomBanned(room.id, (room.banned || []).filter(b => b !== name));
    res.json({ ok: true });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'erro_interno' });
  }
});

app.get('/api/state', auth, async (req, res) => {
  try {
    const m = req.member;
    const room = await store.getRoom(m.roomId);
    if (!room) return res.status(404).json({ error: 'sala_nao_encontrada' });
    const roomMons = await store.listPokemon(m.roomId);
    let pokemon = roomMons;
    let teams = await store.listTeams(m.roomId);
    let battles = await store.listBattles(m.roomId);
    if (!isGM(m)) {
      pokemon = pokemon.filter(p => p.owner === m.name);
      teams = teams.filter(t => t.owner === m.name);
      // players get every battle of the room, filtered down to what they may see: the ones they
      // fight in with their own side in full, the others as a spectator
      const info = battles.length ? await trainerInfo(m.roomId) : {};
      battles = battles.map(b => (SIDES.some(s => b.sides[s].owner === m.name)
        ? playerBattleView(b, m.name, roomMons, info) : spectatorBattleView(b, roomMons, info)));
    }
    const members = isGM(m) ? uniqueMembers(await store.listMembers(m.roomId)) : [];
    const npcs = isGM(m) ? await store.listNpcs(m.roomId) : [];
    res.json({
      room: { id: room.id, name: room.name, gmName: room.gmName, ...(isGM(m) ? { banned: room.banned || [] } : {}) },
      me: { name: m.name, role: m.role, avatar: m.avatar || '', theme: m.theme || null, character: m.character || '' },
      members, npcs, pokemon, teams, battles
    });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'erro_interno' });
  }
});

/* ------------------------------------------------------------------ */
/* Trainers: own avatar, GM-managed NPCs                               */
/* ------------------------------------------------------------------ */
app.put('/api/me/avatar', auth, async (req, res) => {
  try {
    const avatar = cleanAvatar(req.body.avatar);
    if (avatar === null) return res.status(400).json({ error: 'avatar_invalido' });
    await store.setMemberAvatar(req.member.roomId, req.member.name, avatar);
    res.json({ ok: true, avatar });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'erro_interno' });
  }
});

/* audio upload for a theme: raw bytes in the body, Content-Type audio/* (max 8 MB) */
app.post('/api/media', express.raw({ type: () => true, limit: MEDIA_MAX }), auth, async (req, res) => {
  try {
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const image = IMAGE_MIMES.includes(mime);   // a ficha's custom picture (raster only: no SVG)
    if (!image && !/^audio\/[a-z0-9.+-]+$/.test(mime)) return res.status(400).json({ error: 'arquivo_invalido' });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'arquivo_invalido' });
    if (image && req.body.length > IMAGE_MAX) return res.status(413).json({ error: 'http_413' });
    const f = { id: uid(), roomId: req.member.roomId, owner: req.member.name, mime, data: req.body };
    await store.putMedia(f);
    res.json({ id: f.id });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'erro_interno' });
  }
});

/* served by unguessable id (an <audio> tag can't send the auth header); supports Range for seeking/Safari */
app.get('/media/:id', async (req, res) => {
  try {
    const f = /^[0-9a-f]{20}$/.test(req.params.id) ? await store.getMedia(req.params.id) : null;
    if (!f) return res.status(404).end();
    const buf = Buffer.from(f.data), total = buf.length;
    res.set({ 'Content-Type': f.mime, 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=86400' });
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] || m[2])) {
      let start = m[1] ? Number(m[1]) : Math.max(0, total - Number(m[2]));
      let end = m[1] && m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
      if (start >= total || start > end) return res.status(416).set('Content-Range', `bytes */${total}`).end();
      return res.status(206).set('Content-Range', `bytes ${start}-${end}/${total}`).end(buf.subarray(start, end + 1));
    }
    res.end(buf);
  } catch (e) {
    console.error(e); res.status(500).end();
  }
});

/* the name of your character in this campaign (what the others see); empty = your own name */
app.put('/api/me/character', auth, async (req, res) => {
  try {
    const character = String(req.body.character || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
    await store.setMemberCharacter(req.member.roomId, req.member.name, character);
    res.json({ ok: true, character });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'erro_interno' });
  }
});

app.put('/api/me/theme', auth, async (req, res) => {
  try {
    const m = req.member;
    const r = await cleanThemeInput(req.body.theme === undefined ? undefined : req.body.theme, m);
    if (r.error) return res.status(400).json({ error: r.error });
    const current = uniqueMembers(await store.listMembers(m.roomId)).find(x => x.name === m.name);
    await store.setMemberTheme(m.roomId, m.name, r.theme);
    await releaseTheme(current && current.theme, r.theme);
    res.json({ ok: true, theme: r.theme });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'erro_interno' });
  }
});

app.post('/api/npcs', auth, async (req, res) => {
  try {
    const m = req.member;
    if (!isGM(m)) return res.status(403).json({ error: 'so_mestre' });
    const name = String(req.body.name || '').trim().slice(0, 40);
    if (!name) return res.status(400).json({ error: 'nome_obrigatorio' });
    const avatar = cleanAvatar(req.body.avatar);
    if (avatar === null) return res.status(400).json({ error: 'avatar_invalido' });
    let theme = null;
    if (req.body.theme !== undefined) {
      const r = await cleanThemeInput(req.body.theme, m);
      if (r.error) return res.status(400).json({ error: r.error });
      theme = r.theme;
    }
    const npc = { id: uid(), roomId: m.roomId, name, avatar, theme };
    await store.upsertNpc(npc);
    res.json({ id: npc.id, owner: npcOwner(npc.id), name, avatar, theme });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'erro_interno' });
  }
});

app.put('/api/npcs/:id', auth, async (req, res) => {
  try {
    const m = req.member;
    if (!isGM(m)) return res.status(403).json({ error: 'so_mestre' });
    const npc = await store.getNpc(req.params.id);
    if (!npc) return res.status(404).json({ error: 'nao_encontrado' });
    if (npc.roomId !== m.roomId) return res.status(403).json({ error: 'outra_sala' });
    const name = req.body.name !== undefined ? String(req.body.name).trim().slice(0, 40) : npc.name;
    if (!name) return res.status(400).json({ error: 'nome_obrigatorio' });
    const avatar = req.body.avatar !== undefined ? cleanAvatar(req.body.avatar) : npc.avatar;
    if (avatar === null) return res.status(400).json({ error: 'avatar_invalido' });
    let theme = npc.theme || null;
    if (req.body.theme !== undefined) {
      const r = await cleanThemeInput(req.body.theme, m);
      if (r.error) return res.status(400).json({ error: r.error });
      theme = r.theme;
    }
    await store.upsertNpc({ ...npc, name, avatar, theme });
    await releaseTheme(npc.theme, theme);
    res.json({ ok: true, theme });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'erro_interno' });
  }
});

/* deleting an NPC also deletes its fichas */
app.delete('/api/npcs/:id', auth, async (req, res) => {
  try {
    const m = req.member;
    if (!isGM(m)) return res.status(403).json({ error: 'so_mestre' });
    const npc = await store.getNpc(req.params.id);
    if (!npc) return res.json({ ok: true });
    if (npc.roomId !== m.roomId) return res.status(403).json({ error: 'outra_sala' });
    const owner = npcOwner(npc.id);
    for (const b of await store.listBattles(m.roomId)) {
      if (SIDES.some(s => b.sides[s].owner === owner)) await store.deleteBattle(b.id);
    }
    const arts = (await store.listPokemon(m.roomId)).filter(p => p.owner === owner && p.customArt);
    await store.deleteNpc(npc.id, owner);
    for (const p of arts) await releaseArt(p);
    await releaseTheme(npc.theme, null);
    res.json({ ok: true });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'erro_interno' });
  }
});

/* ------------------------------------------------------------------ */
/* Pokémon                                                             */
/* ------------------------------------------------------------------ */
app.post('/api/pokemon', auth, async (req, res) => {
  try {
    const m = req.member;
    const id = req.body.id || uid();
    const existing = req.body.id ? await store.getPokemon(id) : null;
    if (existing) {
      if (existing.roomId !== m.roomId) return res.status(403).json({ error: 'outra_sala' });
      if (!isGM(m) && existing.owner !== m.name) return res.status(403).json({ error: 'nao_e_seu' });
    }
    // existing fichas keep their owner; a new one belongs to its creator,
    // unless the GM creates it for another trainer (player or NPC) of the room
    let owner = existing ? existing.owner : m.name;
    if (!existing && isGM(m) && req.body.owner && req.body.owner !== m.name) {
      const wanted = String(req.body.owner);
      if (!await isValidOwner(m.roomId, wanted)) return res.status(400).json({ error: 'dono_invalido' });
      owner = wanted;
    }
    // battle state (HP, stages) belongs to the GM, and saving a ficha must not wipe it or the order
    const data = cleanMonData(req.body);
    if (!isGM(m) || data.battle === undefined) {
      if (existing && existing.battle !== undefined) data.battle = existing.battle; else delete data.battle;
    }
    // the extra Status too: only the GM gives or takes them; a player's save keeps what is there
    if (!isGM(m) || data.bonus === undefined) {
      if (existing && existing.bonus) data.bonus = existing.bonus; else delete data.bonus;
    }
    if (data.order === undefined && existing && existing.order !== undefined) data.order = existing.order;
    // custom picture: a media file of this room (for a player, one they uploaded themself); an unchanged
    // one is kept as is, and replacing or removing it deletes the old file
    const oldArt = existing && existing.customArt ? existing.customArt.id : null;
    if (data.customArt === undefined) {
      if (oldArt) data.customArt = existing.customArt;
    } else if (data.customArt && data.customArt.id !== oldArt) {
      const f = await store.getMediaInfo(data.customArt.id);
      if (!f || f.roomId !== m.roomId || !IMAGE_MIMES.includes(f.mime) || (!isGM(m) && f.owner !== m.name)) {
        return res.status(400).json({ error: 'imagem_invalida' });
      }
    }
    await store.upsertPokemon(id, m.roomId, owner, data);
    if (oldArt && (!data.customArt || data.customArt.id !== oldArt)) await store.deleteMedia(oldArt);
    res.json({ id, owner });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'erro_interno' });
  }
});

app.patch('/api/pokemon/:id/battle', auth, async (req, res) => {
  try {
    const m = req.member;
    const p = await store.getPokemon(req.params.id);
    if (!p) return res.status(404).json({ error: 'nao_encontrado' });
    if (p.roomId !== m.roomId) return res.status(403).json({ error: 'outra_sala' });
    if (!isGM(m) && p.owner !== m.name) return res.status(403).json({ error: 'nao_e_seu' });
    // the whole match is run by the GM: players can reorder their fichas, not touch HP/stages
    if (req.body.battle !== undefined && !isGM(m)) return res.status(403).json({ error: 'so_mestre' });
    const { id, roomId, owner, ...data } = p;
    if (req.body.battle !== undefined) {
      // log the change in every running battle this Pokémon is part of (with the reason, for end-of-turn damage)
      const why = RESIDUAL_REASONS.includes(req.body.reason) ? req.body.reason : null;
      const events = battleChangeEvents(p.battle, req.body.battle).map(e => (why && e.k === 'hp' ? { ...e, why } : e));
      if (events.length) {
        for (const b of await store.listBattles(m.roomId)) {
          const side = b.status === 'active' && SIDES.find(s => b.party[s].includes(p.id));
          if (!side) continue;
          const { id: battleId, ...bdata } = b;
          events.forEach(e => pushLog(bdata, { ...e, side, mon: p.id }));
          await store.upsertBattle(battleId, m.roomId, bdata);
        }
      }
      data.battle = req.body.battle;
    }
    if (req.body.order !== undefined) data.order = parseInt(req.body.order) || 0;
    data.updatedAt = new Date().toISOString();
    await store.upsertPokemon(p.id, m.roomId, p.owner, data);
    res.json({ ok: true });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'erro_interno' });
  }
});

app.delete('/api/pokemon/:id', auth, async (req, res) => {
  try {
    const m = req.member;
    const p = await store.getPokemon(req.params.id);
    if (!p) return res.json({ ok: true });
    if (p.roomId !== m.roomId) return res.status(403).json({ error: 'outra_sala' });
    if (!isGM(m) && p.owner !== m.name) return res.status(403).json({ error: 'nao_e_seu' });
    await store.deletePokemon(req.params.id);
    await releaseArt(p);
    res.json({ ok: true });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'erro_interno' });
  }
});

/* ------------------------------------------------------------------ */
/* Battle rooms (GM only; players read their view through /api/state)  */
/* ------------------------------------------------------------------ */
// Pokémon still fighting in some other running battle are left alone when one battle ends/reopens.
async function monsInOtherActiveBattles(roomId, battleId) {
  const busy = new Set();
  (await store.listBattles(roomId))
    .filter(x => x.id !== battleId && x.status === 'active')
    .forEach(x => [...x.party.a, ...x.party.b].forEach(monId => busy.add(monId)));
  return busy;
}
async function setMonBattle(p, roomId, battle) {
  const { id, owner, roomId: _r, ...data } = p;
  data.battle = battle;
  data.updatedAt = new Date().toISOString();
  await store.upsertPokemon(id, roomId, owner, data);
}

async function loadOwnBattle(req, res) {
  if (!isGM(req.member)) { res.status(403).json({ error: 'so_mestre' }); return null; }
  const b = await store.getBattle(req.params.id);
  if (!b) { res.status(404).json({ error: 'nao_encontrado' }); return null; }
  if (b.roomId !== req.member.roomId) { res.status(403).json({ error: 'outra_sala' }); return null; }
  return b;
}

app.post('/api/battles', auth, async (req, res) => {
  try {
    const m = req.member;
    if (!isGM(m)) return res.status(403).json({ error: 'so_mestre' });
    const body = req.body || {};
    const mons = await store.listPokemon(m.roomId);
    const sides = {}, party = {};
    for (const s of SIDES) {
      const owner = String((body.sides || {})[s] || '');
      if (!owner || !await isValidOwner(m.roomId, owner)) return res.status(400).json({ error: 'lado_invalido' });
      const raw = Array.isArray((body.party || {})[s]) ? body.party[s].map(String) : [];
      const ids = [...new Set(raw)].slice(0, PARTY_MAX);
      if (!ids.length || ids.some(id => !mons.some(p => p.id === id && p.owner === owner))) {
        return res.status(400).json({ error: 'time_invalido' });
      }
      sides[s] = { owner };
      party[s] = ids;
    }
    if (sides.a.owner === sides.b.owner) return res.status(400).json({ error: 'lado_invalido' });
    const data = {
      name: String(body.name || '').trim().slice(0, 60), status: 'active', sides, party,
      active: { a: party.a[0], b: party.b[0] },
      revealed: { a: [party.a[0]], b: [party.b[0]] },   // everything that has been on the field, in order
      winner: null, tera: { a: null, b: null }, dmax: { a: null, b: null }, mega: { a: null, b: null },
      weather: null, terrain: null, createdAt: new Date().toISOString(), log: []
    };
    pushLog(data, { k: 'start' });
    SIDES.forEach(s => pushLog(data, { k: 'send', side: s, mon: party[s][0] }));
    const id = uid();
    await store.upsertBattle(id, m.roomId, data);
    res.json({ id, ...data });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'erro_interno' });
  }
});

app.patch('/api/battles/:id', auth, async (req, res) => {
  try {
    const b = await loadOwnBattle(req, res);
    if (!b) return;
    const { id, roomId, ...data } = b;
    const body = req.body || {};
    if (body.switch) {
      const side = body.switch.side, monId = String(body.switch.monId || '');
      if (!SIDES.includes(side) || !data.party[side].includes(monId)) return res.status(400).json({ error: 'troca_invalida' });
      const prev = data.active[side];
      const dm = (data.dmax || {})[side];
      if (prev !== monId && dm && dm.mon === prev && !dm.ended) {
        await endDmaxOf(prev, roomId);
        dm.ended = true;
        pushLog(data, { k: 'dmax-end', side, mon: prev });
      }
      if (prev !== monId) {
        data.active[side] = monId;
        if (!data.revealed[side].includes(monId)) data.revealed[side].push(monId);
        pushLog(data, { k: 'send', side, mon: monId, prev });
        // like the games, the bad poison counter starts over when the Pokémon leaves the field
        const pp = prev ? await store.getPokemon(prev) : null;
        if (pp && pp.battle && pp.battle.toxN) { const { toxN, ...bt } = pp.battle; await setMonBattle(pp, roomId, bt); }
      }
    }
    for (const key of ['weather', 'terrain']) {
      const fx = body[key];
      if (fx === undefined) continue;
      if (data.status !== 'active' || !fx || typeof fx !== 'object') return res.status(400).json({ error: 'campo_invalido' });
      if (!applyFieldEffect(data, key, key === 'weather' ? WEATHER_KINDS : TERRAIN_KINDS, fx)) return res.status(400).json({ error: 'campo_invalido' });
    }
    if (body.mega) {
      const side = body.mega.side;
      if (!SIDES.includes(side) || data.status !== 'active') return res.status(400).json({ error: 'mega_invalido' });
      data.mega = data.mega || { a: null, b: null };
      const hpFields = x => {
        const out = {};
        if (x.hp !== undefined && x.hp !== null) out.hp = Math.max(0, parseInt(x.hp, 10) || 0);
        if (x.maxHp) out.maxHp = Math.max(1, parseInt(x.maxHp, 10) || 1);
        return out;
      };
      if (body.mega.clear) {
        const cur = data.mega[side];
        if (!cur) return res.status(400).json({ error: 'mega_invalido' });
        const p = await store.getPokemon(cur.mon);
        if (p) { const { mega, ...bt } = p.battle || {}; await setMonBattle(p, roomId, { ...bt, ...hpFields(body.mega) }); }
        data.mega[side] = null;
        pushLog(data, { k: 'mega-undo', side });
      } else {
        // only the Pokémon on the field, only one Mega (or Battle Bound) per side per battle, and only
        // the one chosen in its ficha. Types/ability of an official Mega come from the GM's client (the
        // Mega table lives there); Battle Bound keeps the ficha's own.
        const monId = String(body.mega.monId || '');
        if (!data.party[side].includes(monId) || data.active[side] !== monId) return res.status(400).json({ error: 'mega_invalido' });
        if (data.mega[side]) return res.status(400).json({ error: 'mega_usado' });
        const p = await store.getPokemon(monId);
        if (!p || !p.mega) return res.status(400).json({ error: 'mega_invalido' });
        const form = p.mega === 'bb' ? 'bb' : String(p.mega).slice(0, 60);
        const mega = { form };
        if (form !== 'bb') {
          const type = t => (TERA_TYPES.includes(t) && t !== 'Astral' ? t : '');
          const t1 = type(body.mega.t1), ability = String(body.mega.ability || '').slice(0, 60);
          if (t1) Object.assign(mega, { t1, t2: type(body.mega.t2) });
          if (ability) mega.ability = ability;
        }
        await setMonBattle(p, roomId, { ...(p.battle || {}), mega, ...hpFields(body.mega) });
        data.mega[side] = { mon: monId, form };
        pushLog(data, { k: 'mega', side, mon: monId, form });
      }
    }
    if (body.dmax) {
      const side = body.dmax.side;
      if (!SIDES.includes(side) || data.status !== 'active') return res.status(400).json({ error: 'dmax_invalido' });
      data.dmax = data.dmax || { a: null, b: null };
      const cur = data.dmax[side];
      if (body.dmax.end || body.dmax.clear) {
        if (!cur) return res.status(400).json({ error: 'dmax_invalido' });
        if (!cur.ended) await endDmaxOf(cur.mon, roomId);
        if (body.dmax.clear) { data.dmax[side] = null; pushLog(data, { k: 'dmax-undo', side }); }
        else if (!cur.ended) { cur.ended = true; pushLog(data, { k: 'dmax-end', side, mon: cur.mon }); }
      } else {
        const monId = String(body.dmax.monId || '');
        if (!data.party[side].includes(monId) || data.active[side] !== monId) return res.status(400).json({ error: 'dmax_invalido' });
        if (cur) return res.status(400).json({ error: 'dmax_usado' });
        const gmax = !!body.dmax.gmax;
        const p = await store.getPokemon(monId);
        if (p) await setMonBattle(p, roomId, growDmax(p.battle, gmax ? 'gmax' : 'dmax'));
        data.dmax[side] = { mon: monId, gmax, ended: false };
        pushLog(data, { k: 'dmax', side, mon: monId, gmax });
      }
    }
    if (body.tera) {
      const side = body.tera.side;
      if (!SIDES.includes(side) || data.status !== 'active') return res.status(400).json({ error: 'tera_invalido' });
      data.tera = data.tera || { a: null, b: null };
      if (body.tera.clear) {
        data.tera[side] = null;
        pushLog(data, { k: 'tera-undo', side });
      } else {
        const monId = String(body.tera.monId || '');
        if (!data.party[side].includes(monId)) return res.status(400).json({ error: 'tera_invalido' });
        if (data.tera[side]) return res.status(400).json({ error: 'tera_usado' });
        const p = await store.getPokemon(monId);
        const type = p && TERA_TYPES.includes(p.teraType) ? p.teraType : (p && p.type1) || 'Normal';
        data.tera[side] = { mon: monId, type };
        pushLog(data, { k: 'tera', side, mon: monId, type });
      }
    }
    if (body.status !== undefined) {
      if (!['active', 'ended'].includes(body.status)) return res.status(400).json({ error: 'status_invalido' });
      const winner = body.winner === undefined ? null : body.winner;
      if (![null, 'a', 'b', 'draw'].includes(winner)) return res.status(400).json({ error: 'vencedor_invalido' });
      if (body.status === 'ended' && data.status !== 'ended') {
        // keep how every Pokémon ended this battle, then heal them for the next one
        const mons = await store.listPokemon(roomId);
        const busy = await monsInOtherActiveBattles(roomId, id);
        data.final = {};
        for (const monId of [...data.party.a, ...data.party.b]) {
          const p = mons.find(x => x.id === monId);
          if (!p) continue;
          data.final[monId] = p.battle ? JSON.parse(JSON.stringify(p.battle)) : {};
          if (!busy.has(monId)) await setMonBattle(p, roomId, {});
        }
        Object.assign(data, { status: 'ended', winner, endedAt: new Date().toISOString() });
        pushLog(data, { k: 'end', winner });
      } else if (body.status === 'active' && data.status === 'ended') {
        // reopening picks up where it stopped
        if (data.final) {
          const mons = await store.listPokemon(roomId);
          const busy = await monsInOtherActiveBattles(roomId, id);
          for (const [monId, state] of Object.entries(data.final)) {
            const p = mons.find(x => x.id === monId);
            if (p && !busy.has(monId)) await setMonBattle(p, roomId, state);
          }
        }
        Object.assign(data, { status: 'active', winner: null, endedAt: null, final: null });
        pushLog(data, { k: 'reopen' });
      }
    }
    await store.upsertBattle(id, roomId, data);
    res.json({ id, ...data });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'erro_interno' });
  }
});

app.delete('/api/battles/:id', auth, async (req, res) => {
  try {
    const b = await loadOwnBattle(req, res);
    if (!b) return;
    await store.deleteBattle(b.id);
    res.json({ ok: true });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'erro_interno' });
  }
});

/* ------------------------------------------------------------------ */
/* Teams                                                               */
/* ------------------------------------------------------------------ */
app.post('/api/teams', auth, async (req, res) => {
  try {
    const m = req.member;
    const id = req.body.id || uid();
    const existing = req.body.id ? await store.getTeam(id) : null;
    if (existing) {
      if (existing.roomId !== m.roomId) return res.status(403).json({ error: 'outra_sala' });
      if (!isGM(m) && existing.owner !== m.name) return res.status(403).json({ error: 'nao_e_seu' });
    }
    const owner = existing ? existing.owner : m.name;
    await store.upsertTeam(id, m.roomId, owner, cleanTeamData(req.body));
    res.json({ id, owner });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'erro_interno' });
  }
});

app.delete('/api/teams/:id', auth, async (req, res) => {
  try {
    const m = req.member;
    const t = await store.getTeam(req.params.id);
    if (!t) return res.json({ ok: true });
    if (t.roomId !== m.roomId) return res.status(403).json({ error: 'outra_sala' });
    if (!isGM(m) && t.owner !== m.name) return res.status(403).json({ error: 'nao_e_seu' });
    await store.deleteTeam(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'erro_interno' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

dbReady.then(() => app.listen(PORT, () => console.log(`Pokémon Gustavo rodando na porta ${PORT}`)));

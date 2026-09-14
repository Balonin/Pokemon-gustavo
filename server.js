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
      ALTER TABLE members ADD COLUMN IF NOT EXISTS avatar TEXT NOT NULL DEFAULT '';
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
      return { id: x.id, name: x.name, gmName: x.gm_name, gmToken: x.gm_token };
    },
    async addMember(m) {
      await pool.query(
        'INSERT INTO members (token, room_id, name, role, avatar) VALUES ($1,$2,$3,$4,$5)',
        [m.token, m.roomId, m.name, m.role, m.avatar || '']
      );
    },
    async getMember(token) {
      const r = await pool.query('SELECT * FROM members WHERE token = $1', [token]);
      if (!r.rows[0]) return null;
      const x = r.rows[0];
      return { token: x.token, roomId: x.room_id, name: x.name, role: x.role, avatar: x.avatar || '' };
    },
    async listMembers(roomId) {
      const r = await pool.query('SELECT name, role, avatar FROM members WHERE room_id = $1 ORDER BY created_at', [roomId]);
      return r.rows;
    },
    /* the same person may hold several tokens (one per device): keep the avatar in sync on all of them */
    async setMemberAvatar(roomId, name, avatar) {
      await pool.query('UPDATE members SET avatar = $3 WHERE room_id = $1 AND name = $2', [roomId, name, avatar]);
    },
    async listNpcs(roomId) {
      const r = await pool.query('SELECT id, name, avatar FROM npcs WHERE room_id = $1 ORDER BY created_at', [roomId]);
      return r.rows;
    },
    async getNpc(id) {
      const r = await pool.query('SELECT id, room_id, name, avatar FROM npcs WHERE id = $1', [id]);
      if (!r.rows[0]) return null;
      const x = r.rows[0];
      return { id: x.id, roomId: x.room_id, name: x.name, avatar: x.avatar || '' };
    },
    async upsertNpc(npc) {
      await pool.query(
        `INSERT INTO npcs (id, room_id, name, avatar) VALUES ($1,$2,$3,$4)
         ON CONFLICT (id) DO UPDATE SET name = $3, avatar = $4`,
        [npc.id, npc.roomId, npc.name, npc.avatar]
      );
    },
    async deleteNpc(id, owner) {
      await pool.query('DELETE FROM pokemon WHERE owner = $1', [owner]);
      await pool.query('DELETE FROM npcs WHERE id = $1', [id]);
    },
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
  const mem = { rooms: {}, members: {}, pokemon: {}, teams: {}, npcs: {} };
  store = {
    async createRoom(room) { mem.rooms[room.id] = room; },
    async getRoom(id) { return mem.rooms[id] || null; },
    async addMember(m) { mem.members[m.token] = { avatar: '', ...m }; },
    async getMember(token) { return mem.members[token] || null; },
    async listMembers(roomId) {
      return Object.values(mem.members).filter(m => m.roomId === roomId)
        .map(m => ({ name: m.name, role: m.role, avatar: m.avatar || '' }));
    },
    async setMemberAvatar(roomId, name, avatar) {
      Object.values(mem.members).forEach(m => { if (m.roomId === roomId && m.name === name) m.avatar = avatar; });
    },
    async listNpcs(roomId) {
      return Object.values(mem.npcs).filter(n => n.roomId === roomId)
        .map(n => ({ id: n.id, name: n.name, avatar: n.avatar }));
    },
    async getNpc(id) { return mem.npcs[id] || null; },
    async upsertNpc(npc) { mem.npcs[npc.id] = { ...npc }; },
    async deleteNpc(id, owner) {
      Object.values(mem.pokemon).forEach(p => { if (p.owner === owner) delete mem.pokemon[p.id]; });
      delete mem.npcs[id];
    },
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

/* one entry per trainer name, even if they joined from several devices */
function uniqueMembers(rows) {
  const byName = new Map();
  rows.forEach(r => {
    const cur = byName.get(r.name);
    if (!cur) { byName.set(r.name, { name: r.name, role: r.role, avatar: r.avatar || '' }); return; }
    if (r.role === 'gm') cur.role = 'gm';
    if (!cur.avatar && r.avatar) cur.avatar = r.avatar;
  });
  return [...byName.values()];
}

/* who the GM may assign as owner of a new ficha: themself, any member, or an NPC of the room */
async function isValidOwner(roomId, owner) {
  if (owner.startsWith(NPC_PREFIX)) {
    const npc = await store.getNpc(owner.slice(NPC_PREFIX.length));
    return !!npc && npc.roomId === roomId;
  }
  return (await store.listMembers(roomId)).some(x => x.name === owner);
}

/* strip fields the client must not control */
function cleanMonData(body) {
  const allowed = ['species','nickname','type1','type2','level','natureName','natureUp','natureDown',
    'base100','stage','maxStage','committed','legendary','distributed','ability','notes','moves','shiny',
    'order','battle'];
  const out = {};
  allowed.forEach(k => { if (body[k] !== undefined) out[k] = body[k]; });
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
    // rejoining under the same name (new device) keeps the avatar already chosen
    const prev = (await store.listMembers(roomId)).find(x => x.name === name && x.avatar);
    const avatar = prev ? prev.avatar : '';
    const t = token();
    await store.addMember({ token: t, roomId, name, role: 'player', avatar });
    res.json({ roomId, name: room.name, token: t, role: 'player', avatar });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'erro_interno' });
  }
});

app.get('/api/state', auth, async (req, res) => {
  try {
    const m = req.member;
    const room = await store.getRoom(m.roomId);
    if (!room) return res.status(404).json({ error: 'sala_nao_encontrada' });
    let pokemon = await store.listPokemon(m.roomId);
    let teams = await store.listTeams(m.roomId);
    if (!isGM(m)) {
      pokemon = pokemon.filter(p => p.owner === m.name);
      teams = teams.filter(t => t.owner === m.name);
    }
    const members = isGM(m) ? uniqueMembers(await store.listMembers(m.roomId)) : [];
    const npcs = isGM(m) ? await store.listNpcs(m.roomId) : [];
    res.json({
      room: { id: room.id, name: room.name, gmName: room.gmName },
      me: { name: m.name, role: m.role, avatar: m.avatar || '' },
      members, npcs, pokemon, teams
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

app.post('/api/npcs', auth, async (req, res) => {
  try {
    const m = req.member;
    if (!isGM(m)) return res.status(403).json({ error: 'so_mestre' });
    const name = String(req.body.name || '').trim().slice(0, 40);
    if (!name) return res.status(400).json({ error: 'nome_obrigatorio' });
    const avatar = cleanAvatar(req.body.avatar);
    if (avatar === null) return res.status(400).json({ error: 'avatar_invalido' });
    const npc = { id: uid(), roomId: m.roomId, name, avatar };
    await store.upsertNpc(npc);
    res.json({ id: npc.id, owner: npcOwner(npc.id), name, avatar });
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
    await store.upsertNpc({ ...npc, name, avatar });
    res.json({ ok: true });
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
    await store.deleteNpc(npc.id, npcOwner(npc.id));
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
    await store.upsertPokemon(id, m.roomId, owner, cleanMonData(req.body));
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
    const { id, roomId, owner, ...data } = p;
    if (req.body.battle !== undefined) data.battle = req.body.battle;
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

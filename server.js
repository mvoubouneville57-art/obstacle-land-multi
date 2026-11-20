// Serveur multijoueur d'Obstacle Land.
// Rôle : relayer les positions entre les joueurs d'un même salon, gérer les salons (code à 4
// caractères), savoir qui est en ligne (liste d'amis) et envoyer les invitations.
// Il ne stocke rien : tout est en mémoire (si le serveur redémarre, les salons disparaissent).

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const MAX_ROOM = 4;          // joueurs par salon
const MAX_LEVEL = 200;
const MAX_ROUNDS = 10;      // manches par partie
const NEXT_DELAY = Number(process.env.NEXT_DELAY || 8);   // secondes avant la manche suivante
const VERSION = 4;          // version du serveur (le jeu vérifie qu'elle est assez récente)
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const players = new Map();   // id -> { id, name, skin, room, ws }
const rooms = new Map();     // code -> { code, host, members:Set, level, finishes:[] }

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Obstacle Land multijoueur v' + VERSION + ' : OK (' + players.size + ' joueurs, ' + rooms.size + ' salons)');
});
const wss = new WebSocketServer({ server, maxPayload: 8192 });

function randomCode(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHA[Math.floor(Math.random() * ALPHA.length)];
  return s;
}
function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function num(v, min, max) {
  v = Number(v);
  if (!Number.isFinite(v)) v = 0;
  return Math.max(min, Math.min(max, v));
}
function roomInfo(r) {
  const list = [];
  for (const id of r.members) {
    const p = players.get(id);
    if (p) list.push({ id, name: p.name, skin: p.skin });
  }
  return { t: 'room', code: r.code, host: r.host, level: r.level, plan: r.plan, players: list };
}
function broadcastRoom(r) {
  const info = roomInfo(r);
  for (const id of r.members) {
    const p = players.get(id);
    if (p) send(p.ws, info);
  }
}
function sendAll(r, msg) {
  for (const id of r.members) {
    const p = players.get(id);
    if (p) send(p.ws, msg);
  }
}
function standings(r) {
  return [...r.scores.values()]
    .map((s) => ({ id: s.id, name: s.name, pts: s.pts, wins: s.wins }))
    .sort((a, b) => (b.pts - a.pts) || (b.wins - a.wins) || a.name.localeCompare(b.name));
}
// Lance la manche suivante de la partie
function startRound(r) {
  r.round += 1;
  r.level = r.levels[r.round - 1];
  r.finishes = [];
  r.active = true;
  r.entries = [];
  r.done = new Set();
  r.roundSize = r.members.size;
  const seed = Math.floor(Math.random() * 2000000000);   // graine commune : scies identiques pour tous
  sendAll(r, { t: 'start', level: r.level, seed, round: r.round, rounds: r.levels.length });
}
// Quand tous les joueurs ont fini la manche (ou abandonné) : points, classement, manche suivante
function checkResults(r) {
  if (!r.active) return;
  for (const id of r.members) if (!r.done.has(id)) return;
  r.active = false;
  const list = r.entries.slice().sort((a, b) => ((a.dnf ? 1 : 0) - (b.dnf ? 1 : 0)) || (a.time - b.time));
  const n = Math.max(1, r.roundSize);
  let rank = 0;
  for (const e of list) {
    const sc = r.scores.get(e.id) || { id: e.id, name: e.name, pts: 0, wins: 0 };
    sc.name = e.name;
    if (e.dnf) e.pts = 0;
    else {
      rank += 1;
      e.pts = Math.max(1, n - rank + 1);       // 1er = nombre de joueurs, dernier = 1 point, éliminé = 0
      sc.pts += e.pts;
      if (rank === 1) sc.wins += 1;
    }
    r.scores.set(e.id, sc);
  }
  const last = r.round >= r.levels.length;
  sendAll(r, { t: 'results', list, standings: standings(r), round: r.round, rounds: r.levels.length,
    final: last, next_in: last ? 0 : NEXT_DELAY });
  if (last) r.series = false;
  else {
    r.timer = setTimeout(() => { r.timer = null; if (r.series && r.members.size > 0) startRound(r); }, NEXT_DELAY * 1000);
  }
}
function leaveRoom(p) {
  if (!p.room) return;
  const r = rooms.get(p.room);
  p.room = null;
  if (r) {
    r.members.delete(p.id);
    if (r.members.size === 0) { if (r.timer) clearTimeout(r.timer); rooms.delete(r.code); }
    else {
      if (r.host === p.id) r.host = [...r.members][0];
      broadcastRoom(r);
      checkResults(r);          // un joueur qui part ne bloque pas le classement
    }
  }
  send(p.ws, { t: 'left' });
}
function joinRoom(p, r) {
  leaveRoom(p);
  r.members.add(p.id);
  p.room = r.code;
  broadcastRoom(r);
}

function cleanLevels(v) {
  if (!Array.isArray(v)) return [];
  return v.slice(0, MAX_ROUNDS).map((x) => Math.round(num(x, 1, MAX_LEVEL)));
}

function handle(ws, state, m) {
  if (!m || typeof m.t !== 'string') return;

  if (m.t === 'hello') {
    const id = String(m.id || '').toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(id)) return;
    const old = players.get(id);
    if (old && old.ws !== ws) {           // même joueur qui se reconnecte : on remplace l'ancienne connexion
      leaveRoom(old);
      players.delete(id);
      try { old.ws.close(); } catch (e) {}
    }
    const me = { id, name: String(m.name || 'Joueur').slice(0, 16), skin: String(m.skin || '').slice(0, 32), room: null, ws };
    players.set(id, me);
    state.me = me;
    send(ws, { t: 'hello_ok', v: VERSION });
    return;
  }

  const me = state.me;
  if (!me) return;

  switch (m.t) {
    case 'ping':
      send(ws, { t: 'pong' });
      break;

    case 'profil': {
      me.name = String(m.name || me.name).slice(0, 16);
      me.skin = String(m.skin || me.skin).slice(0, 32);
      const r = rooms.get(me.room);
      if (r) broadcastRoom(r);
      break;
    }

    case 'presence': {
      const ids = Array.isArray(m.ids) ? m.ids.slice(0, 50) : [];
      send(ws, { t: 'presence', online: ids.map(String).filter((id) => players.has(id)) });
      break;
    }

    case 'create': {
      let code;
      do { code = randomCode(4); } while (rooms.has(code));
      const r = { code, host: me.id, members: new Set(), level: 1, plan: [], levels: [], round: 0, series: false,
        scores: new Map(), timer: null, roundSize: 0, finishes: [], active: false, entries: [], done: new Set() };
      rooms.set(code, r);
      joinRoom(me, r);
      break;
    }

    case 'join': {
      const code = String(m.code || '').toUpperCase().trim();
      const r = rooms.get(code);
      if (!r) { send(ws, { t: 'error', msg: 'Salon introuvable' }); break; }
      if (!r.members.has(me.id) && r.members.size >= MAX_ROOM) { send(ws, { t: 'error', msg: 'Salon plein' }); break; }
      if (!r.members.has(me.id)) joinRoom(me, r);
      else broadcastRoom(r);
      break;
    }

    case 'leave':
      leaveRoom(me);
      break;

    case 'setlevels': {                    // le chef choisit les manches (liste de niveaux)
      const r = rooms.get(me.room);
      if (!r || r.host !== me.id) break;
      r.plan = cleanLevels(m.levels);
      broadcastRoom(r);
      break;
    }

    case 'start': {
      const r = rooms.get(me.room);
      if (!r || r.host !== me.id) break;      // seul le chef lance
      if (r.timer) { clearTimeout(r.timer); r.timer = null; }
      let levels = cleanLevels(m.levels);
      if (levels.length === 0) levels = [Math.round(num(m.level, 1, MAX_LEVEL))];
      r.levels = levels;
      r.plan = levels;
      r.round = 0;
      r.scores = new Map();
      r.series = true;
      broadcastRoom(r);
      startRound(r);
      break;
    }

    case 'endseries': {                    // le chef termine la partie : classement final tout de suite
      const r = rooms.get(me.room);
      if (!r || r.host !== me.id || r.round === 0) break;
      if (r.timer) { clearTimeout(r.timer); r.timer = null; }
      r.active = false;
      r.series = false;
      sendAll(r, { t: 'final', standings: standings(r) });
      break;
    }

    case 'state': {
      const r = rooms.get(me.room);
      if (!r) break;
      const msg = {
        t: 'state', id: me.id,
        x: num(m.x, -100000, 100000), y: num(m.y, -100000, 100000),
        a: String(m.a || 'idle').slice(0, 12), fx: !!m.fx, lv: Math.round(num(m.lv, 0, MAX_LEVEL)),
      };
      if (m.mo && typeof m.mo === 'object') {      // monstre du joueur (visible par les autres)
        msg.mo = {
          x: num(m.mo.x, -100000, 100000), y: num(m.mo.y, -100000, 100000), sy: num(m.mo.sy, -1000, 1000),
          fr: Math.round(num(m.mo.fr, -1, 7)), fx: !!m.mo.fx,
        };
      }
      for (const id of r.members) {
        if (id === me.id) continue;
        const p = players.get(id);
        if (p) send(p.ws, msg);
      }
      break;
    }

    case 'ev': {                       // événement d'obstacle (piège déclenché, chute du ciel)
      const r = rooms.get(me.room);
      if (!r || !r.active) break;
      let msg = null;
      if (m.k === 'trap') msg = { t: 'ev', k: 'trap', id: String(m.id || '').slice(0, 80) };
      else if (m.k === 'sky') {
        const ty = String(m.ty || '');
        if (!['rock', 'ice', 'fireball', 'meteor'].includes(ty)) break;
        msg = { t: 'ev', k: 'sky', ty, x: num(m.x, -100000, 100000), sd: Math.round(num(m.sd, -1, 1)) };
      }
      if (!msg) break;
      for (const id of r.members) {
        if (id === me.id) continue;
        const p = players.get(id);
        if (p) send(p.ws, msg);
      }
      break;
    }

    case 'finish': {
      const r = rooms.get(me.room);
      if (!r || !r.active || r.done.has(me.id)) break;
      r.done.add(me.id);
      const dnf = !!m.dnf;                       // true = éliminé (plus de vies)
      const time = num(m.time, 0, 100000);
      r.entries.push({ id: me.id, name: me.name, time, dnf });
      let msg;
      if (dnf) msg = { t: 'dnf', id: me.id, name: me.name };
      else {
        r.finishes.push(me.id);
        msg = { t: 'finish', id: me.id, name: me.name, time, rank: r.finishes.length };
      }
      for (const id of r.members) {
        const p = players.get(id);
        if (p) send(p.ws, msg);
      }
      checkResults(r);
      break;
    }

    case 'invite': {
      const target = players.get(String(m.to || '').toUpperCase());
      if (!me.room) { send(ws, { t: 'error', msg: "Crée ou rejoins un salon d'abord" }); break; }
      if (!target || target === me) { send(ws, { t: 'error', msg: 'Cet ami est hors ligne' }); break; }
      send(target.ws, { t: 'invite', from: me.id, name: me.name, code: me.room });
      send(ws, { t: 'info', msg: 'Invitation envoyée à ' + target.name });
      break;
    }
  }
}

wss.on('connection', (ws) => {
  const state = { me: null };
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data) => {
    let m;
    try { m = JSON.parse(data.toString()); } catch (e) { return; }
    try { handle(ws, state, m); } catch (e) { console.error('Erreur :', e); }
  });
  ws.on('close', () => {
    const me = state.me;
    if (me && players.get(me.id) === me) {
      leaveRoom(me);
      players.delete(me.id);
    }
  });
  ws.on('error', () => {});
});

// Nettoie les connexions mortes
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
}, 30000);

server.listen(PORT, () => console.log('Serveur multijoueur sur le port ' + PORT));

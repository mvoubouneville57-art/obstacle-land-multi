// Serveur multijoueur d'Obstacle Land.
// Rôle : relayer les positions entre les joueurs d'un même salon, gérer les salons (code à 4
// caractères), savoir qui est en ligne (liste d'amis) et envoyer les invitations.
// Il ne stocke rien : tout est en mémoire (si le serveur redémarre, les salons disparaissent).

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const MAX_ROOM = 4;          // joueurs par salon
const MAX_LEVEL = 200;
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const players = new Map();   // id -> { id, name, skin, room, ws }
const rooms = new Map();     // code -> { code, host, members:Set, level, finishes:[] }

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Obstacle Land multijoueur : OK (' + players.size + ' joueurs, ' + rooms.size + ' salons)');
});
const wss = new WebSocketServer({ server, maxPayload: 4096 });

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
  return { t: 'room', code: r.code, host: r.host, level: r.level, players: list };
}
function broadcastRoom(r) {
  const info = roomInfo(r);
  for (const id of r.members) {
    const p = players.get(id);
    if (p) send(p.ws, info);
  }
}
function leaveRoom(p) {
  if (!p.room) return;
  const r = rooms.get(p.room);
  p.room = null;
  if (r) {
    r.members.delete(p.id);
    if (r.members.size === 0) rooms.delete(r.code);
    else {
      if (r.host === p.id) r.host = [...r.members][0];
      broadcastRoom(r);
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
    send(ws, { t: 'hello_ok' });
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
      const r = { code, host: me.id, members: new Set(), level: 1, finishes: [] };
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

    case 'start': {
      const r = rooms.get(me.room);
      if (!r || r.host !== me.id) break;      // seul le chef lance
      r.level = Math.round(num(m.level, 1, MAX_LEVEL));
      r.finishes = [];
      for (const id of r.members) {
        const p = players.get(id);
        if (p) send(p.ws, { t: 'start', level: r.level });
      }
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
      for (const id of r.members) {
        if (id === me.id) continue;
        const p = players.get(id);
        if (p) send(p.ws, msg);
      }
      break;
    }

    case 'finish': {
      const r = rooms.get(me.room);
      if (!r || r.finishes.includes(me.id)) break;
      r.finishes.push(me.id);
      const msg = { t: 'finish', id: me.id, name: me.name, time: num(m.time, 0, 100000), rank: r.finishes.length };
      for (const id of r.members) {
        const p = players.get(id);
        if (p) send(p.ws, msg);
      }
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

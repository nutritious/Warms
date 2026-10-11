'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ---------------------------------------------------------------- storage */

const PERMS = ['manage_roles', 'manage_channels', 'manage_users', 'delete_messages'];

function freshDb() {
  return {
    users: {},
    sessions: {},
    serverName: 'Warms',
    settings: { registrationOpen: true, welcomeText: 'Welcome {name}! \uD83D\uDC4B' },
    roles: [
      { id: 'owner', name: 'Owner', color: '#f5b83d', position: 0, perms: PERMS.slice() },
      { id: 'admin', name: 'Admin', color: '#f04747', position: 1, perms: PERMS.slice() },
      { id: 'manager', name: 'Manager', color: '#43b581', position: 2, perms: ['manage_channels', 'delete_messages'] },
      { id: 'moderator', name: 'Moderator', color: '#3ba0e6', position: 3, perms: ['delete_messages', 'manage_users'] },
      { id: 'member', name: 'Member', color: '#b9bbbe', position: 100, perms: [] },
    ],
    spaces: [{ id: 'main', name: 'Warms' }],
    channels: [
      { id: 'general', name: 'general', spaceId: 'main' },
      { id: 'music', name: 'music', spaceId: 'main' },
    ],
    messages: { general: [], music: [] },
  };
}

let db;
try {
  db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
} catch (e) {
  db = freshDb();
}

db.settings = Object.assign({ registrationOpen: true, welcomeText: 'Welcome {name}! \uD83D\uDC4B' }, db.settings || {});
// Older data had Admin at the top. Add the Owner role above it and make the founding Admin the Owner.
if (!db.roles.some((r) => r.id === 'owner')) {
  for (const r of db.roles) if (r.position < 100) r.position += 1;
  db.roles.unshift({ id: 'owner', name: 'Owner', color: '#f5b83d', position: 0, perms: PERMS.slice() });
  const people = Object.values(db.users).sort((a, b) => a.createdAt - b.createdAt);
  const founder = people.find((u) => u.roleId === 'admin') || people[0];
  if (founder) founder.roleId = 'owner';
}
for (const u of Object.values(db.users)) if (u.announced === undefined) u.announced = true;
db.audit = db.audit || [];
db.reports = db.reports || [];
// Spaces (the icons on the far-left bar). Older data had one server: it becomes the first space.
if (!Array.isArray(db.spaces) || !db.spaces.length) db.spaces = [{ id: 'main', name: db.serverName || 'Warms' }];
for (const c of db.channels) if (!c.spaceId) c.spaceId = db.spaces[0].id;
// One global #announcements chat, shown as its own icon on the far-left bar. Only the Owner can post in it.
// (An earlier version put one in every space: keep the first one's history and drop the rest.)
const ANN = 'announcements';
{
  let ann = db.channels.find((c) => c.global);
  if (!ann) ann = db.channels.find((c) => c.locked) || db.channels.find((c) => c.name === 'announcements' && c.spaceId === db.spaces[0].id);
  if (!ann) { ann = { id: 'ann' + Math.random().toString(36).slice(2, 8), name: 'announcements' }; db.channels.unshift(ann); }
  Object.assign(ann, { name: 'announcements', spaceId: ANN, locked: true, global: true });
  for (const c of db.channels.filter((x) => x.locked && x !== ann)) delete db.messages[c.id];
  db.channels = db.channels.filter((x) => !x.locked || x === ann);
  db.messages[ann.id] = db.messages[ann.id] || [];
}
const spaceById = (id) => db.spaces.find((x) => x.id === id);
const syncServerName = () => { db.serverName = db.spaces[0].name; };
syncServerName();
function audit(user, text) {
  db.audit.push({ ts: Date.now(), by: user.username, text });
  if (db.audit.length > 500) db.audit.splice(0, db.audit.length - 500);
}

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = DB_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(db), (err) => {
      if (!err) fs.rename(tmp, DB_FILE, () => {});
    });
  }, 150);
}
save();

const uid = (n = 8) => crypto.randomBytes(n).toString('hex');

/* ------------------------------------------------------------------ auth */

function hashPassword(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, key) => (err ? reject(err) : resolve(key.toString('hex'))));
  });
}

function safeEqual(a, b) {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Tiny in-memory rate limiter for login / register attempts.
const attempts = new Map();
function rateLimited(key, max = 10, windowMs = 60_000) {
  const now = Date.now();
  const list = (attempts.get(key) || []).filter((t) => now - t < windowMs);
  list.push(now);
  attempts.set(key, list);
  return list.length > max;
}

const roleById = (id) => db.roles.find((r) => r.id === id);
const roleOf = (user) => roleById(user.roleId) || roleById('member');
// "Admin" in the checks below means full power: the Owner or an Admin.
const isOwner = (user) => roleOf(user).id === 'owner';
const isAdmin = (user) => roleOf(user).id === 'owner' || roleOf(user).id === 'admin';
const can = (user, perm) => isAdmin(user) || roleOf(user).perms.includes(perm);
// Lower position number = higher rank.
const outranks = (a, b) => roleOf(a).position < roleOf(b).position;

// Shared by the role dropdown and the console. Returns an error message, or null when the change is allowed.
function roleChangeError(actor, target, role) {
  if (role.id === 'owner') return 'Ownership can only be handed over with Transfer ownership in the Owner Panel';
  if (target.roleId === 'owner') return "The Owner's role cannot be changed";
  if (target.id !== actor.id && !outranks(actor, target)) return 'You can only change roles of people ranked below you';
  if (!(roleOf(actor).position < role.position)) return 'You cannot give a role equal to or above your own';
  return null;
}
const hasAnyPerm = (u) => PERMS.some((p) => can(u, p));
const muteLeft = (u) => (u.mutedUntil && u.mutedUntil > Date.now() ? Math.ceil((u.mutedUntil - Date.now()) / 60000) : 0);

function publicUser(u) {
  return { id: u.id, username: u.username, roleId: u.roleId, createdAt: u.createdAt, online: online.has(u.id), status: u.status || '', avatar: u.avatar || null, mutedUntil: u.mutedUntil && u.mutedUntil > Date.now() ? u.mutedUntil : 0 };
}

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const userId = db.sessions[token];
  const user = userId && db.users[userId];
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  req.user = user;
  req.token = token;
  next();
}

function need(perm) {
  return (req, res, next) => (can(req.user, perm) ? next() : res.status(403).json({ error: 'You do not have permission to do that' }));
}

/* -------------------------------------------------------------- realtime */

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const sockets = new Map(); // ws -> userId
const online = new Set();

function recomputeOnline() {
  online.clear();
  for (const id of sockets.values()) online.add(id);
}

function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const ws of sockets.keys()) if (ws.readyState === 1) ws.send(data);
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws') return socket.destroy();
  const userId = db.sessions[url.searchParams.get('token')];
  if (!userId || !db.users[userId]) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    const wasOnline = online.has(userId);
    sockets.set(ws, userId);
    recomputeOnline();
    broadcast({ t: 'presence' });
    if (!wasOnline) announceEntry(db.users[userId]);
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m && typeof m.t === 'string' && m.t.startsWith('voice-')) handleVoice(ws, userId, m);
    });
    ws.on('close', () => {
      voiceLeave(userId, ws);
      sockets.delete(ws);
      recomputeOnline();
      lastSeen.set(userId, Date.now());
      broadcast({ t: 'presence' });
    });
    ws.on('error', () => {});
  });
});

/* ----------------------------------------------------------------- voice
   Voice rooms are fixed. Audio goes directly between browsers (WebRTC mesh); the server only relays the
   connection handshake and keeps track of who is in which room. */
// Every space has its own Lounge and Hangout.
const voiceChannels = () => db.spaces.flatMap((sp) => [{ id: sp.id + ':lounge', spaceId: sp.id, name: 'Lounge' }, { id: sp.id + ':hangout', spaceId: sp.id, name: 'Hangout' }]);
const VOICE_MAX = 8;
const voice = new Map(); // userId -> { room, ws, muted, deaf }
function voiceSnapshot() {
  const out = {};
  for (const c of voiceChannels()) out[c.id] = [];
  for (const [id, v] of voice) if (out[v.room] && db.users[id]) out[v.room].push({ userId: id, muted: v.muted, deaf: v.deaf });
  return out;
}
const voiceBroadcast = () => broadcast({ t: 'voice', voice: voiceSnapshot() });
function voiceLeave(userId, ws) {
  const v = voice.get(userId);
  if (!v || (ws && v.ws !== ws)) return;
  voice.delete(userId);
  for (const [w, id] of sockets) if (id !== userId && voice.get(id) && voice.get(id).room === v.room && w.readyState === 1) w.send(JSON.stringify({ t: 'voice-left', userId }));
  voiceBroadcast();
}
function handleVoice(ws, userId, m) {
  const user = db.users[userId];
  const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
  if (!user) return;
  if (m.t === 'voice-join') {
    const room = voiceChannels().find((c) => c.id === m.room);
    if (!room) return send({ t: 'voice-error', error: 'No such voice channel' });
    if (user.mutedUntil && user.mutedUntil > Date.now()) return send({ t: 'voice-error', error: 'You are muted right now' });
    const here = [...voice].filter(([id, v]) => v.room === room.id && id !== userId);
    if (here.length >= VOICE_MAX) return send({ t: 'voice-error', error: 'That channel is full (' + VOICE_MAX + ' people)' });
    voiceLeave(userId);
    voice.set(userId, { room: room.id, ws, muted: false, deaf: false });
    send({ t: 'voice-joined', room: room.id, peers: here.map(([id]) => id) });
    voiceBroadcast();
  } else if (m.t === 'voice-leave') {
    voiceLeave(userId);
  } else if (m.t === 'voice-state') {
    const v = voice.get(userId);
    if (!v || v.ws !== ws) return;
    v.muted = !!m.muted; v.deaf = !!m.deaf;
    voiceBroadcast();
  } else if (m.t === 'voice-signal') {
    const v = voice.get(userId), to = voice.get(String(m.to));
    if (!v || !to || to.room !== v.room || JSON.stringify(m.data || '').length > 20000) return;
    if (to.ws.readyState === 1) to.ws.send(JSON.stringify({ t: 'voice-signal', from: userId, data: m.data }));
  }
}

// A brand-new member gets a welcome in the first channel and a pop-up for everyone.
// Returning members trigger a small "signed in" notice, unless they were here in the last two minutes.
const lastSeen = new Map();
function announceEntry(user) {
  if (!user) return;
  const now = Date.now();
  if (!user.announced) {
    user.announced = true;
    if (Object.keys(db.users).length > 1) {
      const ch = db.channels.find((c) => !c.locked) || db.channels[0];
      const text = String(db.settings.welcomeText || 'Welcome {name}!').replace(/\{name\}/g, user.username).slice(0, 200);
      const msg = { id: uid(8), channelId: ch.id, userId: user.id, content: text, image: null, ts: now, system: 'join', replyTo: null, reactions: {} };
      db.messages[ch.id].push(msg);
      broadcast({ t: 'message', msg });
      broadcast({ t: 'welcome', userId: user.id, username: user.username, text });
    }
    save();
  } else if (now - (lastSeen.get(user.id) || 0) > 120000) {
    broadcast({ t: 'signin', userId: user.id, username: user.username });
  }
  lastSeen.set(user.id, now);
}

// Drop every live socket belonging to a user (used when they are removed).
function disconnectUser(userId) {
  for (const [ws, id] of sockets) if (id === userId) ws.close();
}

/* ------------------------------------------------------------------ http */

app.disable('x-powered-by');
// Hosts put a proxy in front of the app; trust it so rate limits see each visitor's real IP.
app.set('trust proxy', 1);
app.use(express.json({ limit: '8mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d', index: false }));
app.use(express.static(path.join(__dirname, 'public')));

const USERNAME_RE = /^[A-Za-z0-9_.\- ]{2,24}$/;

app.get('/api/status', (req, res) => {
  res.json({ hasUsers: Object.keys(db.users).length > 0, serverName: db.serverName, registrationOpen: db.settings.registrationOpen });
});

app.post('/api/register', async (req, res) => {
  try {
    if (rateLimited('reg:' + req.ip, 10)) return res.status(429).json({ error: 'Too many attempts, wait a minute' });
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'Username must be 2-24 characters (letters, numbers, space, _ . -)' });
    if (password.length < 6 || password.length > 200) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const lower = username.toLowerCase();
    if (!db.settings.registrationOpen && Object.keys(db.users).length > 0) return res.status(403).json({ error: 'Sign-ups are closed right now. Ask the Owner for access.' });
    if (Object.values(db.users).some((u) => u.username.toLowerCase() === lower)) return res.status(409).json({ error: 'That username is taken' });

    const salt = uid(16);
    const hash = await hashPassword(password, salt);

    // Re-check after the async hash so two simultaneous sign-ups can never both become admin.
    if (Object.values(db.users).some((u) => u.username.toLowerCase() === lower)) return res.status(409).json({ error: 'That username is taken' });
    const first = Object.keys(db.users).length === 0;
    const user = {
      id: uid(6), username, salt, hash,
      roleId: first ? 'owner' : 'member',
      createdAt: Date.now(),
      announced: false,
    };
    db.users[user.id] = user;
    const token = uid(32);
    db.sessions[token] = user.id;
    save();
    broadcast({ t: 'members' });
    res.json({ token, firstUser: first });
  } catch (e) {
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    if (rateLimited('login:' + req.ip, 15)) return res.status(429).json({ error: 'Too many attempts, wait a minute' });
    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const user = Object.values(db.users).find((u) => u.username.toLowerCase() === username);
    // Hash even for unknown users so response time does not reveal which names exist.
    const hash = await hashPassword(password, user ? user.salt : 'x'.repeat(32));
    if (!user || !safeEqual(hash, user.hash)) return res.status(401).json({ error: 'Wrong username or password' });
    const token = uid(32);
    db.sessions[token] = user.id;
    save();
    res.json({ token });
  } catch (e) {
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/logout', auth, (req, res) => {
  delete db.sessions[req.token];
  save();
  res.json({ ok: true });
});

app.get('/api/bootstrap', auth, (req, res) => {
  res.json({
    me: req.user.id,
    serverName: db.serverName,
    users: Object.values(db.users).map(publicUser),
    roles: db.roles.slice().sort((a, b) => a.position - b.position),
    channels: db.channels,
    spaces: db.spaces,
    annIcon: db.settings.annIcon || null,
    voiceChannels: voiceChannels(),
    voice: voiceSnapshot(),
    perms: PERMS,
  });
});

/* -------------------------------------------------------------- messages */

const UPLOAD_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

app.post('/api/upload', auth, (req, res) => {
  const m = /^data:(image\/[a-z+]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body.data || ''));
  const ext = m && UPLOAD_TYPES[m[1]];
  if (!ext) return res.status(400).json({ error: 'Only PNG, JPG, GIF or WEBP images are allowed' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 5 * 1024 * 1024) return res.status(413).json({ error: 'Image is over 5 MB' });
  const name = uid(12) + '.' + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  res.json({ url: '/uploads/' + name });
});

app.get('/api/channels/:id/messages', auth, (req, res) => {
  const list = db.messages[req.params.id];
  if (!list) return res.status(404).json({ error: 'No such channel' });
  res.json(list.slice(-100));
});

app.post('/api/channels/:id/messages', auth, (req, res) => {
  const list = db.messages[req.params.id];
  if (!list) return res.status(404).json({ error: 'No such channel' });
  const chan = db.channels.find((c) => c.id === req.params.id);
  if (chan && chan.locked && !isOwner(req.user)) return res.status(403).json({ error: 'Only the Owner can post in #announcements' });
  const left = muteLeft(req.user);
  if (left) return res.status(403).json({ error: `You are muted for another ${left} min` });
  const content = String(req.body.content || '').slice(0, 2000);
  const image = typeof req.body.image === 'string' && /^\/uploads\/[a-f0-9]+\.(png|jpg|gif|webp)$/.test(req.body.image) ? req.body.image : null;
  if (!content.trim() && !image) return res.status(400).json({ error: 'Empty message' });
  const replyTo = typeof req.body.replyTo === 'string' && list.some((m) => m.id === req.body.replyTo) ? req.body.replyTo : null;
  const msg = { id: uid(8), channelId: req.params.id, userId: req.user.id, content, image, ts: Date.now(), replyTo, reactions: {} };
  list.push(msg);
  if (list.length > 5000) list.splice(0, list.length - 5000);
  save();
  broadcast({ t: 'message', msg });
  res.json(msg);
});

app.delete('/api/messages/:id', auth, (req, res) => {
  for (const [channelId, list] of Object.entries(db.messages)) {
    const i = list.findIndex((m) => m.id === req.params.id);
    if (i === -1) continue;
    const msg = list[i];
    const own = msg.userId === req.user.id && !msg.system;
    if (!own && !can(req.user, 'delete_messages')) return res.status(403).json({ error: 'You do not have permission to do that' });
    if (!own) {
      const au = db.users[msg.userId];
      const ch = db.channels.find((c) => c.id === channelId);
      audit(req.user, `deleted a message from ${au ? au.username : 'a removed user'} in #${ch ? ch.name : 'unknown'}`);
    }
    list.splice(i, 1);
    save();
    broadcast({ t: 'delete', id: msg.id, channelId });
    return res.json({ ok: true });
  }
  res.status(404).json({ error: 'No such message' });
});

app.post('/api/typing', auth, (req, res) => {
  if (db.messages[req.body.channelId]) broadcast({ t: 'typing', channelId: req.body.channelId, userId: req.user.id });
  res.json({ ok: true });
});

/* -------------------------------------------------------------- channels */

app.post('/api/channels', auth, need('manage_channels'), (req, res) => {
  const name = String(req.body.name || '').toLowerCase().trim().replace(/[^a-z0-9\-_ ]/g, '').replace(/\s+/g, '-').slice(0, 32);
  if (!name) return res.status(400).json({ error: 'Channel name required' });
  const spaceId = req.body.spaceId ? String(req.body.spaceId) : db.spaces[0].id;
  if (!spaceById(spaceId)) return res.status(404).json({ error: 'No such space' });
  if (db.channels.some((c) => c.name === name && c.spaceId === spaceId)) return res.status(409).json({ error: 'That channel already exists in this space' });
  const ch = { id: uid(5), name, spaceId };
  db.channels.push(ch);
  audit(req.user, `created #${ch.name}`);
  db.messages[ch.id] = [];
  save();
  broadcast({ t: 'channels' });
  res.json(ch);
});

app.delete('/api/channels/:id', auth, need('manage_channels'), (req, res) => {
  const i = db.channels.findIndex((c) => c.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'No such channel' });
  if (db.channels[i].locked) return res.status(400).json({ error: '#announcements is shared by everyone and cannot be deleted' });
  if (db.channels.filter((c) => c.spaceId === db.channels[i].spaceId && !c.locked).length <= 1) return res.status(400).json({ error: 'A space needs at least one channel' });
  audit(req.user, `deleted #${db.channels[i].name}`);
  db.channels.splice(i, 1);
  delete db.messages[req.params.id];
  save();
  broadcast({ t: 'channels' });
  res.json({ ok: true });
});

/* ---------------------------------------------------------------- roles */

function cleanPerms(p) {
  return Array.isArray(p) ? p.filter((x) => PERMS.includes(x)) : [];
}
const cleanColor = (c) => (/^#[0-9a-fA-F]{6}$/.test(c) ? c : '#99aab5');

// You may only touch roles ranked below your own (admins may touch any except locked fields).
function canEditRole(user, role) {
  return roleOf(user).position < role.position;
}

app.post('/api/roles', auth, need('manage_roles'), (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 24);
  if (!name) return res.status(400).json({ error: 'Role name required' });
  if (db.roles.some((r) => r.name.toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: 'That role already exists' });
  const mine = roleOf(req.user);
  // A non-admin can only hand out permissions they hold themselves.
  const perms = cleanPerms(req.body.perms).filter((p) => can(req.user, p));
  const ranked = db.roles.filter((r) => r.position < 100).map((r) => r.position);
  const position = isAdmin(req.user) ? Math.max(...ranked) + 1 : Math.max(mine.position + 1, ...ranked) + 1;
  const role = { id: uid(4), name, color: cleanColor(req.body.color), position, perms };
  db.roles.push(role);
  audit(req.user, `created the ${role.name} role`);
  save();
  broadcast({ t: 'roles' });
  res.json(role);
});

app.patch('/api/roles/:id', auth, need('manage_roles'), (req, res) => {
  const role = roleById(req.params.id);
  if (!role) return res.status(404).json({ error: 'No such role' });
  if (!canEditRole(req.user, role)) return res.status(403).json({ error: 'You can only edit roles below your own' });
  if (typeof req.body.name === 'string' && req.body.name.trim()) {
    const name = req.body.name.trim().slice(0, 24);
    if (db.roles.some((r) => r.id !== role.id && r.name.toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: 'That role already exists' });
    role.name = name;
  }
  if (typeof req.body.color === 'string') role.color = cleanColor(req.body.color);
  if (role.id !== 'admin' && role.id !== 'owner' && Array.isArray(req.body.perms)) {
    role.perms = cleanPerms(req.body.perms).filter((p) => can(req.user, p) || role.perms.includes(p));
  }
  save();
  broadcast({ t: 'roles' });
  res.json(role);
});

app.post('/api/roles/:id/move', auth, need('manage_roles'), (req, res) => {
  const role = roleById(req.params.id);
  if (!role || ['owner', 'admin', 'member'].includes(role.id)) return res.status(400).json({ error: 'That role cannot be moved' });
  if (!canEditRole(req.user, role)) return res.status(403).json({ error: 'You can only move roles below your own' });
  const movable = db.roles.filter((r) => !['owner', 'admin', 'member'].includes(r.id)).sort((a, b) => a.position - b.position);
  const i = movable.findIndex((r) => r.id === role.id);
  const j = req.body.dir === 'up' ? i - 1 : i + 1;
  const other = movable[j];
  if (!other) return res.json({ ok: true });
  if (!canEditRole(req.user, other) && req.body.dir === 'up') return res.status(403).json({ error: 'You cannot move a role above your own' });
  [role.position, other.position] = [other.position, role.position];
  save();
  broadcast({ t: 'roles' });
  res.json({ ok: true });
});

app.delete('/api/roles/:id', auth, need('manage_roles'), (req, res) => {
  const role = roleById(req.params.id);
  if (!role) return res.status(404).json({ error: 'No such role' });
  if (['owner', 'admin', 'member'].includes(role.id)) return res.status(400).json({ error: 'That role cannot be deleted' });
  if (!canEditRole(req.user, role)) return res.status(403).json({ error: 'You can only delete roles below your own' });
  audit(req.user, `deleted the ${role.name} role`);
  db.roles = db.roles.filter((r) => r.id !== role.id);
  for (const u of Object.values(db.users)) if (u.roleId === role.id) u.roleId = 'member';
  save();
  broadcast({ t: 'roles' });
  broadcast({ t: 'members' });
  res.json({ ok: true });
});

/* ---------------------------------------------------------------- users */

app.put('/api/users/:id/role', auth, need('manage_roles'), (req, res) => {
  const target = db.users[req.params.id];
  const role = roleById(req.body.roleId);
  if (!target || !role) return res.status(404).json({ error: 'Not found' });
  const problem = roleChangeError(req.user, target, role);
  if (problem) return res.status(403).json({ error: problem });
  target.roleId = role.id;
  audit(req.user, `gave ${target.username} the ${role.name} role`);
  save();
  broadcast({ t: 'members' });
  res.json({ ok: true });
});

app.delete('/api/users/:id', auth, need('manage_users'), (req, res) => {
  const target = db.users[req.params.id];
  if (!target) return res.status(404).json({ error: 'No such user' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot remove yourself' });
  if (!outranks(req.user, target)) return res.status(403).json({ error: 'You can only remove people ranked below you' });
  audit(req.user, `removed ${target.username}`);
  delete db.users[target.id];
  for (const [t, id] of Object.entries(db.sessions)) if (id === target.id) delete db.sessions[t];
  disconnectUser(target.id);
  save();
  broadcast({ t: 'members' });
  res.json({ ok: true });
});

app.patch('/api/server', auth, need('manage_channels'), (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 32);
  if (!name) return res.status(400).json({ error: 'Name required' });
  const sp = req.body.spaceId ? spaceById(String(req.body.spaceId)) : db.spaces[0];
  if (!sp) return res.status(404).json({ error: 'No such space' });
  sp.name = name;
  syncServerName();
  save();
  broadcast({ t: 'server' });
  res.json({ ok: true });
});

/* ---------------------------------------------------------------- spaces */

app.post('/api/spaces', auth, (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Only the Owner and Admins can create spaces' });
  const name = String(req.body.name || '').trim().slice(0, 32);
  if (!name) return res.status(400).json({ error: 'Space name required' });
  if (db.spaces.length >= 20) return res.status(400).json({ error: 'You can have up to 20 spaces' });
  if (db.spaces.some((x) => x.name.toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: 'A space with that name already exists' });
  const sp = { id: uid(5), name };
  const ch = { id: uid(5), name: 'general', spaceId: sp.id };
  db.spaces.push(sp);
  db.channels.push(ch);
  db.messages[ch.id] = [];
  audit(req.user, `created the space ${sp.name}`);
  save();
  broadcast({ t: 'channels' });
  res.json({ space: sp, channel: ch });
});

app.put('/api/spaces/:id/icon', auth, (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Only the Owner and Admins can change a space picture' });
  const icon = req.body.icon === null ? null : String(req.body.icon || '');
  if (icon !== null && !/^\/uploads\/[a-f0-9]+\.(png|jpg|gif|webp)$/.test(icon)) return res.status(400).json({ error: 'Upload a PNG, JPG, GIF or WEBP image' });
  if (req.params.id === ANN) {
    db.settings.annIcon = icon;
    audit(req.user, icon ? 'changed the Announcements picture' : 'removed the Announcements picture');
  } else {
    const sp = spaceById(req.params.id);
    if (!sp) return res.status(404).json({ error: 'No such space' });
    if (icon) sp.icon = icon; else delete sp.icon;
    audit(req.user, icon ? `changed the picture of ${sp.name}` : `removed the picture of ${sp.name}`);
  }
  save();
  broadcast({ t: 'channels' });
  res.json({ ok: true });
});

app.delete('/api/spaces/:id', auth, (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Only the Owner and Admins can delete spaces' });
  const sp = spaceById(req.params.id);
  if (!sp) return res.status(404).json({ error: 'No such space' });
  if (sp.id === db.spaces[0].id) return res.status(400).json({ error: 'The first space cannot be deleted' });
  for (const c of db.channels.filter((x) => x.spaceId === sp.id)) delete db.messages[c.id];
  db.channels = db.channels.filter((c) => c.spaceId !== sp.id);
  db.spaces = db.spaces.filter((x) => x.id !== sp.id);
  for (const [id, v] of [...voice]) if (v.room.startsWith(sp.id + ':')) { try { v.ws.send(JSON.stringify({ t: 'voice-error', error: 'That space was deleted' })); } catch (e) { /* gone */ } voice.delete(id); }
  audit(req.user, `deleted the space ${sp.name}`);
  save();
  broadcast({ t: 'channels' });
  voiceBroadcast();
  res.json({ ok: true });
});



/* ------------------------------------------- reactions, edits, profile */

const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🎉', '🔥', '👀', '💯', '🐐'];

function findMsg(id) {
  for (const [channelId, list] of Object.entries(db.messages)) {
    const msg = list.find((m) => m.id === id);
    if (msg) return { msg, channelId, list };
  }
  return null;
}

app.put('/api/messages/:id/reactions', auth, (req, res) => {
  const f = findMsg(req.params.id);
  if (!f) return res.status(404).json({ error: 'No such message' });
  const emoji = String(req.body.emoji || '');
  if (!REACTIONS.includes(emoji)) return res.status(400).json({ error: 'That reaction is not available' });
  const r = (f.msg.reactions = f.msg.reactions || {});
  const ids = (r[emoji] = r[emoji] || []);
  const i = ids.indexOf(req.user.id);
  if (i === -1 && ids.length === 0 && Object.keys(r).filter((k) => r[k].length).length >= 12) {
    delete r[emoji];
    return res.status(400).json({ error: 'Too many different reactions on one message' });
  }
  if (i >= 0) ids.splice(i, 1); else ids.push(req.user.id);
  if (!ids.length) delete r[emoji];
  save();
  broadcast({ t: 'reaction', id: f.msg.id, channelId: f.channelId, reactions: r });
  res.json({ ok: true });
});

app.patch('/api/messages/:id', auth, (req, res) => {
  const f = findMsg(req.params.id);
  if (!f) return res.status(404).json({ error: 'No such message' });
  if (f.msg.userId !== req.user.id || f.msg.announce || f.msg.system) return res.status(403).json({ error: 'You can only edit your own messages' });
  if (muteLeft(req.user)) return res.status(403).json({ error: `You are muted for another ${muteLeft(req.user)} min` });
  const content = String(req.body.content || '').slice(0, 2000);
  if (!content.trim()) return res.status(400).json({ error: 'A message cannot be empty' });
  f.msg.content = content;
  f.msg.edited = Date.now();
  save();
  broadcast({ t: 'edit', id: f.msg.id, channelId: f.channelId, content, edited: f.msg.edited });
  res.json({ ok: true });
});

app.patch('/api/me', auth, (req, res) => {
  if (typeof req.body.status === 'string') req.user.status = req.body.status.trim().slice(0, 60);
  if (req.body.avatar === null) req.user.avatar = null;
  else if (typeof req.body.avatar === 'string') {
    if (!/^\/uploads\/[a-f0-9]+\.(png|jpg|gif|webp)$/.test(req.body.avatar)) return res.status(400).json({ error: 'Invalid picture' });
    req.user.avatar = req.body.avatar;
  }
  save();
  broadcast({ t: 'members' });
  res.json({ ok: true });
});

app.get('/api/admin/overview', auth, (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Only the Owner and Admins can open the Command Center' });
  const now = Date.now(), HOUR = 3600000;
  const buckets = new Array(24).fill(0);
  const posters = {};
  let total = 0;
  const channels = db.channels.map((c) => {
    const list = db.messages[c.id] || [];
    total += list.length;
    for (const m of list) {
      if (!m.announce && !m.system) posters[m.userId] = (posters[m.userId] || 0) + 1;
      const age = now - m.ts;
      if (age >= 0 && age < 24 * HOUR) buckets[23 - Math.floor(age / HOUR)]++;
    }
    return { name: c.name, count: list.length };
  });
  const users = Object.values(db.users);
  res.json({
    now,
    members: users.length,
    online: online.size,
    newMembers7d: users.filter((u) => now - u.createdAt < 7 * 24 * HOUR).length,
    messages: total,
    messages24h: buckets.reduce((a, b) => a + b, 0),
    channels,
    roles: db.roles.slice().sort((a, b) => a.position - b.position).map((r) => ({ name: r.name, color: r.color, count: users.filter((u) => u.roleId === r.id).length })),
    buckets,
    topPosters: Object.entries(posters).map(([id, count]) => ({ username: db.users[id] && db.users[id].username, count })).filter((x) => x.username).sort((a, b) => b.count - a.count).slice(0, 5),
    onlineUsers: users.filter((u) => online.has(u.id)).map((u) => ({ username: u.username, roleId: u.roleId, avatar: u.avatar || null })),
    audit: db.audit.slice(-25).reverse(),
    uptimeMs: now - startedAt,
  });
});



/* ------------------------------------------------------------ owner panel */

const ownerOnly = (req, res, next) => (isOwner(req.user) ? next() : res.status(403).json({ error: 'Only the Owner can do that' }));

/* ---------------------------------------------------------- problem reports
   Reports are always saved in the Owner Panel. If mail settings are provided (SMTP_HOST, SMTP_USER, SMTP_PASS)
   they are also emailed to REPORT_EMAIL. */
const REPORT_EMAIL = process.env.REPORT_EMAIL || 'artem.yegorov@icloud.com';
const REPORT_KINDS = { bug: 'Something is broken', abuse: 'Report a person', idea: 'Idea or request', other: 'Something else' };
let mailer = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  try {
    mailer = require('nodemailer').createTransport({
      host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT) || 587, secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  } catch (e) { console.warn('Email is not set up:', e.message); }
}
const mailHint = 'Email is not set up on this server (SMTP_USER / SMTP_PASS are missing). Reports are still saved here.';
if (mailer) {
  mailer.verify().then(() => console.log('Email reports: ON, sending to ' + REPORT_EMAIL)).catch((e) => console.warn('Email reports: login FAILED (' + e.message + '). Check SMTP_USER and use an app-specific password for SMTP_PASS.'));
} else {
  console.log('Email reports: OFF (set SMTP_USER and SMTP_PASS to turn on). Reports are still saved in the Owner Panel.');
}
async function emailReport(r) {
  r.mailError = null;
  if (!mailer) { r.mailError = mailHint; return false; }
  try {
    await mailer.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER, to: REPORT_EMAIL,
      subject: `[${db.serverName}] ${REPORT_KINDS[r.kind]} from ${r.username}`,
      text: `${r.username} reported (${REPORT_KINDS[r.kind]}):\n\n${r.message}\n\nSent ${new Date(r.ts).toISOString()}`,
    });
    return true;
  } catch (e) { console.warn('Could not email report:', e.message); r.mailError = e.message; return false; }
}

app.post('/api/reports', auth, async (req, res) => {
  if (rateLimited('report:' + req.user.id, 5, 10 * 60_000)) return res.status(429).json({ error: 'You have sent a lot of reports. Please wait a few minutes.' });
  const kind = REPORT_KINDS[req.body.kind] ? req.body.kind : 'other';
  const message = String(req.body.message || '').trim().slice(0, 1500);
  if (message.length < 5) return res.status(400).json({ error: 'Please describe the problem (at least a few words)' });
  const r = { id: uid(6), userId: req.user.id, username: req.user.username, kind, message, ts: Date.now(), resolved: false, emailed: false };
  db.reports.push(r);
  if (db.reports.length > 500) db.reports.splice(0, db.reports.length - 500);
  save();
  r.emailed = await emailReport(r);
  save();
  res.json(isOwner(req.user) ? { ok: true, emailed: r.emailed, mailError: r.mailError } : { ok: true });
});

app.post('/api/owner/test-email', auth, ownerOnly, async (req, res) => {
  const r = { kind: 'other', username: req.user.username, message: 'This is a test email from your site. If you can read this, report emails work.', ts: Date.now() };
  const emailed = await emailReport(r);
  res.json({ emailed, to: REPORT_EMAIL, error: r.mailError });
});
app.get('/api/owner/reports', auth, ownerOnly, (req, res) => res.json(db.reports.slice().reverse()));
app.post('/api/owner/reports/:id/resolve', auth, ownerOnly, (req, res) => {
  const r = db.reports.find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'No such report' });
  r.resolved = !r.resolved; save(); res.json({ ok: true, resolved: r.resolved });
});
app.delete('/api/owner/reports/:id', auth, ownerOnly, (req, res) => {
  db.reports = db.reports.filter((x) => x.id !== req.params.id); save(); res.json({ ok: true });
});

app.get('/api/owner/overview', auth, ownerOnly, (req, res) => {
  const users = Object.values(db.users);
  res.json({
    registrationOpen: db.settings.registrationOpen,
    welcomeText: db.settings.welcomeText,
    admins: users.filter((u) => u.roleId === 'admin').map((u) => ({ id: u.id, username: u.username, online: online.has(u.id) })),
    members: users.length,
    sessions: Object.keys(db.sessions).length,
    audit: db.audit.slice(-40).reverse(),
  });
});

app.put('/api/owner/settings', auth, ownerOnly, (req, res) => {
  if (typeof req.body.registrationOpen === 'boolean') {
    db.settings.registrationOpen = req.body.registrationOpen;
    audit(req.user, req.body.registrationOpen ? 'opened sign-ups' : 'closed sign-ups');
  }
  if (typeof req.body.welcomeText === 'string') {
    const t = req.body.welcomeText.trim().slice(0, 120);
    db.settings.welcomeText = t || 'Welcome {name}!';
    audit(req.user, 'changed the welcome message');
  }
  save();
  res.json({ ok: true, settings: db.settings });
});

app.post('/api/owner/transfer', auth, ownerOnly, async (req, res) => {
  try {
    if (rateLimited('transfer:' + req.user.id, 5)) return res.status(429).json({ error: 'Too many attempts, wait a minute' });
    const target = db.users[req.body.userId];
    if (!target || target.id === req.user.id) return res.status(400).json({ error: 'Pick another member to hand ownership to' });
    const hash = await hashPassword(String(req.body.password || ''), req.user.salt);
    if (!safeEqual(hash, req.user.hash)) return res.status(403).json({ error: 'That password is not right' });
    if (!isOwner(req.user)) return res.status(403).json({ error: 'Only the Owner can do that' });
    target.roleId = 'owner';
    req.user.roleId = 'admin';
    audit(req.user, `handed ownership to ${target.username}`);
    save();
    broadcast({ t: 'members' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/owner/signout-all', auth, ownerOnly, (req, res) => {
  let n = 0;
  for (const [t, id] of Object.entries(db.sessions)) if (id !== req.user.id) { delete db.sessions[t]; n++; }
  for (const [ws, id] of sockets) if (id !== req.user.id) ws.close();
  audit(req.user, 'signed everyone else out');
  save();
  res.json({ ok: true, signedOut: n });
});

app.post('/api/owner/wipe-messages', auth, ownerOnly, (req, res) => {
  if (String(req.body.confirm || '') !== db.serverName) return res.status(400).json({ error: 'Type the server name exactly to confirm' });
  for (const c of db.channels) { db.messages[c.id] = []; broadcast({ t: 'purged', channelId: c.id }); }
  audit(req.user, 'wiped all messages');
  save();
  res.json({ ok: true });
});

/* ------------------------------------------------------------ staff tools */

app.put('/api/users/:id/mute', auth, need('manage_users'), (req, res) => {
  const t = db.users[req.params.id];
  if (!t) return res.status(404).json({ error: 'No such user' });
  if (t.id === req.user.id) return res.status(400).json({ error: 'You cannot mute yourself' });
  if (!outranks(req.user, t)) return res.status(403).json({ error: 'You can only mute people ranked below you' });
  const minutes = Math.floor(Number(req.body.minutes));
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > 10080) return res.status(400).json({ error: 'Choose between 0 and 10080 minutes' });
  t.mutedUntil = minutes ? Date.now() + minutes * 60000 : 0;
  audit(req.user, minutes ? `muted ${t.username} for ${minutes} min` : `unmuted ${t.username}`);
  save();
  broadcast({ t: 'members' });
  res.json({ ok: true, mutedUntil: t.mutedUntil });
});

app.get('/api/staff/overview', auth, (req, res) => {
  if (!hasAnyPerm(req.user)) return res.status(403).json({ error: 'The staff panel is for people with staff permissions' });
  const now = Date.now();
  const users = Object.values(db.users);
  res.json({
    members: users.length,
    online: online.size,
    muted: users.filter((u) => u.mutedUntil && u.mutedUntil > now).length,
    audit: db.audit.slice(-15).reverse(),
    perms: PERMS.filter((p) => can(req.user, p)),
  });
});

app.get('/api/staff/messages', auth, need('delete_messages'), (req, res) => {
  const ch = String(req.query.channel || 'all');
  const q = String(req.query.q || '').toLowerCase().slice(0, 100);
  const out = [];
  for (const c of db.channels) {
    if (ch !== 'all' && c.id !== ch) continue;
    for (const m of db.messages[c.id] || []) {
      const au = db.users[m.userId];
      if (q && !((m.content || '') + ' ' + (au ? au.username : '')).toLowerCase().includes(q)) continue;
      out.push({ id: m.id, channelId: c.id, channel: c.name, userId: m.userId, username: au ? au.username : 'Removed user', content: m.content || '', image: !!m.image, announce: !!m.announce, system: m.system || null, ts: m.ts });
    }
  }
  out.sort((a, b) => b.ts - a.ts);
  res.json(out.slice(0, 60));
});

/* --------------------------------------------------------- admin console */

const startedAt = Date.now();

// Splits a command into words; "double quotes" keep spaces together.
function tokenize(str) {
  const out = [];
  str.replace(/"([^"]*)"|(\S+)/g, (m, q, w) => out.push(q !== undefined ? q : w));
  return out;
}
const findUser = (name) => Object.values(db.users).find((u) => u.username.toLowerCase() === String(name).toLowerCase());
const findChannel = (name) => db.channels.find((c) => c.name === String(name).replace(/^#/, '').toLowerCase());
const findRole = (name) => db.roles.find((r) => r.name.toLowerCase() === String(name).toLowerCase() || r.id === name);

const HELP = [
  'Commands (use "quotes" around names that contain spaces):',
  '  announce <text>            send a message to every channel and a banner to everyone online',
  '  stats                      members, online now, channels, messages, uptime',
  '  who                        who is online right now',
  '  users                      every member and their role',
  '  channels                   every channel with its message count',
  '  role <user> <role>         change someone\'s role',
  '  kick <user>                remove a member (they can register again)',
  '  purge <channel> [count]    delete the last [count] messages, or all of them',
  '  rename <new server name>   rename the server',
];

app.post('/api/admin/command', auth, (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Only the Owner and Admins can use the admin console' });
  const raw = String(req.body.command || '').trim().replace(/^\//, '');
  if (!raw) return res.json({ output: [] });
  const [cmd, ...args] = tokenize(raw);
  const rest = raw.slice(cmd.length).trim();
  const AUDITED = ['announce', 'role', 'kick', 'purge', 'rename'];
  const done = (output, ok = true) => {
    if (ok && AUDITED.includes(cmd.toLowerCase())) audit(req.user, 'console: ' + raw.slice(0, 120));
    res.json({ output: [].concat(output), ok });
  };

  switch (cmd.toLowerCase()) {
    case 'help':
      return done(HELP);

    case 'announce': {
      const text = rest.slice(0, 500);
      if (!text) return done('Usage: announce <text>', false);
      for (const ch of db.channels) {
        const msg = { id: uid(8), channelId: ch.id, userId: req.user.id, content: text, image: null, ts: Date.now(), announce: true };
        db.messages[ch.id].push(msg);
        broadcast({ t: 'message', msg });
      }
      save();
      broadcast({ t: 'announce', text, by: req.user.username });
      return done(`Sent to ${db.channels.length} channels and ${online.size} people online.`);
    }

    case 'stats': {
      const total = Object.values(db.messages).reduce((n, l) => n + l.length, 0);
      const mins = Math.floor((Date.now() - startedAt) / 60000);
      return done([
        `members   ${Object.keys(db.users).length}`,
        `online    ${online.size}`,
        `channels  ${db.channels.length}`,
        `roles     ${db.roles.length}`,
        `messages  ${total}`,
        `uptime    ${Math.floor(mins / 60)}h ${mins % 60}m`,
      ]);
    }

    case 'who': {
      const names = Object.values(db.users).filter((u) => online.has(u.id)).map((u) => u.username);
      return done(names.length ? names : 'Nobody is online.');
    }

    case 'users':
      return done(Object.values(db.users).map((u) => `${u.username.padEnd(24)} ${roleOf(u).name}${online.has(u.id) ? '  (online)' : ''}`));

    case 'channels':
      return done(db.channels.map((c) => `#${c.name.padEnd(24)} ${db.messages[c.id].length} messages`));

    case 'role': {
      if (args.length < 2) return done('Usage: role <user> <role>', false);
      const target = findUser(args[0]);
      const role = findRole(args.slice(1).join(' '));
      if (!target) return done(`No member named "${args[0]}".`, false);
      if (!role) return done(`No role named "${args.slice(1).join(' ')}".`, false);
      const problem = roleChangeError(req.user, target, role);
      if (problem) return done(problem + '.', false);
      target.roleId = role.id;
      save();
      broadcast({ t: 'members' });
      return done(`${target.username} is now ${role.name}.`);
    }

    case 'kick': {
      if (!args[0]) return done('Usage: kick <user>', false);
      const target = findUser(args.join(' ')) || findUser(args[0]);
      if (!target) return done(`No member named "${args[0]}".`, false);
      if (target.id === req.user.id) return done('You cannot remove yourself.', false);
      if (!outranks(req.user, target)) return done('You can only remove people ranked below you.', false);
      delete db.users[target.id];
      for (const [t, id] of Object.entries(db.sessions)) if (id === target.id) delete db.sessions[t];
      disconnectUser(target.id);
      save();
      broadcast({ t: 'members' });
      return done(`${target.username} was removed.`);
    }

    case 'purge': {
      const ch = findChannel(args[0] || '');
      if (!ch) return done('Usage: purge <channel> [count]', false);
      const list = db.messages[ch.id];
      const n = args[1] ? Math.max(1, parseInt(args[1], 10) || 0) : list.length;
      const removed = Math.min(n, list.length);
      list.splice(list.length - removed, removed);
      save();
      broadcast({ t: 'purged', channelId: ch.id });
      return done(`Deleted ${removed} messages from #${ch.name}.`);
    }

    case 'rename': {
      const name = rest.replace(/^"(.*)"$/, '$1').trim().slice(0, 32);
      if (!name) return done('Usage: rename <new server name>', false);
      db.spaces[0].name = name;
      syncServerName();
      save();
      broadcast({ t: 'server' });
      return done(`Server renamed to ${name}.`);
    }

    default:
      return done(`Unknown command "${cmd}". Type help to see what is available.`, false);
  }
});

server.listen(PORT, () => console.log(`Chat running on http://localhost:${PORT}`));

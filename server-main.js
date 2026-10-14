'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const automod = require('./automod');
const store = require('./store');
const CHANGELOG = require('./changelog');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ---------------------------------------------------------------- storage */

const PERMS = ['manage_roles', 'manage_channels', 'manage_users', 'delete_messages'];

// New sites start invite only. (INVITE_ONLY=0 starts open, which the automated tests use.)
const INVITE_DEFAULT = process.env.INVITE_ONLY === '1'; // off by default; the Owner switches it in the Owner Panel

function freshDb() {
  return {
    users: {},
    sessions: {},
    serverName: 'Warms',
    settings: { registrationOpen: true, inviteOnly: INVITE_DEFAULT, welcomeText: 'Welcome {name}! \uD83D\uDC4B' },
    roles: [
      { id: 'owner', name: 'Owner', color: '#f5b83d', position: 0, perms: PERMS.slice() },
      { id: 'admin', name: 'Admin', color: '#f04747', position: 1, perms: PERMS.slice() },
      { id: 'community', name: 'Community Manager', color: '#e879f9', position: 2, perms: ['manage_channels', 'delete_messages', 'manage_users'] },
      { id: 'manager', name: 'Manager', color: '#43b581', position: 3, perms: ['manage_channels', 'delete_messages'] },
      { id: 'moderator', name: 'Moderator', color: '#3ba0e6', position: 4, perms: ['delete_messages', 'manage_users'] },
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
const STARTED_AT = Date.now();
try {
  db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
} catch (e) {
  if (fs.existsSync(DB_FILE) && fs.statSync(DB_FILE).size > 2) {
    // The file is there but unreadable. Never start empty on top of it: keep a copy, and with an external database refuse to start,
    // so a bad file can't overwrite the good copy in the database.
    try { fs.copyFileSync(DB_FILE, DB_FILE + '.broken-' + Date.now()); } catch {}
    if (store.enabled) { console.error('db.json could not be read (' + e.message + '). Not starting, so the external database is not overwritten.'); process.exit(1); }
  }
  db = freshDb();
}

const ANN = 'announcements';
const STAFF_HUB = 'staff';
const HUB_ROLES = ['admin', 'community', 'manager']; // the Owner can always get in
const SYSTEM_ROLES = ['owner', 'admin', 'community', 'member']; // cannot be deleted or moved
function migrate() {
db.settings = Object.assign({ registrationOpen: true, inviteOnly: INVITE_DEFAULT, welcomeText: 'Welcome {name}! \uD83D\uDC4B' }, db.settings || {});
db.settings.automod = Object.assign({ enabled: true, includeStaff: false, words: [] }, db.settings.automod || {});
db.events = Array.isArray(db.events) ? db.events : [];
db.dms = db.dms && typeof db.dms === 'object' ? db.dms : {};
// Update Log: entries shipped with the code are copied in once. The Owner can then edit or delete them.
db.updates = Array.isArray(db.updates) ? db.updates : [];
db.updatesGone = Array.isArray(db.updatesGone) ? db.updatesGone : [];
CHANGELOG.forEach((e, i) => {
  if (!db.updates.some((x) => x.id === e.id) && !db.updatesGone.includes(e.id)) db.updates.push({ id: e.id, seq: i + 1, date: e.date, title: e.title, notes: e.notes.slice() });
});
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
{
  let ann = db.channels.find((c) => c.global);
  if (!ann) ann = db.channels.find((c) => c.locked) || db.channels.find((c) => c.name === 'announcements' && c.spaceId === db.spaces[0].id);
  if (!ann) { ann = { id: 'ann' + Math.random().toString(36).slice(2, 8), name: 'announcements' }; db.channels.unshift(ann); }
  Object.assign(ann, { name: 'announcements', spaceId: ANN, locked: true, global: true });
  for (const c of db.channels.filter((x) => x.locked && x !== ann)) delete db.messages[c.id];
  db.channels = db.channels.filter((x) => !x.locked || x === ann);
  db.messages[ann.id] = db.messages[ann.id] || [];
}
  // Community Manager sits between Admin and Manager.
  if (!db.roles.some((r) => r.id === 'community')) {
    for (const r of db.roles) if (r.position >= 2 && r.position < 100) r.position += 1;
    db.roles.push({ id: 'community', name: 'Community Manager', color: '#e879f9', position: 2, perms: ['manage_channels', 'delete_messages', 'manage_users'] });
  }
  // The Staff Hub: a private space for staff. Which roles can enter is stored in space.roles.
  {
    let hub = db.spaces.find((x) => x.id === STAFF_HUB);
    if (!hub) { hub = { id: STAFF_HUB, name: 'Staff Hub' }; db.spaces.push(hub); }
    hub.system = true;
    if (!Array.isArray(hub.roles)) hub.roles = HUB_ROLES.slice();
    if (!db.channels.some((c) => c.spaceId === STAFF_HUB)) db.channels.push({ id: 'staff-chat', name: 'staff-chat', spaceId: STAFF_HUB });
    for (const c of db.channels.filter((x) => x.spaceId === STAFF_HUB)) db.messages[c.id] = db.messages[c.id] || [];
  }
  db.minigame = db.minigame && typeof db.minigame === 'object' ? db.minigame : null;
db.show = db.show && typeof db.show === 'object' ? db.show : null;
db.lastShow = db.lastShow && typeof db.lastShow === 'object' ? db.lastShow : null;
db.showAdmins = db.showAdmins === true;
  if (!db.codes || typeof db.codes !== 'object' || Array.isArray(db.codes)) db.codes = {};
  if (!Array.isArray(db.ipBans)) db.ipBans = [];
  if (!Array.isArray(db.polls)) db.polls = [];
if (!Array.isArray(db.webgames)) db.webgames = [];
{ // every account gets a short account number
  const used = new Set(Object.values(db.users).map((x) => x.acct).filter(Boolean));
  for (const x of Object.values(db.users)) if (!x.acct) { let n; do { n = 10000 + crypto.randomInt(0, 90000); } while (used.has(n)); used.add(n); x.acct = n; }
}
if (!db.webgamesSeeded) { // a few starter games (free open-source games hosted on GitHub Pages); the Owner can remove any of them
  db.webgamesSeeded = true;
  if (!db.webgames.length) db.webgames.push(
    { id: 'wg2048', name: '2048', icon: '🔢', url: 'https://gabrielecirulli.github.io/2048/' },
    { id: 'wghex', name: 'Hextris', icon: '⬡', url: 'https://hextris.github.io/hextris/' },
    { id: 'wgtetris', name: 'Tetris', icon: '🧱', url: 'https://chvin.github.io/react-tetris/' },
    { id: 'wgbird', name: 'Clumsy Bird', icon: '🐦', url: 'https://ellisonleao.github.io/clumsy-bird/' });
}
if (db.countdown === undefined) db.countdown = null;
  if (!db.invites || typeof db.invites !== 'object' || Array.isArray(db.invites)) db.invites = {};
  if (typeof db.settings.inviteOnly !== 'boolean') db.settings.inviteOnly = INVITE_DEFAULT;
  if (!db.settings.inviteReset) { db.settings.inviteOnly = INVITE_DEFAULT; db.settings.inviteReset = true; } // one-time: invites start switched off after this update
  for (const u of Object.values(db.users)) if (u.rulesAgreed === undefined) u.rulesAgreed = 0; // existing members were here before the rules agreement
  syncServerName();
}
const spaceById = (id) => db.spaces.find((x) => x.id === id);
const syncServerName = () => { db.serverName = db.spaces[0].name; };
migrate();
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
    const json = JSON.stringify(db);
    fs.writeFile(tmp, json, (err) => {
      if (!err) fs.rename(tmp, DB_FILE, () => {});
    });
    store.mirrorDb(json);
  }, 150);
}
save();

function newAcct() { const used = new Set(Object.values(db.users).map((x) => x.acct)); let n; do { n = 10000 + crypto.randomInt(0, 90000); } while (used.has(n)); return n; }
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
  return { id: u.id, username: u.username, roleId: u.roleId, createdAt: u.createdAt, online: online.has(u.id), status: u.status || '', avatar: u.avatar || null, mutedUntil: u.mutedUntil && u.mutedUntil > Date.now() ? u.mutedUntil : 0, fx: fxOf(u), tag: u.tag && (u.tags || []).some((t) => (OLD_TAG_IDS[t] || t) === (OLD_TAG_IDS[u.tag] || u.tag)) ? (OLD_TAG_IDS[u.tag] || u.tag) : null };
}

/* ------------------------------------------------------------------ IP bans
   The Owner can ban a person's IP address(es). Anyone visiting from a banned address only sees a
   "this site has been deleted" page. (Shared networks and VPNs mean an IP is not a perfect identity.) */

function clientIp(req) {
  const xf = String((req.headers && req.headers['x-forwarded-for']) || '').split(',').map((x) => x.trim()).filter(Boolean);
  return String(xf.length ? xf[xf.length - 1] : (req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '').slice(0, 64);
}
const ipBanned = (ip) => !!ip && Array.isArray(db.ipBans) && db.ipBans.some((b) => b.ip === ip);
const DELETED_TEXT = 'This site has been deleted.';
const DELETED_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Site deleted</title><style>html,body{height:100%;margin:0}body{display:grid;place-content:center;gap:10px;text-align:center;background:#fff;color:#222;font:18px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;padding:24px}h1{font-size:28px;margin:0}p{margin:0;color:#666}</style></head><body><h1>This site has been deleted.</h1></body></html>`;
// Remember the addresses a person uses (a few, newest last) so the Owner can ban them.
function noteIp(user, ip) {
  if (!user || !ip) return;
  if (!Array.isArray(user.ips)) user.ips = [];
  if (user.ips[user.ips.length - 1] === ip) return;
  user.ips = user.ips.filter((x) => x !== ip).concat(ip).slice(-6);
  save();
}

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const userId = db.sessions[token];
  const user = userId && db.users[userId];
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  noteIp(user, clientIp(req));
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

// Who may see a space: everyone, unless the Owner limited it to some roles (the Owner always can).
const spaceAllowed = (u, sp) => !sp || !Array.isArray(sp.roles) || isOwner(u) || sp.roles.includes(u.roleId);
const chanAllowed = (u, channelId) => { const c = db.channels.find((x) => x.id === channelId); return !c || spaceAllowed(u, spaceById(c.spaceId)); };
// Sends only to people who are allowed to see that chat.
function broadcastChannel(channelId, payload) {
  const data = JSON.stringify(payload);
  for (const [ws, id] of sockets) if (ws.readyState === 1 && db.users[id] && chanAllowed(db.users[id], channelId)) ws.send(data);
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws' || ipBanned(clientIp(req))) return socket.destroy();
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
      if (m && typeof m.t === 'string' && (m.t.startsWith('voice-') || m.t === 'call-decline')) handleVoice(ws, userId, m);
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
const voiceChannels = () => db.spaces.flatMap((sp) => (sp.id === STAFF_HUB
  ? [{ id: sp.id + ':lounge', spaceId: sp.id, name: 'Staff Voice' }, { id: sp.id + ':hangout', spaceId: sp.id, name: 'Staff Hangout' }]
  : [{ id: sp.id + ':lounge', spaceId: sp.id, name: 'Lounge' }, { id: sp.id + ':hangout', spaceId: sp.id, name: 'Hangout' }]));
const voiceChannelsFor = (u) => voiceChannels().filter((v) => spaceAllowed(u, spaceById(v.spaceId)));
const VOICE_MAX = 8;
const voice = new Map(); // userId -> { room, ws, muted, deaf }
function voiceSnapshot(u) {
  const out = {};
  for (const c of u ? voiceChannelsFor(u) : voiceChannels()) out[c.id] = [];
  for (const [id, v] of voice) {
    if (!db.users[id]) continue;
    if (v.room.startsWith('dm:') && u && v.room.split(':').includes(u.id)) (out[v.room] ||= []); // private calls show only to the two people in them
    if (out[v.room]) out[v.room].push({ userId: id, muted: v.muted, deaf: v.deaf, sharing: !!v.sharing });
  }
  return out;
}
function voiceBroadcast() {
  for (const [ws, id] of sockets) if (ws.readyState === 1 && db.users[id]) ws.send(JSON.stringify({ t: 'voice', voice: voiceSnapshot(db.users[id]) }));
}
// After a role or access change, drop people from voice rooms they may no longer enter.
function enforceVoiceAccess() {
  for (const [id, v] of [...voice]) {
    const u = db.users[id];
    if (v.room.startsWith('dm:') || (u && spaceAllowed(u, spaceById(v.room.split(':')[0])))) continue;
    try { v.ws.send(JSON.stringify({ t: 'voice-error', error: 'You no longer have access to that voice channel' })); } catch (e) { /* gone */ }
    voiceLeave(id);
  }
}
function voiceLeave(userId, ws) {
  const v = voice.get(userId);
  if (v && ringing.has(v.room) && ringing.get(v.room).from === userId) endRing(v.room, false); // hung up before they picked up
  if (!v || (ws && v.ws !== ws)) return;
  voice.delete(userId);
  for (const [w, id] of sockets) if (id !== userId && voice.get(id) && voice.get(id).room === v.room && w.readyState === 1) w.send(JSON.stringify({ t: 'voice-left', userId }));
  voiceBroadcast();
}
/* Private calls: ringing */
const dmRoom = (a, b) => 'dm:' + [a, b].sort().join(':');
const ringing = new Map(); // room -> { room, from, to, timer }
function endRing(room, answered) {
  const r = ringing.get(room);
  if (!r) return;
  clearTimeout(r.timer); ringing.delete(room);
  if (answered) sendTo(r.to, { t: 'call-cancel', room, answered: true });
  else sendTo(r.to, { t: 'call-cancel', room });
}
function startRing(room, from, to, video) {
  endRing(room, false);
  const timer = setTimeout(() => {
    if (!ringing.has(room)) return;
    ringing.delete(room);
    sendTo(to.id, { t: 'call-cancel', room });
    sendTo(from.id, { t: 'call-missed', to: to.username });
    voiceLeave(from.id);
  }, 45000);
  ringing.set(room, { room, from: from.id, to: to.id, timer });
  sendTo(to.id, { t: 'call-ring', room, from: from.id, name: from.username, video: !!video });
}
function handleVoice(ws, userId, m) {
  const user = db.users[userId];
  const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
  if (!user) return;
  if (m.t === 'voice-join' && String(m.room).startsWith('dm:')) {
    // A private call between two friends. The caller rings the other person.
    const ids = String(m.room).split(':').slice(1), other = db.users[ids.find((x) => x !== userId)];
    if (ids.length !== 2 || !ids.includes(userId) || ids[0] === ids[1] || !other || m.room !== dmRoom(ids[0], ids[1])) return send({ t: 'voice-error', error: 'No such call' });
    if (!areFriends(user, other)) return send({ t: 'voice-error', error: 'You can only call your friends' });
    if (user.mutedUntil && user.mutedUntil > Date.now()) return send({ t: 'voice-error', error: 'You are muted right now' });
    const here = [...voice].filter(([id, v]) => v.room === m.room && id !== userId);
    voiceLeave(userId);
    voice.set(userId, { room: m.room, ws, muted: false, deaf: false });
    send({ t: 'voice-joined', room: m.room, peers: here.map(([id]) => id) });
    if (here.length) endRing(m.room, true);
    else if (online.has(other.id)) startRing(m.room, user, other, m.video === true);
    else { send({ t: 'call-missed', to: other.username, offline: true }); voiceLeave(userId); return; }
    voiceBroadcast();
  } else if (m.t === 'call-decline') {
    const r = ringing.get(String(m.room));
    if (!r || r.to !== userId) return;
    endRing(r.room, false);
    sendTo(r.from, { t: 'call-declined', by: user.username });
    voiceLeave(r.from);
  } else if (m.t === 'voice-join') {
    const room = voiceChannels().find((c) => c.id === m.room);
    if (!room) return send({ t: 'voice-error', error: 'No such voice channel' });
    if (!spaceAllowed(user, spaceById(room.spaceId))) return send({ t: 'voice-error', error: 'That voice channel is private' });
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
    if (typeof m.sharing === 'boolean' && m.sharing !== !!v.sharing) {
      if (m.sharing) {
        const other = [...voice].find(([id, x]) => id !== userId && x.room === v.room && x.sharing);
        if (other) { send({ t: 'voice-share-denied', by: other[0] }); return voiceBroadcast(); }
      }
      v.sharing = m.sharing;
    }
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
// Banned addresses see a "deleted" page everywhere and cannot use the API.
app.use((req, res, next) => {
  if (!ipBanned(clientIp(req))) return next();
  if (req.path.startsWith('/api/')) return res.status(403).json({ error: DELETED_TEXT });
  res.status(410).set('Content-Type', 'text/html; charset=utf-8').send(DELETED_PAGE);
});
// Hosts put a proxy in front of the app; trust it so rate limits see each visitor's real IP.
app.set('trust proxy', 1);
app.use(express.json({ limit: '8mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d', index: false }));
// If a picture is missing from the disk but is in the external database, bring it back right now.
app.get('/uploads/:name', async (req, res) => {
  const name = String(req.params.name || '');
  const buf = await store.getFile(name);
  if (!buf) return res.status(404).end();
  try { fs.writeFileSync(path.join(UPLOAD_DIR, name), buf); } catch (e) { /* serve it anyway */ }
  const ext = name.split('.').pop();
  res.type({ png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[ext] || 'application/octet-stream').set('Cache-Control', 'public, max-age=3600').send(buf);
});
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------------------------------------------ invites (the site is invite only)
   New people need a code from the Owner to sign up. Each invite has a use limit and can expire. */
const normInvite = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 24);
const inviteDead = (i) => (i.expiresAt && Date.now() >= i.expiresAt) || i.uses >= i.maxUses;
const inviteView = (i) => ({ code: i.code, maxUses: i.maxUses, uses: i.uses, usedBy: i.usedBy, expiresAt: i.expiresAt, note: i.note || '', createdAt: i.createdAt, by: i.by });
const inviteList = () => Object.values(db.invites).sort((a, b) => b.createdAt - a.createdAt).map(inviteView);

const USERNAME_RE = /^[A-Za-z0-9_.\- ]{2,24}$/;

app.get('/api/status', (req, res) => {
  res.json({ hasUsers: Object.keys(db.users).length > 0, serverName: db.serverName, registrationOpen: db.settings.registrationOpen, inviteOnly: !!db.settings.inviteOnly });
});

const RULES_VERSION = 1;
const RULES = [
  { title: 'Respect & Behavior', items: [
    ['No Racism, Slurs, or Hate Speech', 'Racism, slurs, and bypassing filters (including variations of the N-word) are strictly prohibited.'],
    ['No Harassment or Doxxing', 'Do not dox or leak private personal information about anyone or it will result in a permanent ban.'],
    ['No Trolling or Disruptive Behavior', 'Avoid too much trolling or acting unnecessarily weird/disruptive in chat.'] ] },
  { title: 'Content & Profiles', items: [
    ['No NSFW', 'Keep all content SFW. Some curse words are allowed, but keep it moderate.'],
    ['Appropriate Profiles', 'No weird, inappropriate, or offensive profile pictures (PFPs) or display names.'] ] },
  { title: 'Requesting & Economy', items: [
    ['No Currency Spam', 'Avoid asking or begging for coins constantly, or you will get timed out for a little bit.'],
    ['No Begging for Permissions', "Do not ask or beg staff for staff roles, admin permissions, or special perks. It's annoying."] ] },
];
app.get('/api/rules', (req, res) => res.json({ version: RULES_VERSION, title: 'Server Rules', sections: RULES }));

app.post('/api/register', async (req, res) => {
  try {
    if (rateLimited('reg:' + req.ip, 10)) return res.status(429).json({ error: 'Too many attempts, wait a minute' });
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'Username must be 2-24 characters (letters, numbers, space, _ . -)' });
    if (password.length < 6 || password.length > 200) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    if (req.body.agreeRules !== true) return res.status(400).json({ error: 'You need to agree to the Server Rules to join' });
    const lower = username.toLowerCase();
    const isWarmaster = lower === 'warmaster'; // signing up with this name makes you the Owner
    if (!db.settings.registrationOpen && !isWarmaster && Object.keys(db.users).length > 0) return res.status(403).json({ error: 'Sign-ups are closed right now. Ask the Owner for access.' });
    const invite = db.settings.inviteOnly && !isWarmaster ? db.invites[normInvite(req.body.inviteCode)] : null;
    if (db.settings.inviteOnly && !isWarmaster) {
      if (!normInvite(req.body.inviteCode)) return res.status(403).json({ error: 'This site is invite only. Ask the Owner for an invite link or code.' });
      if (!invite || inviteDead(invite)) return res.status(403).json({ error: 'That invite code does not work (it may be wrong, used up or expired).' });
    }
    if (Object.values(db.users).some((u) => u.username.toLowerCase() === lower)) return res.status(409).json({ error: 'That username is taken' });

    const salt = uid(16);
    const hash = await hashPassword(password, salt);

    // Re-check after the async hash so two simultaneous sign-ups can never both become admin.
    if (Object.values(db.users).some((u) => u.username.toLowerCase() === lower)) return res.status(409).json({ error: 'That username is taken' });
    if (invite && inviteDead(invite)) return res.status(403).json({ error: 'That invite code was just used up.' });
    const first = isWarmaster;
    const user = {
      id: uid(6), username, salt, hash,
      roleId: first ? 'owner' : 'member',
      createdAt: Date.now(),
      announced: false,
      rulesAgreed: RULES_VERSION, rulesAgreedAt: Date.now(),
      toured: false,
      acct: newAcct(),
    };
    db.users[user.id] = user;
    if (invite) { invite.uses++; invite.usedBy.push(user.username); user.invitedBy = invite.by; }
    const token = uid(32);
    db.sessions[token] = user.id; noteIp(user, clientIp(req));
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
    db.sessions[token] = user.id; noteIp(user, clientIp(req));
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
    channels: db.channels.filter((c) => chanAllowed(req.user, c.id)),
    spaces: db.spaces.filter((sp) => spaceAllowed(req.user, sp)).map((sp) => (isOwner(req.user) ? sp : (({ roles, ...rest }) => rest)(sp))),
    annIcon: db.settings.annIcon || null,
    voiceChannels: voiceChannelsFor(req.user),
    voice: voiceSnapshot(req.user),
    perks: { troll: canTroll(req.user), community: isCommunity(req.user) },
    perms: PERMS,
    economy: { ...economyFor(req.user), ...economyInfo() },
    tour: req.user.toured === false && process.env.TOUR !== '0', // (TOUR=0 is only for automated tests)
    countdown: countdownView(),
  });
});

/* --------------------------------------------------- coins, wheel, tags */
// Play money only: coins have no real-world value and cannot be bought.

const SPIN_COOLDOWN = 24 * 60 * 60 * 1000;
const MACHINE_COST = 100;
const WHEEL = [ // value + weight per segment (weights add to 100)
  { coins: 25, w: 15 }, { coins: 50, w: 15 }, { coins: 25, w: 15 }, { coins: 75, w: 10 }, { coins: 50, w: 15 },
  { coins: 100, w: 12 }, { coins: 150, w: 5 }, { coins: 75, w: 10 }, { coins: 250, w: 2.5 }, { coins: 500, w: 0.5 },
];
const RARITIES = [ // chance of each rarity per roll (adds to 100), and coins back for a duplicate
  { id: 'common', label: 'Common', chance: 59.9, refund: 20 },
  { id: 'uncommon', label: 'Uncommon', chance: 25, refund: 35 },
  { id: 'rare', label: 'Rare', chance: 10, refund: 60 },
  { id: 'epic', label: 'Epic', chance: 4, refund: 120 },
  { id: 'legendary', label: 'Legendary', chance: 1, refund: 250 },
  { id: 'croma', label: 'Croma', chance: 0.1, refund: 1000 },
];
// The Halloween pack and decorations leave the shop at midnight (Pacific) on November 1st, 2026.
const HALLOWEEN_END = Date.UTC(2026, 10, 1, 7, 0, 0);
const packClosed = (p) => !!p.until && Date.now() >= p.until;
// Tag packs. Each pack lists its tags as [id, name, icon] for every rarity, in this order:
// 4 common, 3 uncommon, 3 rare, 2 epic, 2 legendary, 1 croma.
const PACKS = [
  { id: 'halloween', name: 'Halloween', icon: '🎃', blurb: 'Ghosts, bats and pumpkins', until: HALLOWEEN_END, tags: [
    ['ghost', 'Little Ghost', '👻'], ['candy-corn', 'Candy Corn', '🍬'], ['cobweb', 'Cobweb', '🕸️'], ['pumpkin-spice', 'Pumpkin Spice', '🥧'],
    ['black-cat', 'Black Cat', '🐈‍⬛'], ['bat-wing', 'Bat Wing', '🦇'], ['trick-or-treat', 'Trick or Treat', '🍭'],
    ['witch-brew', "Witch's Brew", '🧪'], ['haunted', 'Haunted', '🏚️'], ['skeleton-crew', 'Skeleton Crew', '💀'],
    ['jack-o-lantern', "Jack-o'-Lantern", '🎃'], ['vampire-kiss', "Vampire's Kiss", '🧛'],
    ['headless-horseman', 'Headless Horseman', '🐴'], ['midnight-reaper', 'Midnight Reaper', '☠️'],
    ['prismatic-pumpkin', 'Prismatic Pumpkin', '🌈'] ] },
  { id: 'dogs', name: 'Dog Pack', icon: '🐶', blurb: 'Good boys and girls', tags: [
    ['puppy', 'Puppy', '🐶'], ['tennis-ball', 'Tennis Ball', '🎾'], ['bone', 'Bone', '🦴'], ['zoomies', 'Zoomies', '💨'],
    ['good-boy', 'Good Boy', '🐕'], ['poodle', 'Fancy Poodle', '🐩'], ['mail-chaser', 'Mail Chaser', '📬'],
    ['husky-howl', 'Husky Howl', '🐺'], ['guide-dog', 'Guide Dog', '🦮'], ['sniffer', 'Super Sniffer', '👃'],
    ['k9-unit', 'K9 Unit', '🚓'], ['rescue-hero', 'Rescue Hero', '🚑'],
    ['cerberus', 'Cerberus', '🔥'], ['hot-dog-king', 'Hot Dog King', '🌭'],
    ['rainbow-doge', 'Rainbow Doge', '🌈'] ] },
  { id: 'space', name: 'Space Pack', icon: '🚀', blurb: 'Stars, planets and aliens', tags: [
    ['stardust', 'Stardust', '✨'], ['moon-dust', 'Moon Dust', '🌙'], ['comet-tail', 'Comet Tail', '☄️'], ['space-cadet', 'Space Cadet', '🧑‍🚀'],
    ['satellite', 'Satellite', '🛰️'], ['alien-pal', 'Alien Pal', '👽'], ['rocket-fuel', 'Rocket Fuel', '🚀'],
    ['ringed-planet', 'Ringed Planet', '🪐'], ['black-hole', 'Black Hole', '🕳️'], ['telescope-eye', 'Telescope Eye', '🔭'],
    ['supernova', 'Supernova', '💥'], ['mars-colonist', 'Mars Colonist', '🔴'],
    ['galaxy-brain', 'Galaxy Brain', '🌌'], ['event-horizon', 'Event Horizon', '🌀'],
    ['nebula-walker', 'Nebula Walker', '🌈'] ] },
  { id: 'ocean', name: 'Ocean Pack', icon: '🌊', blurb: 'Deep sea treasures', tags: [
    ['seashell', 'Seashell', '🐚'], ['tide-pool', 'Tide Pool', '🌊'], ['crab-walk', 'Crab Walk', '🦀'], ['sea-breeze', 'Sea Breeze', '🍃'],
    ['dolphin-pal', 'Dolphin Pal', '🐬'], ['old-sailor', 'Old Sailor', '⚓'], ['reef-fish', 'Reef Fish', '🐠'],
    ['pearl-diver', 'Pearl Diver', '🦪'], ['octopus-ink', 'Octopus Ink', '🐙'], ['shark-fin', 'Shark Fin', '🦈'],
    ['kraken', 'Kraken', '🦑'], ['mermaid-song', 'Mermaid Song', '🧜'],
    ['leviathan', 'Leviathan', '🐋'], ['atlantis', 'Atlantis', '🔱'],
    ['aurora-reef', 'Aurora Reef', '🌈'] ] },
  { id: 'food', name: 'Food Pack', icon: '🍕', blurb: 'Snacks, sweets and feasts', tags: [
    ['toast', 'Buttered Toast', '🍞'], ['fries', 'Fry Cook', '🍟'], ['donut', 'Donut Hole', '🍩'], ['popcorn', 'Movie Night', '🍿'],
    ['pizza-slice', 'Pizza Slice', '🍕'], ['taco-tuesday', 'Taco Tuesday', '🌮'], ['sushi-roll', 'Sushi Roll', '🍣'],
    ['ramen-bowl', 'Ramen Bowl', '🍜'], ['burger-boss', 'Burger Boss', '🍔'], ['cake-slice', 'Cake Walk', '🍰'],
    ['chef-kiss', "Chef's Kiss", '👨‍🍳'], ['hot-pepper', 'Hot Pepper', '🌶️'],
    ['golden-fries', 'Golden Fries', '🍟'], ['feast-lord', 'Feast Lord', '🍗'],
    ['rainbow-sundae', 'Rainbow Sundae', '🍨'] ] },
  { id: 'fantasy', name: 'Fantasy Pack', icon: '🐉', blurb: 'Dragons, wizards and magic', tags: [
    ['wooden-sword', 'Wooden Sword', '🗡️'], ['potion', 'Mystery Potion', '🧪'], ['scroll', 'Old Scroll', '📜'], ['torchlight', 'Torchlight', '🔦'],
    ['elf-archer', 'Elf Archer', '🏹'], ['dwarf-forge', 'Dwarf Forge', '⚒️'], ['unicorn', 'Unicorn', '🦄'],
    ['wizard-hat', 'Wizard Hat', '🧙'], ['castle-keep', 'Castle Keep', '🏰'], ['fairy-ring', 'Fairy Ring', '🧚'],
    ['dragon-egg', 'Dragon Egg', '🥚'], ['crystal-ball', 'Crystal Ball', '🔮'],
    ['elder-dragon', 'Elder Dragon', '🐉'], ['crown-of-kings', 'Crown of Kings', '👑'],
    ['prism-phoenix', 'Prismatic Phoenix', '🌈'] ] },
  { id: 'music', name: 'Music Pack', icon: '🎸', blurb: 'Beats, bands and encores', tags: [
    ['humming', 'Humming', '🎵'], ['headphones', 'Headphones On', '🎧'], ['tambourine', 'Tambourine', '🪘'], ['karaoke', 'Karaoke Night', '🎤'],
    ['guitar-solo', 'Guitar Solo', '🎸'], ['piano-keys', 'Piano Keys', '🎹'], ['drum-roll', 'Drum Roll', '🥁'],
    ['dj-booth', 'DJ Booth', '🎛️'], ['saxophone', 'Smooth Sax', '🎷'], ['violin', 'Violin Virtuoso', '🎻'],
    ['platinum-record', 'Platinum Record', '💿'], ['encore', 'Encore!', '👏'],
    ['stadium-tour', 'Stadium Tour', '🏟️'], ['golden-mic', 'Golden Mic', '🎙️'],
    ['rainbow-remix', 'Rainbow Remix', '🌈'] ] },
  { id: 'robots', name: 'Robot Pack', icon: '🤖', blurb: 'Gadgets, circuits and AI', tags: [
    ['battery', 'Low Battery', '🔋'], ['gear', 'Spare Gear', '⚙️'], ['plug-in', 'Plugged In', '🔌'], ['bleep', 'Bleep Bloop', '📟'],
    ['drone', 'Little Drone', '🚁'], ['hacker-cat', 'Hacker Cat', '💻'], ['laser-eye', 'Laser Eye', '📡'],
    ['mecha-arm', 'Mecha Arm', '🦾'], ['android', 'Android', '🤖'], ['circuit-board', 'Circuit Board', '🧠'],
    ['quantum-core', 'Quantum Core', '⚛️'], ['mainframe', 'Mainframe', '🖥️'],
    ['singularity', 'Singularity', '♾️'], ['overclocked', 'Overclocked', '⚡'],
    ['rgb-rig', 'RGB Rig', '🌈'] ] },
  { id: 'effects', name: 'Profile Effects', icon: '✨', blurb: 'Sparkle rings, glowing names and profile backgrounds', tags: [
    ['ring-glow', 'Soft Glow', '💡', 'ring'], ['name-warm', 'Warm Glow', '🔆', 'name'], ['bg-dusk', 'Dusk Sky', '🌆', 'bg'], ['ring-dots', 'Dotted Ring', '⚪', 'ring'],
    ['ring-sparkle', 'Sparkle Ring', '✨', 'ring'], ['name-neon', 'Neon Name', '🟦', 'name'], ['bg-aurora', 'Aurora', '🌌', 'bg'],
    ['ring-rainbow', 'Rainbow Ring', '🌈', 'ring'], ['name-fire', 'Fire Name', '🔥', 'name'], ['bg-stars', 'Starfield', '⭐', 'bg'],
    ['ring-galaxy', 'Galaxy Ring', '🪐', 'ring'], ['name-glitch', 'Glitch Name', '👾', 'name'],
    ['name-gold', 'Gold Shimmer', '👑', 'name'], ['bg-lava', 'Lava Flow', '🌋', 'bg'],
    ['bg-slash', 'Crimson Slash', '🗡️', 'bg'] ] },
  { id: 'event', name: 'Limited Event Tags', icon: '🏅', blurb: 'Only from live shows. Not in the shop', noShop: true, tags: [
    ['show-live', 'Neon Overdrive', '⚡', null, 'legendary'], ['show-halloween', 'Blood Moon Rave', '🌕', null, 'legendary'],
    ['bg-overdrive', 'Overdrive Grid', '🌐', 'bg', 'legendary'], ['bg-bloodmoon', 'Crimson Eclipse', '🩸', 'bg', 'legendary'] ] },
];
const SLOTS = ['common', 'common', 'common', 'common', 'uncommon', 'uncommon', 'uncommon', 'rare', 'rare', 'rare', 'epic', 'epic', 'legendary', 'legendary', 'croma'];
const TAGS = PACKS.flatMap((p) => p.tags.map(([id, name, icon, kind, rar], i) => { const t = { id, name, icon, rarity: rar || SLOTS[i], pack: p.id }; if (kind) t.kind = kind; if (p.noShop) t.limited = true; return t; }));
// Old tag ids from the first version are renamed so nobody loses what they already own.
const OLD_TAG_IDS = { newbie: 'ghost', chill: 'candy-corn', lurker: 'cobweb', snacky: 'pumpkin-spice', 'night-owl': 'black-cat', gamer: 'bat-wing', 'meme-lord': 'trick-or-treat', vibes: 'witch-brew', 'big-brain': 'haunted', speedrunner: 'skeleton-crew', 'cozy-fire': 'jack-o-lantern', sunburst: 'vampire-kiss', 'warm-legend': 'headless-horseman', 'golden-goat': 'midnight-reaper' };
// Each limited show tag comes with its own animated profile background.
const EVENT_FX = { 'show-live': 'bg-overdrive', 'show-halloween': 'bg-bloodmoon' };
const tagById = (id) => TAGS.find((t) => t.id === id);
const rarityOf = (id) => RARITIES.find((r) => r.id === id);

function pickWeighted(list, weight) {
  const total = list.reduce((n, x) => n + weight(x), 0);
  let r = crypto.randomInt(0, 1e9) / 1e9 * total;
  for (const x of list) { r -= weight(x); if (r < 0) return x; }
  return list[list.length - 1];
}

/* Events the Owner starts for everyone. Timed ones live in db.events; instant ones just happen. */
const EVENT_TYPES = {
  luck: { icon: '🍀', name: 'Lucky Hour', timed: true },
  double: { icon: '🎡', name: 'Double Coins', timed: true },
  sale: { icon: '🏷️', name: 'Pack Sale', timed: true },
  gift: { icon: '🎁', name: 'Coin Rain', timed: false },
  freespin: { icon: '🔄', name: 'Free Spin For All', timed: false },
  rush: { icon: '⚡', name: 'Spin Rush', timed: true },
  refund: { icon: '♻️', name: 'Duplicate Bonus', timed: true },
  treat: { icon: '🍬', name: 'Trick or Treat', timed: false },
  freepack: { icon: '📦', name: 'Free Pack For All', timed: false },
  jackpot: { icon: '💎', name: 'Jackpot Draw', timed: false },
};
const spinCooldown = () => (activeEvents().some((e) => e.type === 'rush') ? 60 * 60 * 1000 : SPIN_COOLDOWN);
function activeEvents() {
  const now = Date.now();
  if (!Array.isArray(db.events)) db.events = [];
  if (db.events.some((e) => e.until <= now)) db.events = db.events.filter((e) => e.until > now);
  return db.events;
}
const eventMult = (type) => activeEvents().filter((e) => e.type === type).reduce((m, e) => Math.max(m, e.mult || 1), 1);
const currentCost = () => {
  const off = activeEvents().filter((e) => e.type === 'sale').reduce((m, e) => Math.max(m, e.percent || 0), 0);
  return Math.max(1, Math.round(MACHINE_COST * (1 - off / 100)));
};
const luckyChance = (r, luck) => (r.id === 'common' ? r.chance : r.chance * luck);

// The profile effects a person wears (ring, name, background). Only things they actually own count.
function fxOf(u) {
  const out = {}, f = (u && u.fx) || {};
  for (const k of ['ring', 'name', 'bg']) { const t = f[k] && tagById(f[k]); if (t && t.kind === k && (u.tags || []).includes(t.id)) out[k] = t.id; }
  return out;
}
function econ(u) {
  if (Array.isArray(u.tags) && u.tags.some((t) => OLD_TAG_IDS[t])) u.tags = [...new Set(u.tags.map((t) => OLD_TAG_IDS[t] || t))];
  if (OLD_TAG_IDS[u.tag]) u.tag = OLD_TAG_IDS[u.tag];
  if (typeof u.coins !== 'number') u.coins = 0;
  if (!Array.isArray(u.tags)) u.tags = [];
  return u;
}
function economyFor(u) {
  econ(u);
  return {
    coins: u.coins,
    nextSpinAt: u.lastSpin ? u.lastSpin + spinCooldown() : 0,
    freeRolls: u.freeRolls || 0,
    equippedFx: fxOf(u),
    owned: u.tags,
    equipped: u.tag || null,
    now: Date.now(),
    cost: currentCost(),
    baseCost: MACHINE_COST,
    events: activeEvents().map((e) => ({ id: e.id, type: e.type, icon: EVENT_TYPES[e.type].icon, name: EVENT_TYPES[e.type].name, mult: e.mult || 0, percent: e.percent || 0, until: e.until })),
  };
}
const economyInfo = () => ({
  wheel: WHEEL.map((s) => s.coins),
  rarities: RARITIES,
  packs: PACKS.map((p) => ({ id: p.id, name: p.name, icon: p.icon, blurb: p.blurb, until: p.until || 0, closed: packClosed(p), noShop: !!p.noShop })),
  halloweenEnd: HALLOWEEN_END,
  tags: TAGS,
});

app.get('/api/economy', auth, (req, res) => res.json({ ...economyFor(req.user), ...economyInfo() }));

app.post('/api/wheel/spin', auth, (req, res) => {
  const u = econ(req.user);
  if (u.lastSpin && Date.now() - u.lastSpin < spinCooldown()) return res.status(429).json({ error: 'Come back later for your next spin', ...economyFor(u) });
  const seg = pickWeighted(WHEEL.map((s, i) => ({ ...s, i })), (s) => s.w);
  const won = seg.coins * eventMult('double');
  u.coins += won;
  u.lastSpin = Date.now();
  questBump(u, 'spin');
  save();
  res.json({ index: seg.i, base: seg.coins, won, ...economyFor(u) });
});

app.post('/api/machine/roll', auth, (req, res) => {
  const u = econ(req.user);
  if (rateLimited('roll:' + u.id, 20, 60000)) return res.status(429).json({ error: 'Slow down a little' });
  const pack = PACKS.find((p) => p.id === String(req.body.pack || 'dogs'));
  if (!pack) return res.status(400).json({ error: 'Pick a pack first' });
  if (pack.noShop) return res.status(400).json({ error: 'Those tags are only given out at live shows' });
  if (packClosed(pack)) return res.status(400).json({ error: `The ${pack.name} left the shop. It was only here for Halloween` });
  const cost = currentCost();
  const free = (u.freeRolls || 0) > 0;
  if (!free && u.coins < cost) return res.status(400).json({ error: `You need ${cost} coins to open a pack` });
  if (free) u.freeRolls--; else u.coins -= cost;
  const luck = eventMult('luck');
  const rarity = pickWeighted(RARITIES, (r) => luckyChance(r, luck));
  const pool = TAGS.filter((t) => t.pack === pack.id && t.rarity === rarity.id);
  const tag = pool[crypto.randomInt(0, pool.length)];
  const duplicate = u.tags.includes(tag.id);
  const refund = rarity.refund * eventMult('refund');
  if (duplicate) u.coins += refund; else u.tags.push(tag.id);
  save();
  res.json({ tag, duplicate, refund: duplicate ? refund : 0, ...economyFor(u) });
});

app.post('/api/tags/equip', auth, (req, res) => {
  const u = econ(req.user);
  const id = req.body.tag ? String(req.body.tag) : null;
  const kind = ['ring', 'name', 'bg'].includes(req.body.kind) ? req.body.kind : null;
  if (id && !u.tags.includes(id)) return res.status(400).json({ error: 'You do not own that yet' });
  const def = id && tagById(id);
  if (def && def.kind) { u.fx = Object.assign({}, u.fx || {}, { [def.kind]: id }); }   // a profile effect
  else if (!id && kind) { u.fx = Object.assign({}, u.fx || {}); delete u.fx[kind]; }  // take one off
  else u.tag = id;
  save();
  broadcast({ t: 'members' });
  res.json(economyFor(u));
});

/* ---------------------------------------------------------------- AutoMod */

const isStaffUser = (u) => isAdmin(u);
function automodMuted(u) { return u.mutedUntil && u.mutedUntil > Date.now(); }

// Returns true (after answering the request) when the text broke a rule. The message is NOT posted.
// AutoMod stays out of private places: direct messages, and chats inside a space the Owner limited to some roles (like the Staff Hub).
function inPrivateSpace(channelId) {
  const ch = db.channels.find((c) => c.id === channelId), sp = ch && spaceById(ch.spaceId || db.spaces[0].id);
  return !!(sp && (sp.system || (Array.isArray(sp.roles) && sp.roles.length)));
}
function automodGate(req, res, text, where) {
  if (where && inPrivateSpace(where)) return false;
  const cfg = db.settings.automod;
  const u = req.user;
  if (!cfg.enabled || (isStaffUser(u) && !cfg.includeStaff)) return false;
  const hit = automod.check(u.id, text, cfg.words);
  if (!hit) return false;
  // offences fade after a week of good behaviour
  if (u.lastOffense && Date.now() - u.lastOffense > 7 * 24 * 3600 * 1000) u.offenses = 0;
  u.offenses = (u.offenses || 0) + 1;
  u.lastOffense = Date.now();
  const minutes = automod.muteMinutesFor(u.offenses);
  u.mutedUntil = Date.now() + minutes * 60000;
  const label = minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} hour${minutes === 60 ? '' : 's'}` : `${minutes} minutes`;
  audit({ username: 'AutoMod' }, `muted ${u.username} for ${label} (${hit.detail}, offence #${u.offenses})`);
  if (where && db.messages[where]) {
    const sys = { id: uid(8), channelId: where, userId: u.id, content: `🤖 AutoMod muted ${u.username} for ${label} (${hit.detail}).`, image: null, ts: Date.now(), system: true, bot: true };
    db.messages[where].push(sys);
    broadcastChannel(where, { t: 'message', msg: sys });
  }
  save();
  broadcast({ t: 'members' });
  res.status(403).json({ error: `AutoMod blocked that message (${hit.detail}). You are muted for ${label}.`, automod: true, minutes });
  return true;
}

/* ------------------------------------------------------- friends and DMs */

function sendTo(userId, payload) {
  const data = JSON.stringify(payload);
  for (const [ws, id] of sockets) if (id === userId && ws.readyState === 1) ws.send(data);
}
const social = (u) => {
  for (const k of ['friends', 'reqIn', 'reqOut']) if (!Array.isArray(u[k])) u[k] = [];
  if (!u.dmRead || typeof u.dmRead !== 'object') u.dmRead = {};
  for (const k of ['friends', 'reqIn', 'reqOut']) u[k] = u[k].filter((id) => db.users[id]);
  return u;
};
const dmKey = (a, b) => [a, b].sort().join(':');
const dmList = (a, b) => (db.dms[dmKey(a, b)] ||= []);
const areFriends = (a, b) => social(a).friends.includes(b.id);
const pull = (arr, id) => { const i = arr.indexOf(id); if (i >= 0) arr.splice(i, 1); };

function friendsView(u) {
  social(u);
  const unread = {};
  for (const id of u.friends) {
    const since = u.dmRead[id] || 0;
    const n = dmList(u.id, id).filter((m) => m.from === id && m.ts > since).length;
    if (n) unread[id] = n;
  }
  const last = {};
  for (const id of u.friends) {
    const l = dmList(u.id, id), m = l[l.length - 1];
    if (m) last[id] = { from: m.from, text: m.content || (m.image ? '📷 Photo' : ''), ts: m.ts };
  }
  return { friends: u.friends, incoming: u.reqIn, outgoing: u.reqOut, unread, last };
}

app.get('/api/friends', auth, (req, res) => res.json(friendsView(req.user)));

app.post('/api/friends/request', auth, (req, res) => {
  const me = social(req.user), other = db.users[String(req.body.userId || '')];
  if (!other) return res.status(404).json({ error: 'No such person' });
  if (other.id === me.id) return res.status(400).json({ error: 'You cannot friend yourself' });
  social(other);
  if (me.friends.includes(other.id)) return res.status(400).json({ error: `You and ${other.username} are already friends` });
  if (rateLimited('freq:' + me.id, 30, 60000)) return res.status(429).json({ error: 'Slow down a little' });
  let accepted = false;
  if (me.reqIn.includes(other.id)) { // they already asked you: that makes you friends
    pull(me.reqIn, other.id); pull(other.reqOut, me.id);
    me.friends.push(other.id); other.friends.push(me.id);
    accepted = true;
  } else if (!me.reqOut.includes(other.id)) {
    me.reqOut.push(other.id); other.reqIn.push(me.id);
  }
  save();
  sendTo(other.id, { t: 'friends', from: me.username, kind: accepted ? 'accepted' : 'request' });
  res.json({ ok: true, accepted, ...friendsView(me) });
});

app.post('/api/friends/accept', auth, (req, res) => {
  const me = social(req.user), other = db.users[String(req.body.userId || '')];
  if (!other || !me.reqIn.includes(other.id)) return res.status(404).json({ error: 'That request is gone' });
  social(other);
  pull(me.reqIn, other.id); pull(other.reqOut, me.id);
  me.friends.push(other.id); other.friends.push(me.id);
  save();
  sendTo(other.id, { t: 'friends', from: me.username, kind: 'accepted' });
  res.json({ ok: true, ...friendsView(me) });
});

app.post('/api/friends/decline', auth, (req, res) => { // decline an incoming request, or cancel one you sent
  const me = social(req.user), other = db.users[String(req.body.userId || '')];
  if (other) { social(other); pull(me.reqIn, other.id); pull(me.reqOut, other.id); pull(other.reqIn, me.id); pull(other.reqOut, me.id); sendTo(other.id, { t: 'friends', kind: 'update' }); }
  save();
  res.json({ ok: true, ...friendsView(me) });
});

app.delete('/api/friends/:id', auth, (req, res) => {
  const me = social(req.user), other = db.users[req.params.id];
  pull(me.friends, req.params.id);
  if (other) { social(other); pull(other.friends, me.id); sendTo(other.id, { t: 'friends', kind: 'update' }); }
  save();
  res.json({ ok: true, ...friendsView(me) });
});

app.get('/api/dm/:id', auth, (req, res) => {
  const me = social(req.user), other = db.users[req.params.id];
  if (!other || !areFriends(me, other)) return res.status(403).json({ error: 'You can only message friends' });
  const list = dmList(me.id, other.id);
  me.dmRead[other.id] = Date.now();
  save();
  res.json(list.slice(-200));
});

app.post('/api/dm/:id/read', auth, (req, res) => {
  const me = social(req.user);
  me.dmRead[req.params.id] = Date.now();
  save();
  res.json({ ok: true });
});

app.post('/api/dm/:id', auth, (req, res) => {
  const me = social(req.user), other = db.users[req.params.id];
  if (!other || !areFriends(me, other)) return res.status(403).json({ error: 'You can only message friends' });
  const left = muteLeft(me);
  if (left) return res.status(403).json({ error: `You are muted for another ${left} min` });
  if (rateLimited('dm:' + me.id, 40, 60000)) return res.status(429).json({ error: 'Slow down a little' });
  const content = String(req.body.content || '').slice(0, 2000);
  const image = typeof req.body.image === 'string' && /^\/uploads\/[a-f0-9]+\.(png|jpg|gif|webp)$/.test(req.body.image) ? req.body.image : null;
  if (!content.trim() && !image) return res.status(400).json({ error: 'Empty message' });
  // Private messages between friends are not moderated: AutoMod never checks or mutes in DMs.
  const msg = { id: uid(8), from: me.id, to: other.id, content, ts: Date.now() };
  if (image) msg.image = image;
  const list = dmList(me.id, other.id);
  list.push(msg);
  if (list.length > 2000) list.splice(0, list.length - 2000);
  me.dmRead[other.id] = Date.now();
  if (other.id !== me.id && (content.trim().length >= 3 || image)) questChat(req.user, 'dm');
  save();
  sendTo(me.id, { t: 'dm', msg });
  if (other.id !== me.id) sendTo(other.id, { t: 'dm', msg });
  res.json(msg);
});

app.post('/api/dm/:id/typing', auth, (req, res) => {
  const me = social(req.user), other = db.users[req.params.id];
  if (other && areFriends(me, other) && !rateLimited('dmt:' + me.id, 30, 10000)) sendTo(other.id, { t: 'dm-typing', from: me.id });
  res.json({ ok: true });
});

// You can delete your own direct messages.
app.delete('/api/dm/:id/:msgId', auth, (req, res) => {
  const me = social(req.user), other = db.users[req.params.id];
  if (!other) return res.status(404).json({ error: 'No such person' });
  const list = dmList(me.id, other.id), i = list.findIndex((m) => m.id === req.params.msgId);
  if (i < 0) return res.status(404).json({ error: 'That message is gone' });
  if (list[i].from !== me.id) return res.status(403).json({ error: 'You can only delete your own messages' });
  list.splice(i, 1);
  save();
  const payload = { t: 'dm-del', id: req.params.msgId, a: me.id, b: other.id };
  sendTo(me.id, payload);
  if (other.id !== me.id) sendTo(other.id, payload);
  res.json({ ok: true });
});

// Owner and Admins can hand out (or take back) tags: one tag, or a whole pack.
app.post('/api/users/:id/tags', auth, (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Only the Owner and Admins can give tags' });
  const target = db.users[req.params.id];
  if (!target) return res.status(404).json({ error: 'No such person' });
  econ(target);
  const take = req.body.action === 'take';
  const list = req.body.pack ? TAGS.filter((t) => t.pack === String(req.body.pack)) : TAGS.filter((t) => t.id === String(req.body.tag || ''));
  if (!list.length) return res.status(400).json({ error: 'Pick a tag or a pack first' });
  if (list.some((t) => t.limited) && !isOwner(req.user)) return res.status(403).json({ error: 'Only the Owner can give or take the limited event tags' });
  const changed = [];
  for (const t of list) {
    const has = target.tags.includes(t.id);
    if (take && has) { target.tags = target.tags.filter((x) => x !== t.id); if (target.tag === t.id) target.tag = null; if (t.kind && target.fx && target.fx[t.kind] === t.id) delete target.fx[t.kind]; changed.push(t); }
    else if (!take && !has) { target.tags.push(t.id); changed.push(t); }
    // a show tag and its profile animation go together
    const fxId = EVENT_FX[t.id], ft = fxId && tagById(fxId);
    if (ft && !list.includes(ft)) {
      if (take && target.tags.includes(ft.id)) { target.tags = target.tags.filter((x) => x !== ft.id); if (target.fx && target.fx.bg === ft.id) delete target.fx.bg; }
      else if (!take && !target.tags.includes(ft.id)) target.tags.push(ft.id);
    }
  }
  if (changed.length) audit(req.user, `${take ? 'took' : 'gave'} ${changed.length > 3 ? changed.length + ' tags' : changed.map((t) => t.name).join(', ')} ${take ? 'from' : 'to'} ${target.username}`);
  save();
  broadcast({ t: 'members' });
  res.json({ ok: true, changed: changed.map((t) => t.name), skipped: list.length - changed.length, username: target.username });
});

/* ------------------------------------------------------------ update log */
const updatesView = () => db.updates.slice().sort((a, b) => b.seq - a.seq);
function cleanUpdate(body) {
  const title = String(body.title || '').trim().slice(0, 80);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || '')) ? String(body.date) : new Date().toISOString().slice(0, 10);
  const notes = (Array.isArray(body.notes) ? body.notes : String(body.notes || '').split('\n')).map((n) => String(n).trim().slice(0, 240)).filter(Boolean).slice(0, 20);
  return title ? { title, date, notes } : null;
}
app.get('/api/updates', auth, (req, res) => res.json(updatesView()));
app.post('/api/owner/updates', auth, (q, r, n) => ownerOnly(q, r, n), (req, res) => {
  const c = cleanUpdate(req.body);
  if (!c) return res.status(400).json({ error: 'Give the entry a title' });
  const seq = db.updates.reduce((m, x) => Math.max(m, x.seq), 0) + 1;
  db.updates.push({ id: 'u' + uid(5), seq, ...c });
  audit(req.user, 'added an Update Log entry: ' + c.title);
  save();
  broadcast({ t: 'updates' });
  res.json(updatesView());
});
app.put('/api/owner/updates/:id', auth, (q, r, n) => ownerOnly(q, r, n), (req, res) => {
  const e = db.updates.find((x) => x.id === req.params.id);
  const c = cleanUpdate(req.body);
  if (!e) return res.status(404).json({ error: 'No such entry' });
  if (!c) return res.status(400).json({ error: 'Give the entry a title' });
  Object.assign(e, c);
  audit(req.user, 'edited an Update Log entry: ' + c.title);
  save();
  broadcast({ t: 'updates' });
  res.json(updatesView());
});
app.delete('/api/owner/updates/:id', auth, (q, r, n) => ownerOnly(q, r, n), (req, res) => {
  const e = db.updates.find((x) => x.id === req.params.id);
  if (!e) return res.status(404).json({ error: 'No such entry' });
  db.updates = db.updates.filter((x) => x !== e);
  if (CHANGELOG.some((x) => x.id === e.id)) db.updatesGone.push(e.id); // keep shipped entries from coming back
  audit(req.user, 'deleted an Update Log entry: ' + e.title);
  save();
  broadcast({ t: 'updates' });
  res.json(updatesView());
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
  store.mirrorFile(name, buf);
  res.json({ url: '/uploads/' + name });
});

const noAccess = (res) => res.status(403).json({ error: 'You do not have access to that chat' });
app.get('/api/channels/:id/messages', auth, (req, res) => {
  const list = db.messages[req.params.id];
  if (!list) return res.status(404).json({ error: 'No such channel' });
  if (!chanAllowed(req.user, req.params.id)) return noAccess(res);
  res.json(list.slice(-100));
});

app.post('/api/channels/:id/messages', auth, (req, res) => {
  const list = db.messages[req.params.id];
  if (!list) return res.status(404).json({ error: 'No such channel' });
  if (!chanAllowed(req.user, req.params.id)) return noAccess(res);
  const chan = db.channels.find((c) => c.id === req.params.id);
  if (chan && chan.locked && !isOwner(req.user)) return res.status(403).json({ error: 'Only the Owner can post in #announcements' });
  const left = muteLeft(req.user);
  if (left) return res.status(403).json({ error: `You are muted for another ${left} min` });
  const content = String(req.body.content || '').slice(0, 2000);
  if (content && automodGate(req, res, content, chan && !chan.locked ? req.params.id : null)) return;
  const image = typeof req.body.image === 'string' && /^\/uploads\/[a-f0-9]+\.(png|jpg|gif|webp)$/.test(req.body.image) ? req.body.image : null;
  if (!content.trim() && !image) return res.status(400).json({ error: 'Empty message' });
  const replyTo = typeof req.body.replyTo === 'string' && list.some((m) => m.id === req.body.replyTo) ? req.body.replyTo : null;
  const msg = { id: uid(8), channelId: req.params.id, userId: req.user.id, content, image, ts: Date.now(), replyTo, reactions: {} };
  list.push(msg);
  if (list.length > 5000) list.splice(0, list.length - 5000);
  if (content.trim().length >= 3 || image) questChat(req.user, 'chat');
  save();
  broadcastChannel(req.params.id, { t: 'message', msg });
  res.json(msg);
});

app.delete('/api/messages/:id', auth, (req, res) => {
  for (const [channelId, list] of Object.entries(db.messages)) {
    const i = list.findIndex((m) => m.id === req.params.id);
    if (i === -1) continue;
    if (!chanAllowed(req.user, channelId)) return noAccess(res);
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
    broadcastChannel(channelId, { t: 'delete', id: msg.id, channelId });
    return res.json({ ok: true });
  }
  res.status(404).json({ error: 'No such message' });
});

app.post('/api/typing', auth, (req, res) => {
  if (db.messages[req.body.channelId] && chanAllowed(req.user, req.body.channelId)) broadcastChannel(req.body.channelId, { t: 'typing', channelId: req.body.channelId, userId: req.user.id });
  res.json({ ok: true });
});

/* -------------------------------------------------------------- channels */

app.post('/api/channels', auth, need('manage_channels'), (req, res) => {
  const name = String(req.body.name || '').toLowerCase().trim().replace(/[^a-z0-9\-_ ]/g, '').replace(/\s+/g, '-').slice(0, 32);
  if (!name) return res.status(400).json({ error: 'Channel name required' });
  const spaceId = req.body.spaceId ? String(req.body.spaceId) : db.spaces[0].id;
  if (!spaceById(spaceId)) return res.status(404).json({ error: 'No such space' });
  if (!spaceAllowed(req.user, spaceById(spaceId))) return noAccess(res);
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
  if (!chanAllowed(req.user, db.channels[i].id)) return noAccess(res);
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
  if (!role || SYSTEM_ROLES.includes(role.id)) return res.status(400).json({ error: 'That role cannot be moved' });
  if (!canEditRole(req.user, role)) return res.status(403).json({ error: 'You can only move roles below your own' });
  const movable = db.roles.filter((r) => !SYSTEM_ROLES.includes(r.id)).sort((a, b) => a.position - b.position);
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
  if (SYSTEM_ROLES.includes(role.id)) return res.status(400).json({ error: 'That role cannot be deleted' });
  if (!canEditRole(req.user, role)) return res.status(403).json({ error: 'You can only delete roles below your own' });
  audit(req.user, `deleted the ${role.name} role`);
  db.roles = db.roles.filter((r) => r.id !== role.id);
  for (const u of Object.values(db.users)) if (u.roleId === role.id) u.roleId = 'member';
  for (const sp of db.spaces) if (Array.isArray(sp.roles)) sp.roles = sp.roles.filter((x) => x !== role.id);
  enforceVoiceAccess();
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
  enforceVoiceAccess();
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
  if (!spaceAllowed(req.user, sp)) return noAccess(res);
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
  if (Array.isArray(req.body.roles) && req.body.roles.length) {
    if (!isOwner(req.user)) return res.status(403).json({ error: 'Only the Owner can limit a space to certain roles' });
    sp.roles = [...new Set(req.body.roles.map(String).filter((id) => id !== 'owner' && roleById(id)))];
  }
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
    if (!spaceAllowed(req.user, sp)) return noAccess(res);
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
  if (sp.system) return res.status(400).json({ error: 'The Staff Hub cannot be deleted' });
  if (!spaceAllowed(req.user, sp)) return noAccess(res);
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
  if (!chanAllowed(req.user, f.channelId)) return noAccess(res);
  const emoji = String(req.body.emoji || '');
  if (!REACTIONS.includes(emoji)) return res.status(400).json({ error: 'That reaction is not available' });
  const r = (f.msg.reactions = f.msg.reactions || {});
  const ids = (r[emoji] = r[emoji] || []);
  const i = ids.indexOf(req.user.id);
  if (i === -1 && ids.length === 0 && Object.keys(r).filter((k) => r[k].length).length >= 12) {
    delete r[emoji];
    return res.status(400).json({ error: 'Too many different reactions on one message' });
  }
  if (i >= 0) ids.splice(i, 1); else { ids.push(req.user.id); if (f.msg.userId !== req.user.id) questBump(req.user, 'react'); }
  if (!ids.length) delete r[emoji];
  save();
  broadcastChannel(f.channelId, { t: 'reaction', id: f.msg.id, channelId: f.channelId, reactions: r });
  res.json({ ok: true });
});

app.patch('/api/messages/:id', auth, (req, res) => {
  const f = findMsg(req.params.id);
  if (!f) return res.status(404).json({ error: 'No such message' });
  if (!chanAllowed(req.user, f.channelId)) return noAccess(res);
  if (f.msg.userId !== req.user.id || f.msg.announce || f.msg.system) return res.status(403).json({ error: 'You can only edit your own messages' });
  if (muteLeft(req.user)) return res.status(403).json({ error: `You are muted for another ${muteLeft(req.user)} min` });
  const content = String(req.body.content || '').slice(0, 2000);
  if (!content.trim()) return res.status(400).json({ error: 'A message cannot be empty' });
  if (automodGate(req, res, content, f.channelId)) return;
  f.msg.content = content;
  f.msg.edited = Date.now();
  save();
  broadcastChannel(f.channelId, { t: 'edit', id: f.msg.id, channelId: f.channelId, content, edited: f.msg.edited });
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
// Read the mail settings (trimmed, so a stray space or newline from copy and paste doesn't break them).
const envTrim = (k) => String(process.env[k] || '').trim();
const smtpUser = envTrim('SMTP_USER'), smtpPass = envTrim('SMTP_PASS');
const smtpHost = envTrim('SMTP_HOST') || (smtpUser && smtpPass ? 'smtp.mail.me.com' : '');
const smtpMissing = [['SMTP_USER', smtpUser], ['SMTP_PASS', smtpPass]].filter(([, v]) => !v).map(([k]) => k);
const mailHint = smtpMissing.length
  ? 'Email is not set up on this server: ' + smtpMissing.join(' and ') + ' ' + (smtpMissing.length > 1 ? 'are' : 'is') + ' missing or empty. Reports are still saved here.'
  : 'Email is not set up on this server.';
if (!smtpMissing.length) {
  try {
    mailer = require('nodemailer').createTransport({
      host: smtpHost, port: Number(envTrim('SMTP_PORT')) || 587, secure: Number(envTrim('SMTP_PORT')) === 465,
      auth: { user: smtpUser, pass: smtpPass },
    });
  } catch (e) { console.warn('Email is not set up:', e.message); }
}
if (mailer) {
  mailer.verify().then(() => console.log('Email reports: ON, sending to ' + REPORT_EMAIL)).catch((e) => console.warn('Email reports: login FAILED (' + e.message + '). Check SMTP_USER and use an app-specific password for SMTP_PASS.'));
} else {
  const seen = Object.keys(process.env).filter((k) => /smtp|mail|report/i.test(k)).sort();
  console.log('Email reports: OFF. ' + mailHint + ' Mail-related variables this server can see (names only): ' + (seen.length ? seen.join(', ') : 'none') + '.');
}
async function emailReport(r) {
  r.mailError = null;
  if (!mailer) { r.mailError = mailHint; return false; }
  try {
    await mailer.sendMail({
      from: envTrim('SMTP_FROM') || smtpUser, to: REPORT_EMAIL,
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

app.get('/api/owner/invites', auth, ownerOnly, (req, res) => res.json({ invites: inviteList(), inviteOnly: !!db.settings.inviteOnly }));
app.post('/api/owner/invites', auth, ownerOnly, (req, res) => {
  const code = crypto.randomBytes(5).toString('hex').toUpperCase();
  const mins = clampNum(req.body.expiresIn, 0, 60 * 24 * 365, 0);
  db.invites[code] = { code, maxUses: clampNum(req.body.maxUses, 1, 1000, 1), uses: 0, usedBy: [], expiresAt: mins ? Date.now() + mins * 60000 : 0, note: String(req.body.note || '').trim().slice(0, 40), createdAt: Date.now(), by: req.user.username };
  audit(req.user, `made invite ${code}${db.invites[code].note ? ' for ' + db.invites[code].note : ''}`);
  save();
  res.json({ ok: true, code, invites: inviteList() });
});
app.delete('/api/owner/invites/:code', auth, ownerOnly, (req, res) => {
  const code = normInvite(req.params.code);
  if (!db.invites[code]) return res.status(404).json({ error: 'No such invite' });
  delete db.invites[code]; audit(req.user, 'deleted invite ' + code); save();
  res.json({ ok: true, invites: inviteList() });
});

app.get('/api/owner/overview', auth, ownerOnly, (req, res) => {
  const users = Object.values(db.users);
  res.json({
    registrationOpen: db.settings.registrationOpen,
    inviteOnly: !!db.settings.inviteOnly,
    welcomeText: db.settings.welcomeText,
    admins: users.filter((u) => u.roleId === 'admin').map((u) => ({ id: u.id, username: u.username, online: online.has(u.id) })),
    members: users.length,
    troll: users.filter((u) => u.troll).map((u) => u.id),
    coins: Object.fromEntries(users.map((u) => [u.id, Math.max(0, Math.trunc(Number(u.coins) || 0))])),
    sessions: Object.keys(db.sessions).length,
    audit: db.audit.slice(-40).reverse(),
    storage: storageInfo(),
  });
});

app.put('/api/owner/settings', auth, ownerOnly, (req, res) => {
  if (typeof req.body.registrationOpen === 'boolean') {
    db.settings.registrationOpen = req.body.registrationOpen;
    audit(req.user, req.body.registrationOpen ? 'opened sign-ups' : 'closed sign-ups');
  }
  if (typeof req.body.inviteOnly === 'boolean') {
    db.settings.inviteOnly = req.body.inviteOnly;
    audit(req.user, req.body.inviteOnly ? 'turned invite-only on' : 'turned invite-only off');
  }
  if (typeof req.body.welcomeText === 'string') {
    const t = req.body.welcomeText.trim().slice(0, 120);
    db.settings.welcomeText = t || 'Welcome {name}!';
    audit(req.user, 'changed the welcome message');
  }
  save();
  res.json({ ok: true, settings: db.settings });
});

app.post('/api/owner/give-coins', auth, ownerOnly, (req, res) => {
  const target = db.users[String(req.body.userId || '')];
  const amount = Math.trunc(Number(req.body.amount));
  if (!target) return res.status(404).json({ error: 'Pick a member first' });
  if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 1e6) return res.status(400).json({ error: 'Enter an amount between 1 and 1,000,000 (use a minus to take coins away)' });
  econ(target);
  target.coins = Math.max(0, Math.min(1e9, target.coins + amount));
  audit(req.user, `${amount > 0 ? 'gave' : 'took'} ${Math.abs(amount)} coins ${amount > 0 ? 'to' : 'from'} ${target.username}`);
  save();
  broadcast({ t: 'members' });
  res.json({ ok: true, coins: target.coins, username: target.username });
});

app.get('/api/ping', (req, res) => res.json({ ok: true }));

// Is the data folder on a real disk that survives updates? (A mounted disk lives on a different device than the app's own files.)
function storageInfo() {
  let persistent = true; // on your own computer ./data stays put
  if (process.env.RENDER) {
    try { persistent = fs.statSync(DATA_DIR).dev !== fs.statSync(__dirname).dev; } catch { persistent = false; }
  }
  if (store.enabled) persistent = true;
  return { persistent, dir: DATA_DIR, onRender: !!process.env.RENDER, database: store.enabled, startedAt: STARTED_AT };
}

app.get('/api/owner/backup', auth, ownerOnly, (req, res) => {
  res.setHeader('Content-Disposition', `attachment; filename="warms-backup-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({ warmsBackup: 1, savedAt: Date.now(), db: { ...db, sessions: {} } });
});

app.post('/api/owner/restore', auth, ownerOnly, (req, res) => {
  const b = req.body && req.body.warmsBackup === 1 ? req.body.db : null;
  if (!b || typeof b.users !== 'object' || !Array.isArray(b.channels) || typeof b.messages !== 'object' || !Array.isArray(b.roles)) return res.status(400).json({ error: 'That is not a Warms backup file' });
  if (!Object.values(b.users).some((u) => u.roleId === 'owner')) return res.status(400).json({ error: 'The backup has no Owner account, so restoring it would lock you out' });
  const keep = { ...b, sessions: {}, reports: b.reports || [] };
  const mine = Object.values(keep.users).find((u) => u.username.toLowerCase() === req.user.username.toLowerCase());
  db = Object.assign(freshDb(), keep);
  if (mine) db.sessions[req.token] = mine.id; // keep you signed in if your account is in the backup
  migrate();
  save();
  for (const ws of sockets.keys()) ws.close();
  res.json({ ok: true, users: Object.keys(db.users).length });
});

/* Owner events: Lucky Hour, Double Coins, Pack Sale (timed) and Coin Rain, Free Spin For All (instant). */
const generalChannel = () => db.channels.find((c) => c.id === 'general') || db.channels.find((c) => c.spaceId === db.spaces[0].id && !c.locked) || db.channels.find((c) => !c.locked);
// Announcements only ever land in the main #general chat (message + pop-up there), never in every chat.
function tellEveryone(by, text) {
  const ch = generalChannel();
  if (!ch) return;
  const msg = { id: uid(8), channelId: ch.id, userId: by.id, content: text, image: null, ts: Date.now(), announce: true };
  db.messages[ch.id].push(msg);
  broadcastChannel(ch.id, { t: 'message', msg });
  broadcast({ t: 'announce', text, by: by.username, channelId: ch.id });
}
const fmtMin = (m) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ' ' + (m % 60) + 'm' : ''}` : `${m} min`);

const clampNum = (v, lo, hi, d) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
// Starts an event and tells everyone. Returns the announcement text, or null for an unknown type.
function startEvent(by, type, body) {
  const def = EVENT_TYPES[type];
  if (!def) return null;
  const num = clampNum;
  let text;
  if (def.timed) {
    const minutes = num(body.minutes, 1, 1440, 30);
    const ev = { id: uid(6), type, until: Date.now() + minutes * 60000, by: by.username };
    if (type === 'luck') { ev.mult = num(body.mult, 2, 10, 3); text = `${def.icon} ${def.name}! Rare tag chances are x${ev.mult} for ${fmtMin(minutes)}. Open packs in the Shop now!`; }
    if (type === 'double') { ev.mult = num(body.mult, 2, 5, 2); text = `${def.icon} ${def.name}! The Daily Wheel pays x${ev.mult} for ${fmtMin(minutes)}.`; }
    if (type === 'sale') { ev.percent = num(body.percent, 10, 90, 50); text = `${def.icon} ${def.name}! Tag packs are ${ev.percent}% off for ${fmtMin(minutes)}.`; }
    if (type === 'rush') text = `${def.icon} ${def.name}! The Daily Wheel can be spun once an hour for ${fmtMin(minutes)}. Go spin!`;
    if (type === 'refund') { ev.mult = num(body.mult, 2, 5, 2); text = `${def.icon} ${def.name}! Duplicate tags pay back x${ev.mult} coins for ${fmtMin(minutes)}.`; }
    activeEvents().push(ev);
  } else if (type === 'treat') {
    for (const u of Object.values(db.users)) { econ(u); u.coins = Math.min(1e9, u.coins + 25 + crypto.randomInt(0, 376)); }
    text = `${def.icon} ${def.name}! Everyone just got a random treat of 25 to 400 coins. Check your coins!`;
  } else if (type === 'freepack') {
    const open = PACKS.filter((p) => !packClosed(p) && !p.noShop), luck = eventMult('luck');
    for (const u of Object.values(db.users)) {
      econ(u);
      const pack = open[crypto.randomInt(0, open.length)];
      const rarity = pickWeighted(RARITIES, (r) => luckyChance(r, luck));
      const pool = TAGS.filter((t) => t.pack === pack.id && t.rarity === rarity.id);
      const tag = pool[crypto.randomInt(0, pool.length)];
      if (u.tags.includes(tag.id)) u.coins += rarity.refund; else u.tags.push(tag.id);
    }
    text = `${def.icon} ${def.name}! Everyone just opened a free pack. Look at your tags!`;
  } else if (type === 'jackpot') {
    const amount = num(body.amount, 100, 100000, 1000), all = Object.values(db.users).filter((u) => online.has(u.id));
    const pool = all.length ? all : Object.values(db.users), winners = [];
    while (winners.length < Math.min(3, pool.length)) { const w = pool[crypto.randomInt(0, pool.length)]; if (!winners.includes(w)) winners.push(w); }
    for (const w of winners) { econ(w); w.coins = Math.min(1e9, w.coins + amount); }
    text = `${def.icon} ${def.name}! ${winners.map((w) => w.username).join(', ')} each won ${amount.toLocaleString('en-US')} coins!`;
  } else if (type === 'gift') {
    const amount = num(body.amount, 1, 10000, 100);
    for (const u of Object.values(db.users)) { econ(u); u.coins = Math.min(1e9, u.coins + amount); }
    text = `${def.icon} ${def.name}! Everyone just received ${amount} coins.`;
  } else if (type === 'freespin') {
    for (const u of Object.values(db.users)) u.lastSpin = 0;
    text = `${def.icon} ${def.name}! Everyone can spin the Daily Wheel again right now.`;
  }
  audit(by, 'started event: ' + text);
  tellEveryone(by, text);
  save();
  broadcast({ t: 'members' });
  return text;
}

app.post('/api/owner/events', auth, ownerOnly, (req, res) => {
  const text = startEvent(req.user, String(req.body.type || ''), req.body);
  if (!text) return res.status(400).json({ error: 'Unknown event' });
  res.json({ ok: true, events: economyFor(req.user).events });
});

app.delete('/api/owner/events/:id', auth, ownerOnly, (req, res) => {
  const before = activeEvents().length;
  db.events = activeEvents().filter((e) => e.id !== req.params.id);
  if (db.events.length === before) return res.status(404).json({ error: 'That event already ended' });
  audit(req.user, 'ended an event early');
  save();
  broadcast({ t: 'members' });
  res.json({ ok: true, events: economyFor(req.user).events });
});

/* Owner: AutoMod settings and the list of people it has muted. */
const automodView = () => ({
  ...db.settings.automod,
  muted: Object.values(db.users).filter(automodMuted).map((u) => ({ id: u.id, username: u.username, minutes: muteLeft(u), offenses: u.offenses || 0 })),
  striked: Object.values(db.users).filter((u) => u.offenses && !automodMuted(u)).map((u) => ({ id: u.id, username: u.username, offenses: u.offenses })),
});
app.get('/api/owner/automod', auth, ownerOnly, (req, res) => res.json(automodView()));
function automodPut(req, res) {
  const c = db.settings.automod;
  if (typeof req.body.enabled === 'boolean') c.enabled = req.body.enabled;
  if (typeof req.body.includeStaff === 'boolean') c.includeStaff = req.body.includeStaff;
  if (Array.isArray(req.body.words)) c.words = [...new Set(req.body.words.map((w) => String(w).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30)).filter(Boolean))].slice(0, 200);
  audit(req.user, `AutoMod ${c.enabled ? 'on' : 'off'}${c.includeStaff ? ', also filtering staff' : ''}`);
  save();
  res.json(automodView());
}
app.put('/api/owner/automod', auth, ownerOnly, automodPut);

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
  const minutes = Math.floor(Number(req.body.minutes));
  if (!outranks(req.user, t) && !(minutes === 0 && isAdmin(req.user))) return res.status(403).json({ error: 'You can only mute people ranked below you' });
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > 10080) return res.status(400).json({ error: 'Choose between 0 and 10080 minutes' });
  t.mutedUntil = minutes ? Date.now() + minutes * 60000 : 0;
  if (!minutes) t.offenses = 0; // an unmute also wipes the AutoMod strikes
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
    if (!chanAllowed(req.user, c.id)) continue;
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
  '  announce <text>            post an announcement in #general (with a pop-up there)',
  '  stats                      members, online now, channels, messages, uptime',
  '  who                        who is online right now',
  '  users                      every member and their role',
  '  channels                   every channel with its message count',
  '  role <user> <role>         change someone\'s role',
  '  kick <user>                remove a member (they can register again)',
  '  purge <channel> [count]    delete the last [count] messages, or all of them',
  '  rename <new server name>   rename the server',
  '  givecoins <user> <amount>  give (or take, with a minus) play coins',
  '  unmute <user>              lift a mute (also clears AutoMod strikes)',
  '  givetag <user> <tag>       give a tag by its name (e.g. givetag Bob Rainbow Doge)',
];

app.post('/api/admin/command', auth, (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Only the Owner and Admins can use the admin console' });
  const raw = String(req.body.command || '').trim().replace(/^\//, '');
  if (!raw) return res.json({ output: [] });
  const [cmd, ...args] = tokenize(raw);
  const rest = raw.slice(cmd.length).trim();
  const AUDITED = ['announce', 'role', 'kick', 'purge', 'rename', 'givecoins', 'unmute', 'givetag'];
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
      tellEveryone(req.user, text);
      save();
      return done(`Posted in #${(generalChannel() || {}).name} and showed a pop-up to people reading it (${online.size} online).`);
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

    case 'givecoins': {
      const amount = parseInt(args[args.length - 1], 10);
      const target = findUser(args.slice(0, -1).join(' '));
      if (args.length < 2 || !Number.isFinite(amount)) return done('Usage: givecoins <user> <amount>', false);
      if (!target) return done(`No member named "${args.slice(0, -1).join(' ')}".`, false);
      econ(target);
      target.coins = Math.max(0, Math.min(1e9, target.coins + amount));
      save();
      broadcast({ t: 'members' });
      return done(`${target.username} now has ${target.coins} coins.`);
    }

    case 'givetag': {
      const target = findUser(args[0] || '');
      const name = args.slice(1).join(' ').toLowerCase();
      const tag = TAGS.find((t) => t.id === name || t.name.toLowerCase() === name);
      if (!target || !tag) return done('Usage: givetag <user> <tag name>', false);
      econ(target);
      if (!target.tags.includes(tag.id)) target.tags.push(tag.id);
      save();
      broadcast({ t: 'members' });
      return done(`${target.username} now has the ${tag.name} tag.`);
    }

    case 'unmute': {
      const target = findUser(args.join(' ')) || findUser(args[0] || '');
      if (!target) return done('Usage: unmute <user>', false);
      target.mutedUntil = 0; target.offenses = 0;
      save();
      broadcast({ t: 'members' });
      return done(`${target.username} is unmuted.`);
    }

    default:
      return done(`Unknown command "${cmd}". Type help to see what is available.`, false);
  }
});

/* ------------------------------------------------ who may see which space (Owner only) */

app.put('/api/spaces/:id/access', auth, ownerOnly, (req, res) => {
  const sp = spaceById(req.params.id);
  if (!sp) return res.status(404).json({ error: 'No such space' });
  const ids = Array.isArray(req.body.roles) ? [...new Set(req.body.roles.map(String).filter((id) => id !== 'owner' && roleById(id)))] : [];
  if (sp.system && !ids.length) return res.status(400).json({ error: 'The Staff Hub has to stay limited to some roles' });
  if (ids.length) sp.roles = ids; else delete sp.roles;
  audit(req.user, ids.length ? `limited ${sp.name} to: ${ids.map((id) => roleById(id).name).join(', ')}` : `opened ${sp.name} to everyone`);
  enforceVoiceAccess();
  save();
  broadcast({ t: 'channels' });
  res.json({ ok: true, roles: sp.roles || [] });
});

/* -------------------------------------------------------------- troll panel
   Harmless screen pranks (confetti, shaking, flipping...). The Owner always has the panel and can give it to people. */

const TROLL_EFFECTS = [
  ['jumpscare', '👹', 'Jump scare'], ['blackout', '🔦', 'Lights out'], ['spiders', '🕷️', 'Spider swarm'], ['blood', '🩸', 'Blood drip'],
  ['crack', '💥', 'Cracked screen'], ['glitch', '📺', 'Glitch and crash'], ['eyes', '👁️', 'Creepy eyes'], ['haunt', '👻', 'Haunting'],
  ['hacked', '💻', 'Fake hack alert'], ['shake', '🌋', 'Earthquake'], ['flip', '🙃', 'Flip upside down'], ['zombie', '🧟', 'Zombie hands'],
  ['peeker', '🫥', 'Peeking figure'], ['flicker', '💡', 'Flickering lights'], ['possessed', '😈', 'Possessed screen'], ['whispers', '🗣️', 'Whispers'],
  ['fakeban', '🔨', 'Fake ban notice'], ['fakeupdate', '⬇️', 'Fake update'], ['fakedelete', '🗑️', 'Fake delete-everything'], ['virus', '🦠', 'Fake virus pop-ups'],
  ['chaos', '💀', 'CHAOS (a random mix)'],
];
const CHAOS_POOL = ['jumpscare', 'blackout', 'spiders', 'blood', 'crack', 'glitch', 'eyes', 'haunt', 'hacked', 'zombie', 'peeker', 'flicker', 'possessed', 'whispers', 'fakeban', 'fakeupdate', 'fakedelete', 'virus', 'shake', 'flip'];
const trollAllAt = new Map(); // userId -> last time they trolled the whole server (a cooldown so it stays fun)
const canTroll = (u) => isOwner(u) || u.troll === true;
const isCommunity = (u) => ['owner', 'admin', 'community'].includes(roleOf(u).id);

app.get('/api/troll', auth, (req, res) => {
  if (!canTroll(req.user)) return res.status(403).json({ error: 'You do not have the Troll Panel' });
  res.json({ effects: TROLL_EFFECTS.map(([id, icon, name]) => ({ id, icon, name })) });
});

function sendFx(target, payload) {
  if (target === 'all') broadcast(payload); else sendTo(target, payload);
}

app.post('/api/troll', auth, (req, res) => {
  if (!canTroll(req.user)) return res.status(403).json({ error: 'You do not have the Troll Panel' });
  if (!isOwner(req.user) && rateLimited('troll:' + req.user.id, 10, 30000)) return res.status(429).json({ error: 'Easy, trickster. Wait a few seconds' });
  const fx = TROLL_EFFECTS.find((e) => e[0] === req.body.effect);
  if (!fx) return res.status(400).json({ error: 'Unknown effect' });
  const target = req.body.target === 'all' ? 'all' : String(req.body.target || '');
  const tu = target === 'all' ? null : db.users[target];
  if (target !== 'all' && !tu) return res.status(404).json({ error: 'Pick a person (or everyone)' });
  const emoji = /^\p{Extended_Pictographic}/u.test(String(req.body.emoji || '')) ? Array.from(String(req.body.emoji)).slice(0, 4).join('') : fx[1];
  const seconds = clampNum(req.body.seconds, 3, 20, 8);
  if (target === 'all' && !isOwner(req.user)) { // trolling the whole server has a cooldown (the Owner has none)
    const wait = (fx[0] === 'chaos' ? 90 : 45) * 1000, left = (trollAllAt.get(req.user.id) || 0) + wait - Date.now();
    if (left > 0) return res.status(429).json({ error: `The whole server needs a breather. Try again in ${Math.ceil(left / 1000)} seconds` });
    trollAllAt.set(req.user.id, Date.now());
  }
  if (fx[0] === 'chaos') { // four random effects, one after another
    const picks = [...CHAOS_POOL].sort(() => Math.random() - 0.5).slice(0, 4);
    picks.forEach((id, i) => setTimeout(() => sendFx(target, { t: 'troll', effect: id, seconds: 6, by: i === 0 ? req.user.username : '' }), i * 7000));
    sendFx(target, { t: 'troll', effect: 'chaosintro', seconds: 3, by: req.user.username });
    audit(req.user, `trolled ${tu ? tu.username : 'everyone'}: CHAOS`);
    return res.json({ ok: true });
  }
  sendFx(target, { t: 'troll', effect: fx[0], emoji, seconds, by: req.user.username });
  audit(req.user, `trolled ${tu ? tu.username : 'everyone'}: ${fx[2]}`);
  res.json({ ok: true });
});

app.put('/api/owner/troll-access', auth, ownerOnly, (req, res) => {
  const t = db.users[String(req.body.userId || '')];
  if (!t) return res.status(404).json({ error: 'No such member' });
  if (t.roleId === 'owner') return res.status(400).json({ error: 'The Owner always has the Troll Panel' });
  t.troll = !!req.body.allowed;
  audit(req.user, `${t.troll ? 'gave' : 'took'} the Troll Panel ${t.troll ? 'to' : 'from'} ${t.username}`);
  save();
  broadcast({ t: 'members' });
  res.json({ ok: true, troll: t.troll });
});

/* ------------------------------------------------------------ redeem codes
   The Owner makes codes in the Owner Panel and picks the reward (coins, a tag, or both).
   A person can use each code once. Codes can have a use limit and an end time. */

const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 24);
const codeView = (c) => ({ code: c.code, coins: c.coins, tag: c.tag || null, maxUses: c.maxUses, uses: c.redeemedBy.length, expiresAt: c.expiresAt, createdAt: c.createdAt, by: c.by });
const codeDead = (c) => (c.expiresAt && Date.now() >= c.expiresAt) || (c.maxUses && c.redeemedBy.length >= c.maxUses);

app.get('/api/owner/codes', auth, ownerOnly, (req, res) => res.json({ codes: Object.values(db.codes).sort((a, b) => b.createdAt - a.createdAt).map(codeView), tags: TAGS.map((t) => ({ id: t.id, name: t.name, icon: t.icon, rarity: t.rarity })) }));

app.post('/api/owner/codes', auth, ownerOnly, (req, res) => {
  const coins = clampNum(req.body.coins, 0, 1000000, 0);
  const tag = req.body.tag ? String(req.body.tag) : null;
  if (tag && !tagById(tag)) return res.status(400).json({ error: 'Unknown tag' });
  if (!coins && !tag) return res.status(400).json({ error: 'Pick a reward: some coins, a tag, or both' });
  let code = normCode(req.body.code);
  if (!code) { do { code = 'WARMS-' + crypto.randomBytes(3).toString('hex').toUpperCase(); } while (db.codes[code]); }
  if (code.length < 3) return res.status(400).json({ error: 'A code needs at least 3 letters or numbers' });
  if (db.codes[code]) return res.status(400).json({ error: 'That code already exists' });
  const mins = clampNum(req.body.expiresIn, 0, 60 * 24 * 365, 0);
  db.codes[code] = { code, coins, tag, maxUses: clampNum(req.body.maxUses, 0, 100000, 0), redeemedBy: [], expiresAt: mins ? Date.now() + mins * 60000 : 0, createdAt: Date.now(), by: req.user.username };
  audit(req.user, `made the code ${code} (${coins ? coins + ' coins' : ''}${coins && tag ? ' + ' : ''}${tag ? 'tag ' + tag : ''})`);
  save();
  res.json({ ok: true, code: codeView(db.codes[code]), codes: Object.values(db.codes).sort((a, b) => b.createdAt - a.createdAt).map(codeView) });
});

app.delete('/api/owner/codes/:code', auth, ownerOnly, (req, res) => {
  const code = normCode(req.params.code);
  if (!db.codes[code]) return res.status(404).json({ error: 'No such code' });
  delete db.codes[code];
  audit(req.user, 'deleted the code ' + code);
  save();
  res.json({ ok: true, codes: Object.values(db.codes).sort((a, b) => b.createdAt - a.createdAt).map(codeView) });
});

app.post('/api/codes/redeem', auth, (req, res) => {
  const u = econ(req.user);
  if (rateLimited('redeem:' + u.id, 8, 60000)) return res.status(429).json({ error: 'Too many tries. Wait a minute' });
  const c = db.codes[normCode(req.body.code)];
  if (!c || codeDead(c)) return res.status(400).json({ error: 'That code does not work (it may be wrong, expired or used up)' });
  if (c.redeemedBy.includes(u.id)) return res.status(400).json({ error: 'You already used that code' });
  c.redeemedBy.push(u.id);
  const got = [];
  if (c.coins) { u.coins = Math.min(1e9, u.coins + c.coins); got.push(c.coins.toLocaleString('en-US') + ' coins'); }
  const tag = c.tag && tagById(c.tag);
  let tagInfo = null, dup = false, back = 0;
  if (tag) {
    if (u.tags.includes(tag.id)) { dup = true; back = rarityOf(tag.rarity).refund; u.coins = Math.min(1e9, u.coins + back); got.push(`${tag.icon} ${tag.name} (you had it already, so ${back} coins instead)`); }
    else { u.tags.push(tag.id); got.push(`the ${tag.icon} ${tag.name} tag`); tagInfo = tag; }
  }
  audit(u, `redeemed the code ${c.code}`);
  save();
  res.json({ ok: true, message: 'You got ' + got.join(' and ') + '!', tag: tagInfo, reward: { coins: c.coins, tag: tag ? { id: tag.id, name: tag.name, icon: tag.icon, rarity: tag.rarity } : null, duplicate: dup, refund: back }, ...economyFor(u) });
});

/* ------------------------------------------------------- voice connection servers (STUN/TURN)
   Phones and strict networks often cannot connect straight to each other. A TURN "relay" fixes that.
   Set TURN_URLS (comma separated), TURN_USERNAME and TURN_CREDENTIAL on the host, OR METERED_APP and METERED_API_KEY
   (a free account at metered.ca). Without them, voice only works when the network allows direct connections. */
const STUN_ONLY = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
let iceCache = { at: 0, servers: null };
async function iceServers() {
  if (iceCache.servers && Date.now() - iceCache.at < 10 * 60 * 1000) return iceCache.servers;
  let servers = STUN_ONLY.slice();
  try {
    if (process.env.METERED_APP && process.env.METERED_API_KEY) {
      const r = await fetch(`https://${encodeURIComponent(process.env.METERED_APP)}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(process.env.METERED_API_KEY)}`);
      const list = r.ok ? await r.json() : null;
      if (Array.isArray(list) && list.length) servers = servers.concat(list);
    }
    if (process.env.TURN_URLS && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
      servers.push({ urls: process.env.TURN_URLS.split(',').map((x) => x.trim()).filter(Boolean), username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
    }
  } catch (e) { console.log('Could not load TURN servers:', e.message); }
  iceCache = { at: Date.now(), servers };
  return servers;
}
app.get('/api/ice', auth, async (req, res) => {
  const servers = await iceServers();
  res.json({ iceServers: servers, relay: servers.some((x) => [].concat(x.urls).some((u) => /^turns?:/.test(u))) });
});

const ipBanView = () => db.ipBans.slice().sort((a, b) => b.ts - a.ts).map((b) => ({ id: b.id, ip: b.ip, username: b.username, ts: b.ts, by: b.by }));

app.get('/api/owner/ipbans', auth, ownerOnly, (req, res) => res.json({ bans: ipBanView(), known: Object.values(db.users).filter((u) => (u.ips || []).length).length }));

app.post('/api/owner/ipban', auth, ownerOnly, (req, res) => {
  const t = db.users[String(req.body.userId || '')];
  if (!t) return res.status(404).json({ error: 'No such member' });
  if (isOwner(t)) return res.status(400).json({ error: 'You cannot ban yourself' });
  if (!Array.isArray(t.ips) || !t.ips.length) return res.status(400).json({ error: `No IP address is saved for ${t.username} yet. It is saved the next time they use the site` });
  const mine = new Set([...(req.user.ips || []), clientIp(req)]);
  const ips = t.ips.filter((ip) => !mine.has(ip));
  if (!ips.length) return res.status(400).json({ error: `${t.username} uses the same network as you (${t.ips[t.ips.length - 1]}). Banning it would lock you out too` });
  let added = 0;
  for (const ip of ips) if (!ipBanned(ip)) { db.ipBans.push({ id: uid(6), ip, username: t.username, ts: Date.now(), by: req.user.username }); added++; }
  for (const [tok, id] of Object.entries(db.sessions)) if (id === t.id) delete db.sessions[tok];
  disconnectUser(t.id);
  const name = t.username;
  if (req.body.deleteAccount === true) { delete db.users[t.id]; }
  audit(req.user, `IP-banned ${name} (${ips.length} address${ips.length === 1 ? '' : 'es'})${req.body.deleteAccount === true ? ' and deleted the account' : ''}`);
  save();
  broadcast({ t: 'members' });
  res.json({ ok: true, added, skipped: t.ips.length - ips.length, bans: ipBanView() });
});

app.delete('/api/owner/ipbans/:id', auth, ownerOnly, (req, res) => {
  const b = db.ipBans.find((x) => x.id === req.params.id);
  if (!b) return res.status(404).json({ error: 'No such ban' });
  db.ipBans = db.ipBans.filter((x) => x.id !== b.id);
  audit(req.user, `lifted the IP ban on ${b.username}`);
  save();
  res.json({ ok: true, bans: ipBanView() });
});

/* ---------------------------------------------------- surprise (a random cool event) */

app.post('/api/owner/surprise', auth, ownerOnly, (req, res) => {
  const pool = [
    ['luck', { minutes: 30, mult: 3 }], ['luck', { minutes: 20, mult: 5 }], ['double', { minutes: 30, mult: 2 }], ['double', { minutes: 15, mult: 3 }],
    ['sale', { minutes: 30, percent: 50 }], ['sale', { minutes: 20, percent: 70 }], ['gift', { amount: 100 }], ['gift', { amount: 250 }], ['freespin', {}],
    ['rush', { minutes: 30 }], ['refund', { minutes: 30, mult: 3 }], ['treat', {}], ['freepack', {}], ['jackpot', { amount: 1000 }],
  ];
  const [type, body] = pool[crypto.randomInt(0, pool.length)];
  const text = startEvent(req.user, type, body);
  broadcast({ t: 'troll', effect: 'confetti', emoji: '🎉', seconds: 6, by: req.user.username });
  res.json({ ok: true, text, events: economyFor(req.user).events });
});

/* ------------------------------------------------------------------ arcade
   Reflex games earn a few play coins (with a daily cap, checked on the server). Coin games let people bet play coins:
   every roll is decided here on the server, never by the browser. */
const ARCADE_DAILY_CAP = 300;
const ARCADE_GAMES = { whack: { min: 22, max: 70 }, memory: { min: 8, max: 300 }, reaction: { min: 5, max: 120 } };
const arcadeRuns = new Map(); // userId:game -> { id, at }
const dayKey = () => new Date().toISOString().slice(0, 10);
function arcadeState(u) {
  econ(u);
  if (!u.arcade || u.arcade.day !== dayKey()) u.arcade = { day: dayKey(), earned: 0 };
  return u.arcade;
}
function arcadeReward(game, score, extra) {
  if (game === 'whack') return Math.min(45, Math.floor(score) + (score >= 25 ? 10 : 0));
  if (game === 'memory') return Math.max(5, 40 - Math.max(0, Math.floor(extra) - 8) * 2);
  const ms = extra; // reaction: average milliseconds
  return ms < 220 ? 40 : ms < 280 ? 30 : ms < 350 ? 20 : ms < 450 ? 12 : 5;
}
app.get('/api/arcade', auth, (req, res) => { const a = arcadeState(req.user); res.json({ cap: ARCADE_DAILY_CAP, earned: a.earned, left: Math.max(0, ARCADE_DAILY_CAP - a.earned), ...economyFor(req.user) }); });
app.post('/api/arcade/start', auth, (req, res) => {
  const game = String(req.body.game || '');
  if (!ARCADE_GAMES[game]) return res.status(400).json({ error: 'Unknown game' });
  if (rateLimited('arc:' + req.user.id, 40, 60000)) return res.status(429).json({ error: 'Slow down a little' });
  const id = uid(5); arcadeRuns.set(req.user.id + ':' + game, { id, at: Date.now() });
  res.json({ id });
});
app.post('/api/arcade/finish', auth, (req, res) => {
  const game = String(req.body.game || ''), g = ARCADE_GAMES[game];
  if (!g) return res.status(400).json({ error: 'Unknown game' });
  const key = req.user.id + ':' + game, run = arcadeRuns.get(key);
  if (!run || run.id !== req.body.id) return res.status(400).json({ error: 'Start the game first' });
  arcadeRuns.delete(key);
  const secs = (Date.now() - run.at) / 1000;
  if (secs < g.min || secs > g.max) return res.json({ earned: 0, note: secs < g.min ? 'That was too fast to be real.' : 'That took too long, so it did not count.', ...economyFor(req.user) });
  const score = Math.max(0, Math.min(60, Number(req.body.score) || 0)), extra = Math.max(0, Math.min(100000, Number(req.body.extra) || 0));
  if (game === 'whack' && score > Math.ceil(secs * 2.2)) return res.json({ earned: 0, note: 'That score is not possible.', ...economyFor(req.user) });
  if (game === 'memory' && extra < 8) return res.json({ earned: 0, note: 'That score is not possible.', ...economyFor(req.user) });
  if (game === 'reaction' && (extra < 80 || extra > 5000)) return res.json({ earned: 0, note: 'That score is not possible.', ...economyFor(req.user) });
  const u = econ(req.user), a = arcadeState(u);
  const want = arcadeReward(game, score, extra), coins = Math.max(0, Math.min(want, ARCADE_DAILY_CAP - a.earned));
  a.earned += coins; u.coins = Math.min(1e9, u.coins + coins); questBump(u, 'arcade'); save();
  res.json({ earned: coins, wanted: want, capped: coins < want, left: Math.max(0, ARCADE_DAILY_CAP - a.earned), ...economyFor(u) });
});
const SLOT_SYMBOLS = [['🍒', 30, 5], ['🍋', 24, 7], ['🔔', 18, 14], ['⭐', 9, 35], ['💎', 3, 120]]; // symbol, weight, pays x the bet for three in a row
function spinSlotReel() { let r = crypto.randomInt(0, SLOT_SYMBOLS.reduce((a, b) => a + b[1], 0)); for (const s of SLOT_SYMBOLS) { if ((r -= s[1]) < 0) return s[0]; } return SLOT_SYMBOLS[0][0]; }
function coinGame(req, res, play) {
  if (rateLimited('bet:' + req.user.id, 25, 30000)) return res.status(429).json({ error: 'Slow down a little' });
  const u = econ(req.user), bet = Math.trunc(Number(req.body.bet));
  if (!Number.isFinite(bet) || bet < 1) return res.status(400).json({ error: 'Bet at least 1 coin' });
  if (u.coins < bet) return res.status(400).json({ error: 'You do not have enough coins' });
  const out = play(bet); if (!out) return res.status(400).json({ error: 'Pick something first' });
  u.coins = Math.max(0, Math.min(1e9, u.coins - bet + out.back)); questBump(u, 'coin'); save();
  res.json({ ...out, bet, net: out.back - bet, ...economyFor(u) });
}
app.post('/api/arcade/coinflip', auth, (req, res) => coinGame(req, res, (bet) => {
  const pick = req.body.pick === 'tails' ? 'tails' : req.body.pick === 'heads' ? 'heads' : null; if (!pick) return null;
  const result = crypto.randomInt(0, 2) ? 'heads' : 'tails', won = result === pick;
  return { result, won, back: won ? Math.floor(bet * 1.9) : 0 };
}));
app.post('/api/arcade/dice', auth, (req, res) => coinGame(req, res, (bet) => {
  const pick = Math.trunc(Number(req.body.pick)); if (!(pick >= 1 && pick <= 6)) return null;
  const result = crypto.randomInt(1, 7), won = result === pick;
  return { result, won, back: won ? Math.floor(bet * 5.5) : 0 };
}));
app.post('/api/arcade/slots', auth, (req, res) => coinGame(req, res, (bet) => {
  const reels = [spinSlotReel(), spinSlotReel(), spinSlotReel()];
  let mult = 0;
  if (reels[0] === reels[1] && reels[1] === reels[2]) mult = SLOT_SYMBOLS.find((x) => x[0] === reels[0])[2];
  else if (reels.filter((x) => x === '🍒').length === 2) mult = 1.5;
  return { reels, won: mult > 0, mult, back: Math.floor(bet * mult) };
}));

/* ---- more gambling: Blackjack, Roulette, Higher or Lower. Bets can be any amount up to the coins you have. ---- */
const addCoins = (u, n) => { u.coins = Math.max(0, Math.min(1e9, u.coins + n)); };
function betOf(req, res) {
  const u = econ(req.user), bet = Math.trunc(Number(req.body.bet));
  if (!Number.isFinite(bet) || bet < 1) { res.status(400).json({ error: 'Bet at least 1 coin' }); return null; }
  if (u.coins < bet) { res.status(400).json({ error: 'You do not have enough coins' }); return null; }
  questBump(u, 'coin');
  return bet;
}
const betLimited = (req, res) => (rateLimited('bet:' + req.user.id, 40, 30000) ? (res.status(429).json({ error: 'Slow down a little' }), true) : false);

// Blackjack: dealer stands on 17, blackjack pays 3 to 2, double down on your first two cards, no splitting.
const BJ_SUITS = ['♠', '♥', '♦', '♣'], BJ_RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const bjDeck = () => { const d = []; for (const s of BJ_SUITS) for (const r of BJ_RANKS) d.push(r + s); for (let i = d.length - 1; i > 0; i--) { const j = crypto.randomInt(0, i + 1); [d[i], d[j]] = [d[j], d[i]]; } return d; };
const bjVal = (c) => { const r = c.slice(0, -1); return r === 'A' ? 11 : 'JQK'.includes(r) || r === '10' ? 10 : Number(r); };
function bjTotal(h) { let t = 0, a = 0; for (const c of h) { const v = bjVal(c); t += v; if (v === 11) a++; } while (t > 21 && a) { t -= 10; a--; } return t; }
const bjNatural = (h) => h.length === 2 && bjTotal(h) === 21;
function bjView(u, g, result) {
  const done = !!result;
  return { active: true, player: g.p, dealer: done ? g.d : [g.d[0], '??'], playerTotal: bjTotal(g.p), dealerTotal: done ? bjTotal(g.d) : bjVal(g.d[0]), bet: g.bet, canDouble: !done && g.p.length === 2 && u.coins >= g.bet, state: done ? 'done' : 'playing', result: result || null };
}
function bjFinish(u, g, result) {
  const back = result === 'blackjack' ? g.bet + Math.floor(g.bet * 1.5) : result === 'win' ? g.bet * 2 : result === 'push' ? g.bet : 0;
  addCoins(u, back); u.bj = null; save();
  return { ...bjView(u, g, result), back, net: back - g.bet, won: back > g.bet, ...economyFor(u) };
}
function bjDealerPlays(g) { while (bjTotal(g.d) < 17) g.d.push(g.deck.pop()); }
function bjSettle(u, g) { // after the player stands
  bjDealerPlays(g);
  const pt = bjTotal(g.p), dt = bjTotal(g.d);
  return bjFinish(u, g, dt > 21 || pt > dt ? 'win' : pt === dt ? 'push' : 'lose');
}
app.get('/api/arcade/blackjack', auth, (req, res) => { const u = econ(req.user); res.json(u.bj ? bjView(u, u.bj) : { active: false }); });
app.post('/api/arcade/blackjack/deal', auth, (req, res) => {
  if (betLimited(req, res)) return;
  const u = econ(req.user);
  if (u.bj) return res.status(400).json({ error: 'Finish your current hand first' });
  const bet = betOf(req, res); if (!bet) return;
  addCoins(u, -bet);
  const g = u.bj = { deck: bjDeck(), p: [], d: [], bet };
  g.p.push(g.deck.pop()); g.d.push(g.deck.pop()); g.p.push(g.deck.pop()); g.d.push(g.deck.pop());
  if (bjNatural(g.p) && bjNatural(g.d)) return res.json(bjFinish(u, g, 'push'));
  if (bjNatural(g.p)) return res.json(bjFinish(u, g, 'blackjack'));
  if (bjNatural(g.d)) return res.json(bjFinish(u, g, 'lose'));
  save(); res.json({ ...bjView(u, g), ...economyFor(u) });
});
app.post('/api/arcade/blackjack/hit', auth, (req, res) => {
  const u = econ(req.user), g = u.bj; if (!g) return res.status(400).json({ error: 'No hand in progress' });
  g.p.push(g.deck.pop());
  if (bjTotal(g.p) > 21) return res.json(bjFinish(u, g, 'lose'));
  if (bjTotal(g.p) === 21) return res.json(bjSettle(u, g));
  save(); res.json({ ...bjView(u, g), ...economyFor(u) });
});
app.post('/api/arcade/blackjack/stand', auth, (req, res) => { const u = econ(req.user), g = u.bj; if (!g) return res.status(400).json({ error: 'No hand in progress' }); res.json(bjSettle(u, g)); });
app.post('/api/arcade/blackjack/double', auth, (req, res) => {
  const u = econ(req.user), g = u.bj; if (!g) return res.status(400).json({ error: 'No hand in progress' });
  if (g.p.length !== 2) return res.status(400).json({ error: 'You can only double on your first two cards' });
  if (u.coins < g.bet) return res.status(400).json({ error: 'You do not have enough coins to double' });
  addCoins(u, -g.bet); g.bet *= 2; g.p.push(g.deck.pop());
  if (bjTotal(g.p) > 21) return res.json(bjFinish(u, g, 'lose'));
  res.json(bjSettle(u, g));
});

// Roulette: one zero (0 to 36). Even-money bets pay 1 to 1, dozens 2 to 1, one number 35 to 1.
const ROULETTE_RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const rouletteColor = (n) => (n === 0 ? 'green' : ROULETTE_RED.has(n) ? 'red' : 'black');
function roulettePays(pick, n) { // returns the multiplier returned for a win (stake included), or 0
  if (/^n\d+$/.test(pick)) { const x = Number(pick.slice(1)); return x >= 0 && x <= 36 && x === n ? 36 : 0; }
  if (n === 0) return 0;
  switch (pick) {
    case 'red': return rouletteColor(n) === 'red' ? 2 : 0;
    case 'black': return rouletteColor(n) === 'black' ? 2 : 0;
    case 'even': return n % 2 === 0 ? 2 : 0;
    case 'odd': return n % 2 === 1 ? 2 : 0;
    case 'low': return n <= 18 ? 2 : 0;
    case 'high': return n >= 19 ? 2 : 0;
    case 'd1': return n <= 12 ? 3 : 0;
    case 'd2': return n >= 13 && n <= 24 ? 3 : 0;
    case 'd3': return n >= 25 ? 3 : 0;
  }
  return 0;
}
const ROULETTE_PICKS = new Set(['red', 'black', 'even', 'odd', 'low', 'high', 'd1', 'd2', 'd3']);
app.post('/api/arcade/roulette', auth, (req, res) => {
  if (betLimited(req, res)) return;
  const pick = String(req.body.pick || '');
  if (!ROULETTE_PICKS.has(pick) && !(/^n\d+$/.test(pick) && Number(pick.slice(1)) <= 36)) return res.status(400).json({ error: 'Pick something first' });
  const u = econ(req.user), bet = betOf(req, res); if (!bet) return;
  const n = crypto.randomInt(0, 37), mult = roulettePays(pick, n), back = bet * mult;
  addCoins(u, back - bet); save();
  res.json({ result: n, color: rouletteColor(n), won: mult > 0, mult, back, bet, net: back - bet, ...economyFor(u) });
});

// Higher or Lower: guess if the next card is higher or lower (a tie loses). Chain correct guesses and cash out any time.
const hlWays = (r) => ({ higher: 13 - r, lower: r - 1 });
const hlOptions = (r) => { const w = hlWays(r), o = {}; for (const k of ['higher', 'lower']) if (w[k] > 0) o[k] = Math.round((0.96 * 13 / w[k]) * 100) / 100; return o; };
const hlCard = () => ({ r: crypto.randomInt(1, 14), s: BJ_SUITS[crypto.randomInt(0, 4)] });
const hlLabel = (c) => (c.r === 1 ? 'A' : c.r === 11 ? 'J' : c.r === 12 ? 'Q' : c.r === 13 ? 'K' : String(c.r)) + c.s;
function hlView(g) { return { active: true, card: hlLabel(g.card), bet: g.bet, mult: Math.round(g.mult * 100) / 100, streak: g.streak, options: hlOptions(g.card.r), payout: Math.min(1e9, Math.floor(g.bet * g.mult)) }; }
app.get('/api/arcade/hilo', auth, (req, res) => { const u = econ(req.user); res.json(u.hl ? hlView(u.hl) : { active: false }); });
app.post('/api/arcade/hilo/deal', auth, (req, res) => {
  if (betLimited(req, res)) return;
  const u = econ(req.user);
  if (u.hl) return res.status(400).json({ error: 'Finish your current round first' });
  const bet = betOf(req, res); if (!bet) return;
  addCoins(u, -bet); u.hl = { card: hlCard(), bet, mult: 1, streak: 0 }; save();
  res.json({ ...hlView(u.hl), ...economyFor(u) });
});
app.post('/api/arcade/hilo/guess', auth, (req, res) => {
  const u = econ(req.user), g = u.hl; if (!g) return res.status(400).json({ error: 'No round in progress' });
  const dir = req.body.dir === 'lower' ? 'lower' : req.body.dir === 'higher' ? 'higher' : null, opt = dir && hlOptions(g.card.r)[dir];
  if (!opt) return res.status(400).json({ error: 'You cannot guess that way on this card' });
  const prev = hlLabel(g.card), next = hlCard(), win = dir === 'higher' ? next.r > g.card.r : next.r < g.card.r;
  if (!win) { u.hl = null; save(); return res.json({ active: false, lost: true, prev, card: hlLabel(next), bet: g.bet, back: 0, net: -g.bet, ...economyFor(u) }); }
  g.mult *= opt; g.streak++; g.card = next;
  if (g.bet * g.mult >= 1e9) { const back = 1e9; addCoins(u, back); u.hl = null; save(); return res.json({ active: false, cashed: true, card: hlLabel(next), bet: g.bet, back, net: back - g.bet, ...economyFor(u) }); }
  save(); res.json({ ...hlView(g), prev, correct: true, ...economyFor(u) });
});
app.post('/api/arcade/hilo/cashout', auth, (req, res) => {
  const u = econ(req.user), g = u.hl; if (!g) return res.status(400).json({ error: 'No round in progress' });
  if (g.streak < 1) return res.status(400).json({ error: 'Make at least one correct guess first' });
  const back = Math.min(1e9, Math.floor(g.bet * g.mult)); addCoins(u, back); u.hl = null; save();
  res.json({ active: false, cashed: true, bet: g.bet, back, net: back - g.bet, mult: Math.round(g.mult * 100) / 100, ...economyFor(u) });
});

/* ------------------------------------------------------------------ polls
   The Owner makes a poll; everyone can vote (and change their vote) until it is closed or runs out of time. */
const pollOpen = (p) => !p.closed && (!p.endsAt || p.endsAt > Date.now());
function pollView(p, u) {
  const counts = {}; for (const v of Object.values(p.votes)) counts[v] = (counts[v] || 0) + 1;
  const owner = isOwner(u);
  return { id: p.id, question: p.question, by: p.by, createdAt: p.createdAt, endsAt: p.endsAt || 0, open: pollOpen(p), total: Object.keys(p.votes).length, mine: p.votes[u.id] || null,
    options: p.options.map((o) => ({ id: o.id, text: o.text, count: counts[o.id] || 0, voters: owner ? Object.entries(p.votes).filter(([, v]) => v === o.id).map(([id]) => (db.users[id] ? db.users[id].username : '?')) : undefined })) };
}
const pollList = (u) => db.polls.slice().reverse().slice(0, 15).map((p) => pollView(p, u));
app.get('/api/polls', auth, (req, res) => res.json({ polls: pollList(req.user), unvoted: db.polls.filter((p) => pollOpen(p) && !p.votes[req.user.id]).length }));
app.post('/api/polls/:id/vote', auth, (req, res) => {
  const p = db.polls.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'No such poll' });
  if (!pollOpen(p)) return res.status(400).json({ error: 'This poll is closed' });
  if (rateLimited('vote:' + req.user.id, 30, 30000)) return res.status(429).json({ error: 'Slow down a little' });
  const opt = p.options.find((o) => o.id === String(req.body.option || ''));
  if (!opt) return res.status(400).json({ error: 'Pick one of the choices' });
  p.votes[req.user.id] = opt.id; save(); broadcast({ t: 'poll', id: p.id });
  res.json({ ok: true, poll: pollView(p, req.user) });
});
app.post('/api/owner/polls', auth, ownerOnly, (req, res) => {
  const question = String(req.body.question || '').trim().slice(0, 150);
  const texts = [...new Set((Array.isArray(req.body.options) ? req.body.options : []).map((o) => String(o).trim().slice(0, 60)).filter(Boolean))].slice(0, 8);
  if (!question) return res.status(400).json({ error: 'Type the question first' });
  if (texts.length < 2) return res.status(400).json({ error: 'Give at least two different choices' });
  const minutes = clampNum(req.body.minutes, 0, 10080, 0);
  const poll = { id: uid(5), question, options: texts.map((text, i) => ({ id: 'o' + (i + 1), text })), votes: {}, by: req.user.username, createdAt: Date.now(), endsAt: minutes ? Date.now() + minutes * 60000 : 0, closed: false };
  db.polls.push(poll);
  while (db.polls.length > 40) { const i = db.polls.findIndex((x) => !pollOpen(x)); db.polls.splice(i < 0 ? 0 : i, 1); }
  audit(req.user, `started a poll: ${question.slice(0, 80)}`);
  tellEveryone(req.user, `📊 New poll: ${question} Open the 📊 button on the left bar to vote!`);
  save(); broadcast({ t: 'poll', id: poll.id, fresh: true });
  res.json({ polls: pollList(req.user) });
});
app.post('/api/owner/polls/:id/close', auth, ownerOnly, (req, res) => {
  const p = db.polls.find((x) => x.id === req.params.id); if (!p) return res.status(404).json({ error: 'No such poll' });
  p.closed = true; audit(req.user, `closed the poll: ${p.question.slice(0, 80)}`); save(); broadcast({ t: 'poll', id: p.id });
  res.json({ polls: pollList(req.user) });
});
app.delete('/api/owner/polls/:id', auth, ownerOnly, (req, res) => {
  const p = db.polls.find((x) => x.id === req.params.id); if (!p) return res.status(404).json({ error: 'No such poll' });
  db.polls = db.polls.filter((x) => x !== p); audit(req.user, `deleted the poll: ${p.question.slice(0, 80)}`); save(); broadcast({ t: 'poll', id: p.id });
  res.json({ polls: pollList(req.user) });
});

/* ---------------------------------------------------------------- minigame
   "Number Rush": tap 1 to 16 in order. The Owner picks the time limit and the prize.
   The server times it from the moment a person presses Start, so the clock cannot be changed in the browser. */

const MG_MIN_SECONDS = 4; // faster than this is not humanly possible
const mgStarts = new Map(); // `${gameId}:${userId}` -> start time
const shuffled = (n) => { const a = Array.from({ length: n }, (_, i) => i + 1); for (let i = n - 1; i > 0; i--) { const j = crypto.randomInt(0, i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };

function activeMinigame() {
  const g = db.minigame;
  if (!g || g.ended) return null;
  if (Date.now() >= g.endsAt || (g.maxWinners && g.winners.length >= g.maxWinners)) { g.ended = true; save(); return null; }
  return g;
}
function rewardLabel(r) {
  if (r.type === 'tag') { const t = tagById(r.tag); return t ? `the ${t.icon} ${t.name} tag` : 'a tag'; }
  return `${r.amount.toLocaleString('en-US')} coins`;
}
function minigameView(u) {
  const g = db.minigame;
  if (!g) return { active: false };
  const act = !!activeMinigame();
  const view = { active: act, id: g.id, game: g.game, limit: g.limit, reward: { ...g.reward, label: rewardLabel(g.reward) }, endsAt: g.endsAt, now: Date.now(), wins: g.winners.length, maxWinners: g.maxWinners || 0, won: g.winners.some((w) => w.userId === u.id), by: g.by };
  if (isOwner(u)) view.winners = g.winners.map((w) => ({ username: (db.users[w.userId] || {}).username || 'Removed user', time: w.time, ts: w.ts }));
  return view;
}

app.get('/api/minigame', auth, (req, res) => res.json(minigameView(req.user)));

app.post('/api/owner/minigame', auth, ownerOnly, (req, res) => {
  const limit = clampNum(req.body.limit, 8, 120, 25);
  const minutes = clampNum(req.body.minutes, 1, 120, 10);
  const maxWinners = clampNum(req.body.maxWinners, 0, 1000, 0);
  let reward;
  if (req.body.rewardType === 'tag') {
    if (!tagById(String(req.body.tag || ''))) return res.status(400).json({ error: 'Pick a tag for the prize' });
    reward = { type: 'tag', tag: String(req.body.tag) };
  } else {
    reward = { type: 'coins', amount: clampNum(req.body.amount, 1, 100000, 200) };
  }
  mgStarts.clear();
  db.minigame = { id: uid(5), game: 'rush', limit, reward, endsAt: Date.now() + minutes * 60000, maxWinners, winners: [], by: req.user.username, ended: false };
  audit(req.user, `started a minigame: finish Number Rush in ${limit}s to win ${rewardLabel(reward)}`);
  tellEveryone(req.user, `🎮 Minigame! Finish Number Rush in ${limit} seconds or less to win ${rewardLabel(reward)}. Open the 🎮 button in the corner of the screen. It ends in ${fmtMin(minutes)}.`);
  save();
  broadcast({ t: 'minigame', kind: 'start' });
  res.json(minigameView(req.user));
});

app.delete('/api/owner/minigame', auth, ownerOnly, (req, res) => {
  if (!db.minigame || db.minigame.ended) return res.status(404).json({ error: 'There is no minigame running' });
  db.minigame.ended = true;
  audit(req.user, 'ended the minigame');
  save();
  broadcast({ t: 'minigame', kind: 'end' });
  res.json(minigameView(req.user));
});

app.post('/api/minigame/start', auth, (req, res) => {
  const g = activeMinigame();
  if (!g) return res.status(404).json({ error: 'There is no minigame right now' });
  if (g.winners.some((w) => w.userId === req.user.id)) return res.status(400).json({ error: 'You already won this one!' });
  if (rateLimited('mg:' + req.user.id, 40, 60000)) return res.status(429).json({ error: 'Slow down a little' });
  mgStarts.set(g.id + ':' + req.user.id, Date.now());
  res.json({ id: g.id, limit: g.limit, layout: shuffled(16) });
});

app.post('/api/minigame/finish', auth, (req, res) => {
  const g = activeMinigame();
  if (!g || g.id !== req.body.id) return res.status(404).json({ error: 'That minigame is over' });
  const key = g.id + ':' + req.user.id, started = mgStarts.get(key);
  if (!started) return res.status(400).json({ error: 'Press Start first' });
  mgStarts.delete(key);
  if (g.winners.some((w) => w.userId === req.user.id)) return res.status(400).json({ error: 'You already won this one!' });
  const time = (Date.now() - started) / 1000;
  if (time < MG_MIN_SECONDS) return res.json({ won: false, time, reason: 'That was too fast to be real. Try again!' });
  if (time > g.limit + 1.5) return res.json({ won: false, time, reason: `Too slow: you needed ${g.limit} seconds or less. Try again!` });
  const u = econ(req.user);
  let prize;
  if (g.reward.type === 'tag') {
    const t = tagById(g.reward.tag), r = t && rarityOf(t.rarity);
    if (u.tags.includes(g.reward.tag)) { u.coins = Math.min(1e9, u.coins + (r ? r.refund : 0)); prize = `You already own ${t.name}, so you got ${r.refund} coins instead`; }
    else { u.tags.push(g.reward.tag); prize = `You won the ${t.icon} ${t.name} tag!`; }
  } else {
    u.coins = Math.min(1e9, u.coins + g.reward.amount);
    prize = `You won ${g.reward.amount.toLocaleString('en-US')} coins!`;
  }
  g.winners.push({ userId: u.id, time: Math.round(time * 100) / 100, ts: Date.now() });
  save();
  broadcast({ t: 'minigame', kind: 'win', username: u.username, time: Math.round(time * 10) / 10 });
  broadcast({ t: 'members' });
  res.json({ won: true, time, prize, ...economyFor(u) });
});

/* ---------------------------------------------------------------- live show
   A long, hosted event with music, sound effects, trivia, reflex rounds, prize drops and a finale. The rules live in showengine.js
   (shared with the preview). The Owner can let Admins run shows. */

const SHOW = require('./showengine');
const canRunShow = (u) => isOwner(u) || (isAdmin(u) && db.showAdmins);
const needShowHost = (req, res, next) => (canRunShow(req.user) ? next() : res.status(403).json({ error: 'Only the Owner can run a show (or Admins, if the Owner allows it)' }));
const liveShow = () => (db.show && !db.show.closed ? db.show : null);

function pickShowTag() {
  const rs = RARITIES.filter((r) => r.id !== 'croma');
  for (let tries = 0; tries < 6; tries++) {
    const r = pickWeighted(rs, (x) => x.chance);
    const pool = TAGS.filter((t) => t.rarity === r.id && !t.kind && !t.limited && !packClosed(PACKS.find((p) => p.id === t.pack) || {}));
    if (pool.length) return pool[crypto.randomInt(0, pool.length)].id;
  }
  return null;
}

// Hands out an award from the show: coins, free machine spins, a tag. Returns a short sentence.
function giveShowAward(userId, a) {
  const user = db.users[userId]; if (!user) return '';
  const u = econ(user), bits = [];
  if (a.coins) { u.coins = Math.min(1e9, u.coins + a.coins); bits.push(`${a.coins.toLocaleString('en-US')} coins`); }
  if (a.spins) { u.freeRolls = Math.min(999, (u.freeRolls || 0) + a.spins); bits.push(`${a.spins} free machine spin${a.spins === 1 ? '' : 's'}`); }
  if (a.evTag) {
    const et = tagById(a.evTag), fxt = tagById(EVENT_FX[a.evTag]);
    if (et && !u.tags.includes(et.id)) { u.tags.push(et.id); bits.push(`the limited ${et.icon} ${et.name} tag`); }
    if (fxt && !u.tags.includes(fxt.id)) { u.tags.push(fxt.id); bits.push(`the ${fxt.icon} ${fxt.name} profile animation`); }
  }
  if (a.tag === true) a = Object.assign({}, a, { tag: pickShowTag() });
  if (a.tag) {
    const t = tagById(a.tag), r = t && rarityOf(t.rarity);
    if (t) { if (u.tags.includes(t.id)) { u.coins = Math.min(1e9, u.coins + r.refund); bits.push(`${r.refund} coins (you already had ${t.name})`); } else { u.tags.push(t.id); bits.push(`the ${t.icon} ${t.name} tag`); } }
  }
  sendTo(userId, { t: 'show', kind: 'award', text: bits.join(' + ') });
  return bits.join(' + ');
}

function showTickOnce() {
  const sh = db.show; if (!sh || sh.closed) return;
  const now = Date.now(), idx = SHOW.stepIndex(sh, now);
  if (sh._idx !== idx) { sh._idx = idx; broadcast({ t: 'show', kind: 'step' }); }
  if (!sh.paid && now >= sh.finaleAt) {
    // Work out who already holds a limited tag BEFORE this show's tag is handed out.
    const holders = new Set(Object.values(db.users).filter((u) => (u.tags || []).some((t) => { const d = tagById(t); return d && d.limited; })).map((u) => u.id));
    const ledger = SHOW.payout(sh, pickShowTag, holders);
    for (const l of ledger) giveShowAward(l.userId, { coins: l.coins, spins: l.spins, tag: l.tag, evTag: l.evTag });
    // Everyone who is online for the show gets the limited tag too, even if they never opened the stage.
    const got = new Set(ledger.map((l) => l.userId)), evTag = sh.opts.theme === 'halloween' ? 'show-halloween' : 'show-live';
    for (const uid of online) if (!got.has(uid) && db.users[uid]) giveShowAward(uid, { evTag, coins: holders.has(uid) ? sh.opts.returnCoins : 0 });
    const top = (sh.results || []).slice(0, 3);
    db.lastShow = { id: sh.id, endedAt: now, results: (sh.results || []).slice(0, 10) };
    if (top.length) {
      const host = db.users[sh.by] || Object.values(db.users).find((x) => isOwner(x));
      if (host) tellEveryone(host, `🏆 The show is over! 🥇 ${top[0].name} (${top[0].score} pts)${top[1] ? ' · 🥈 ' + top[1].name : ''}${top[2] ? ' · 🥉 ' + top[2].name : ''}. Thanks for playing everyone!`);
    }
    save(); broadcast({ t: 'show', kind: 'step' }); broadcast({ t: 'members' });
  }
  if (now >= sh.endsAt + 5000) { sh.closed = true; save(); broadcast({ t: 'show', kind: 'end' }); }
}
setInterval(() => { try { showTickOnce(); } catch (e) { console.error('show tick: ' + (e && e.stack || e)); } }, 1000).unref();

function showResponse(u) {
  const sh = liveShow();
  return {
    canRun: canRunShow(u), owner: isOwner(u), admins: db.showAdmins, now: Date.now(),
    show: sh ? Object.assign(SHOW.view(sh, u.id, Date.now()), { by: sh.byName, length: sh.opts.length }) : null,
    last: db.lastShow,
    presets: Object.entries(SHOW.PRESETS).map(([id, p]) => ({ id, label: p.label })),
    defaults: SHOW.DEFAULTS, lead: SHOW.LEAD_MS,
  };
}

app.get('/api/show', auth, (req, res) => res.json(showResponse(req.user)));

app.post('/api/show/start', auth, needShowHost, (req, res) => {
  if (liveShow()) return res.status(400).json({ error: 'A show is already running. Stop it first' });
  const sh = SHOW.makeShow(req.body || {}, Date.now());
  sh.by = req.user.id; sh.byName = req.user.username;
  db.show = sh;
  audit(req.user, `started a ${sh.opts.theme === 'halloween' ? 'Halloween ' : ''}live show (${SHOW.PRESETS[sh.opts.length].label})`);
  tellEveryone(req.user, `${sh.opts.theme === 'halloween' ? '💀 HALLOWEEN LIVE SHOW' : '⚡ LIVE SHOW'} starting in ${Math.round(SHOW.LEAD_MS / 1000)} seconds. Trivia, reflexes, loot drops and real prizes. Hit Join on the bar at the top. 1st place takes ${sh.opts.prizes[0].toLocaleString('en-US')} coins.`);
  save();
  broadcast({ t: 'show', kind: 'start', theme: sh.opts.theme });
  res.json(showResponse(req.user));
});

app.post('/api/show/stop', auth, needShowHost, (req, res) => {
  const sh = liveShow();
  if (!sh) return res.status(404).json({ error: 'There is no show running' });
  sh.closed = true;
  audit(req.user, 'stopped the live show');
  tellEveryone(req.user, '🎉 The live show was ended early. See you at the next one!');
  save();
  broadcast({ t: 'show', kind: 'end' });
  res.json(showResponse(req.user));
});

app.post('/api/show/announce', auth, needShowHost, (req, res) => {
  const sh = liveShow();
  if (!sh) return res.status(404).json({ error: 'There is no show running' });
  if (rateLimited('showann:' + req.user.id, 20, 60000)) return res.status(429).json({ error: 'Slow down a little' });
  const text = String((req.body || {}).text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!text) return res.status(400).json({ error: 'Type something to announce' });
  sh.announce = { text, ts: Date.now(), by: req.user.username };
  audit(req.user, 'made a live show announcement');
  save();
  broadcast({ t: 'show', kind: 'announce', text, by: req.user.username });
  res.json({ ok: true });
});

app.put('/api/owner/show-admins', auth, ownerOnly, (req, res) => {
  db.showAdmins = !!req.body.enabled;
  audit(req.user, db.showAdmins ? 'let Admins run live shows' : 'stopped Admins from running live shows');
  save();
  res.json(showResponse(req.user));
});

function showAction(fn) {
  return (req, res) => {
    const sh = liveShow();
    if (!sh) return res.status(404).json({ error: 'There is no show right now' });
    if (rateLimited('show:' + req.user.id, 600, 60000)) return res.status(429).json({ error: 'Slow down a little' });
    const r = fn(sh, req, Date.now());
    if (r.error) return res.status(400).json({ error: r.error });
    save();
    res.json(r);
  };
}
app.post('/api/show/join', auth, showAction((sh, req) => {
  if (Date.now() >= sh.endsAt) return { error: 'The show is over' };
  const r = SHOW.join(sh, req.user.id, req.user.username);
  if (r.joined) questBump(econ(req.user), 'arcade');
  return { ok: true, joined: r.joined };
}));
app.post('/api/show/answer', auth, showAction((sh, req, now) => SHOW.answer(sh, req.user.id, req.body || {}, now)));
app.post('/api/show/react', auth, showAction((sh, req, now) => SHOW.react(sh, req.user.id, req.body || {}, now)));
app.post('/api/show/run', auth, showAction((sh, req, now) => SHOW.run(sh, req.user.id, req.body || {}, now)));
app.post('/api/show/simon', auth, showAction((sh, req, now) => SHOW.simon(sh, req.user.id, req.body || {}, now)));
app.post('/api/show/bridge', auth, showAction((sh, req, now) => SHOW.bridge(sh, req.user.id, req.body || {}, now)));
app.post('/api/show/pull', auth, showAction((sh, req, now) => SHOW.pull(sh, req.user.id, req.body || {}, now)));
app.post('/api/show/claim', auth, showAction((sh, req, now) => {
  const r = SHOW.claim(sh, req.user.id, req.body || {}, now);
  if (r.ok && r.award) r.text = giveShowAward(req.user.id, r.award);
  if (r.ok && r.award) { broadcast({ t: 'show', kind: 'step' }); }
  return r;
}));
app.post('/api/show/tap', auth, showAction((sh, req, now) => SHOW.tap(sh, req.user.id, req.body || {}, now)));

/* ------------------------------------------------------------ community panel
   For the Community Manager (and Admins and the Owner). */

const needCommunity = (req, res, next) => (isCommunity(req.user) ? next() : res.status(403).json({ error: 'The Community Panel is for the Community Manager, Admins and the Owner' }));

app.get('/api/community/overview', auth, needCommunity, (req, res) => {
  const now = Date.now(), users = Object.values(db.users);
  res.json({
    members: users.length,
    online: online.size,
    newest: users.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 8).map((u) => ({ id: u.id, username: u.username, createdAt: u.createdAt, online: online.has(u.id) })),
    muted: users.filter((u) => muteLeft(u)).map((u) => ({ id: u.id, username: u.username, minutes: muteLeft(u) })),
    events: economyFor(req.user).events,
    reports: db.reports.filter((r) => !r.resolved).slice(-15).reverse().map((r) => ({ id: r.id, username: r.username, kind: r.kind, message: r.message, ts: r.ts })),
    minigame: minigameView(req.user),
    now,
  });
});

/* ------------------------------------------------------------ Admin Panel
   A panel of its own for Admins (and the Owner): members, reports, AutoMod and the staff log, next to the Command Center. */
const adminOnly = (req, res, next) => (isAdmin(req.user) ? next() : res.status(403).json({ error: 'The Admin Panel is for Admins and the Owner' }));
app.get('/api/admin/panel', auth, adminOnly, (req, res) => {
  const users = Object.values(db.users);
  res.json({
    now: Date.now(),
    me: req.user.id,
    members: users.slice().sort((a, b) => roleOf(a).position - roleOf(b).position || a.username.localeCompare(b.username)).map((u) => ({ id: u.id, username: u.username, roleId: u.roleId, online: online.has(u.id), muted: muteLeft(u), createdAt: u.createdAt, canManage: u.id !== req.user.id && outranks(req.user, u) })),
    roles: db.roles.slice().sort((a, b) => a.position - b.position).filter((r) => r.id !== 'owner').map((r) => ({ id: r.id, name: r.name, color: r.color })),
    reports: db.reports.slice(-25).reverse().map((r) => ({ id: r.id, username: r.username, kind: r.kind, message: r.message, ts: r.ts, resolved: !!r.resolved })),
    automod: automodView(),
    audit: db.audit.slice(-15).reverse(),
  });
});
app.post('/api/admin/reports/:id/resolve', auth, adminOnly, (req, res) => {
  const r = db.reports.find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'No such report' });
  r.resolved = !r.resolved; audit(req.user, `${r.resolved ? 'resolved' : 'reopened'} a report from ${r.username}`); save(); res.json({ ok: true, resolved: r.resolved });
});
app.delete('/api/admin/reports/:id', auth, adminOnly, (req, res) => {
  db.reports = db.reports.filter((x) => x.id !== req.params.id); save(); res.json({ ok: true });
});
app.put('/api/admin/automod', auth, adminOnly, automodPut);

app.post('/api/community/announce', auth, needCommunity, (req, res) => {
  const text = String(req.body.text || '').trim().slice(0, 300);
  if (!text) return res.status(400).json({ error: 'Type your announcement first' });
  if (rateLimited('cann:' + req.user.id, 5, 60000)) return res.status(429).json({ error: 'Slow down a little' });
  audit(req.user, 'announced in #general: ' + text.slice(0, 80));
  tellEveryone(req.user, text);
  save();
  res.json({ ok: true });
});


/* ------------------------------------------------------------------ daily quests
   Five quests a day (the same five for everyone, picked from a pool), reset at midnight Pacific time.
   Coins are paid the moment a quest is finished, plus a bonus for finishing all five. */
const QUEST_TZ = 'America/Los_Angeles';
const QUEST_POOL = [
  { id: 'chat10', key: 'chat', goal: 10, reward: 40, text: 'Send 10 chat messages' },
  { id: 'chat30', key: 'chat', goal: 30, reward: 90, text: 'Send 30 chat messages' },
  { id: 'react5', key: 'react', goal: 5, reward: 25, text: 'React to 5 messages' },
  { id: 'dm3', key: 'dm', goal: 3, reward: 25, text: 'Send 3 messages to friends' },
  { id: 'arcade2', key: 'arcade', goal: 2, reward: 40, text: 'Finish 2 arcade reflex games' },
  { id: 'arcade5', key: 'arcade', goal: 5, reward: 80, text: 'Finish 5 arcade reflex games' },
  { id: 'coin5', key: 'coin', goal: 5, reward: 40, text: 'Play 5 coin games' },
  { id: 'spin', key: 'spin', goal: 1, reward: 30, text: 'Spin the daily wheel' },
  { id: 'coin12', key: 'coin', goal: 12, reward: 70, text: 'Play 12 coin games' },
];
const QUEST_BONUS = 100;
const questDay = (t = Date.now()) => new Date(t).toLocaleDateString('en-CA', { timeZone: QUEST_TZ });
function questMsLeft() {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: QUEST_TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const g = (t) => Number(parts.find((x) => x.type === t).value);
  return 86400000 - (g('hour') * 3600 + g('minute') * 60 + g('second')) * 1000;
}
function questsToday(day = questDay()) { // same picks for everyone: a seeded shuffle of the pool
  let seed = 0; for (const ch of day) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const a = QUEST_POOL.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, 5);
}
function questState(u) {
  const day = questDay();
  if (!u.quests || u.quests.day !== day) u.quests = { day, progress: {}, done: {}, bonus: false };
  return u.quests;
}
function questBump(u, key, n = 1) {
  if (!u || process.env.QUESTS === '0') return; // (QUESTS=0 is only for automated tests that count coins exactly)
  const q = questState(u), done = [];
  for (const d of questsToday(q.day)) {
    if (d.key !== key || q.done[d.id]) continue;
    q.progress[d.id] = Math.min(d.goal, (q.progress[d.id] || 0) + n);
    if (q.progress[d.id] >= d.goal) { q.done[d.id] = true; econ(u); addCoins(u, d.reward); done.push({ text: d.text, reward: d.reward }); }
  }
  if (!q.bonus && questsToday(q.day).every((d) => q.done[d.id])) { q.bonus = true; econ(u); addCoins(u, QUEST_BONUS); done.push({ text: 'All daily quests done!', reward: QUEST_BONUS }); }
  if (done.length) sendTo(u.id, { t: 'quest', done });
}
const questGate = new Map(); // one chat message counts every few seconds, so spamming does not farm coins
function questChat(u, key) {
  const k = key + u.id, last = questGate.get(k) || 0;
  if (Date.now() - last < 2000) return;
  questGate.set(k, Date.now()); questBump(u, key);
}
function questView(u) {
  const q = questState(u);
  return { day: q.day, resetsIn: questMsLeft(), bonus: { reward: QUEST_BONUS, done: !!q.bonus },
    quests: questsToday(q.day).map((d) => ({ id: d.id, text: d.text, goal: d.goal, reward: d.reward, progress: q.progress[d.id] || 0, done: !!q.done[d.id] })) };
}
app.get('/api/quests', auth, (req, res) => { econ(req.user); res.json(questView(req.user)); });


/* ---- profile pages: account number, joined date, views and message count ---- */
const profileSeen = new Map(); // `${viewer}:${target}` -> time, so refreshing does not run the view count up
app.get('/api/users/:id/profile', auth, (req, res) => {
  const t = db.users[req.params.id];
  if (!t) return res.status(404).json({ error: 'No such person' });
  if (t.id !== req.user.id) {
    const k = req.user.id + ':' + t.id, last = profileSeen.get(k) || 0;
    if (Date.now() - last > 30 * 60000) { profileSeen.set(k, Date.now()); t.views = Math.min(1e9, (t.views || 0) + 1); save(); }
  }
  let messages = 0;
  for (const list of Object.values(db.messages)) for (const m of list) if (m.userId === t.id && !m.system && !m.announce) messages++;
  res.json({ id: t.id, acct: t.acct || 0, joined: t.createdAt, views: t.views || 0, messages });
});

/* ---- the welcome tour (shown once to new people) ---- */
app.post('/api/tour-done', auth, (req, res) => { req.user.toured = true; save(); res.json({ ok: true }); });

/* ---- Owner countdown ("Next update in...", "Admin abuse in...") ---- */
function countdownView() { const c = db.countdown; return c && c.endsAt + 10 * 60000 > Date.now() ? { label: c.label, endsAt: c.endsAt, now: Date.now() } : null; }
app.get('/api/countdown', auth, (req, res) => res.json({ countdown: countdownView() }));
app.put('/api/owner/countdown', auth, ownerOnly, (req, res) => {
  const label = String(req.body.label || '').trim().slice(0, 60);
  const endsAt = Math.trunc(Number(req.body.endsAt));
  if (!label) return res.status(400).json({ error: 'Type what is coming first' });
  if (!Number.isFinite(endsAt) || endsAt < Date.now() + 5000 || endsAt > Date.now() + 365 * 86400000) return res.status(400).json({ error: 'Pick a time in the future (within a year)' });
  db.countdown = { label, endsAt }; audit(req.user, `started a countdown: ${label}`); save(); broadcast({ t: 'countdown' });
  res.json({ countdown: countdownView() });
});
app.delete('/api/owner/countdown', auth, ownerOnly, (req, res) => { db.countdown = null; audit(req.user, 'cleared the countdown'); save(); broadcast({ t: 'countdown' }); res.json({ ok: true }); });

/* ---- web games: the Owner adds links to games that run in a web page; everyone can play them here ---- */
app.get('/api/webgames', auth, (req, res) => res.json({ games: db.webgames }));
app.post('/api/owner/webgames', auth, ownerOnly, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 40), icon = String(req.body.icon || '').trim().slice(0, 4) || '🎮';
  let url; try { url = new URL(String(req.body.url || '').trim()); } catch { url = null; }
  if (!name) return res.status(400).json({ error: 'Give the game a name' });
  if (!url || url.protocol !== 'https:') return res.status(400).json({ error: 'The link must start with https://' });
  if (db.webgames.length >= 60) return res.status(400).json({ error: 'That is plenty of games already (60 max)' });
  db.webgames.push({ id: uid(4), name, icon, url: url.href }); audit(req.user, `added the web game ${name}`); save(); broadcast({ t: 'webgames' });
  res.json({ games: db.webgames });
});
app.delete('/api/owner/webgames/:id', auth, ownerOnly, (req, res) => {
  const g = db.webgames.find((x) => x.id === req.params.id); if (!g) return res.status(404).json({ error: 'No such game' });
  db.webgames = db.webgames.filter((x) => x !== g); audit(req.user, `removed the web game ${g.name}`); save(); broadcast({ t: 'webgames' });
  res.json({ games: db.webgames });
});

// Render stops the old copy with SIGTERM during an update: write everything to disk first so nothing is lost.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    try { const tmp = DB_FILE + '.tmp'; const json = JSON.stringify(db); fs.writeFileSync(tmp, json); fs.renameSync(tmp, DB_FILE); store.mirrorDb(json); } catch {}
    try { await store.flush(); } catch {}
    process.exit(0);
  });
}

// One bad request must never take the whole site down (a crash restarts the app, and a restart can wipe a site without permanent storage).
process.on('uncaughtException', (e) => console.error('Uncaught error (kept running): ' + (e && e.stack || e)));
process.on('unhandledRejection', (e) => console.error('Unhandled promise error (kept running): ' + (e && e.stack || e)));

// Render's free plan puts a site to sleep after ~15 quiet minutes, and waking it up is a full restart. Ping ourselves through the public address to stay awake.
if (process.env.RENDER_EXTERNAL_URL && process.env.KEEP_AWAKE !== '0') {
  setInterval(() => { fetch(process.env.RENDER_EXTERNAL_URL + '/api/ping').catch(() => {}); }, 9 * 60 * 1000).unref();
}

server.listen(PORT, () => {
  console.log(`Chat running on http://localhost:${PORT}`);
  const st = storageInfo();
  console.log(st.database ? 'Storage: permanent (external database)' : st.persistent ? `Storage: permanent (${st.dir})` : `Storage: TEMPORARY (${st.dir}) - everything is erased on every update! Add a disk on Render, or use Back up / Restore in the Owner Panel.`);
});

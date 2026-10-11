'use strict';

/* ------------------------------------------------------------- helpers */

const $ = (id) => document.getElementById(id);

// Build DOM nodes safely: text is always set via textContent, never innerHTML.
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'value') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const PERM_INFO = {
  manage_roles: ['Manage roles', 'Create and edit roles, and assign them to people ranked below you.'],
  manage_channels: ['Manage channels', 'Create and delete channels, and rename the server.'],
  manage_users: ['Remove members', 'Remove people ranked below you from the server.'],
  delete_messages: ['Delete messages', "Delete other people's messages."],
};

const state = {
  token: localStorage.getItem('token') || '',
  me: null,
  users: [],
  roles: [],
  channels: [],
  perms: [],
  serverName: '',
  spaces: [],
  spaceId: null,
  lastChan: {},
  channelId: null,
  messages: [],
  typing: {}, // channelId -> { userId: expiresAt }
  pendingImage: null,
  replyTo: null,
  unread: {}, // channelId -> { n, m }
  hiddenPings: 0,
  ws: null,
};

let onStateChange = null; // set by the staff panel so it repaints when members or channels change
const muteMinutes = (u) => (u && u.mutedUntil && u.mutedUntil > Date.now() ? Math.ceil((u.mutedUntil - Date.now()) / 60000) : 0);
const hasStaffPerm = () => state.perms.some((p) => can(p));

const EMOJI = ['👍', '❤️', '😂', '😮', '😢', '🎉', '🔥', '👀', '💯', '🐐'];

const userById = (id) => state.users.find((u) => u.id === id);
const roleById = (id) => state.roles.find((r) => r.id === id) || state.roles.find((r) => r.id === 'member');
const me = () => userById(state.me);
const myRole = () => roleById(me().roleId);
const isOwner = () => myRole().id === 'owner';
const isAdmin = () => myRole().id === 'owner' || myRole().id === 'admin'; // full staff powers
const can = (perm) => isAdmin() || myRole().perms.includes(perm);
function outranksUser(a, b) {
  return roleById(a.roleId).position < roleById(b.roleId).position;
}

function colorFor(name) {
  let x = 0;
  for (const c of name) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${x % 360} 45% 45%)`;
}

function avatar(user, withDot) {
  const a = h('div', { class: 'avatar', style: `background:${colorFor(user.username)}` }, user.avatar ? null : user.username[0].toUpperCase());
  if (user.avatar) a.style.cssText = `background:url("${user.avatar}") center/cover`;
  if (withDot && user.online) a.append(h('span', { class: 'status-dot' }));
  return a;
}

const SKINS = {
  warms: ['Warms', ['#0b0806', '#1c130e', '#ff8a3d']],
  midnight: ['Midnight', ['#202225', '#36393f', '#7289da']],
  neon: ['Neon', ['#080410', '#190f2c', '#b650ff']],
  forest: ['Forest', ['#0a120e', '#192b23', '#3fbf7f']],
  ember: ['Ember', ['#100905', '#2c1b14', '#ff7a3d']],
  ocean: ['Ocean', ['#050d15', '#12263a', '#2fa8ff']],
};
function pref(key, value) {
  try { if (value === undefined) return localStorage.getItem(key); if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch (e) { /* storage unavailable */ }
  return null;
}
function applySkin() {
  const skin = SKINS[pref('skin')] ? pref('skin') : 'warms';
  const accent = /^#[0-9a-f]{6}$/i.test(pref('accent') || '') ? pref('accent') : '';
  const root = document.documentElement;
  root.setAttribute('data-skin', skin);
  if (accent) { root.style.setProperty('--accent', accent); root.style.setProperty('--accent-hover', `color-mix(in srgb, ${accent} 85%, black)`); }
  else { root.style.removeProperty('--accent'); root.style.removeProperty('--accent-hover'); }
}
applySkin();

function toast(text) {
  const t = h('div', { class: 'toast' }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), 3500);
}

async function api(path, method = 'GET', body) {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.token },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* empty body */ }
  if (res.status === 401 && state.token) { logout(true); throw new Error('Signed out'); }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// Run an action and show any error as a toast.
async function attempt(fn) {
  try { return await fn(); } catch (e) { if (e.message !== 'Signed out') toast(e.message); }
}

const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function fmtStamp(ts) {
  const d = new Date(ts), now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff === 0) return 'Today at ' + fmtTime(ts);
  if (diff === 1) return 'Yesterday at ' + fmtTime(ts);
  return d.toLocaleDateString() + ' ' + fmtTime(ts);
}

/* ---------------------------------------------------------------- modals */

function closeOverlay() { $('overlay').classList.add('hidden'); $('overlay').replaceChildren(); }
function openOverlay(node, dismissable = true) {
  const o = $('overlay');
  o.replaceChildren(node);
  o.classList.remove('hidden');
  o.onmousedown = (e) => { if (dismissable && e.target === o) closeOverlay(); };
}

function ask(title, label, initial = '') {
  return new Promise((resolve) => {
    const input = h('input', { type: 'text', value: initial, maxlength: 32, placeholder: label });
    const done = (v) => { closeOverlay(); resolve(v); };
    const form = h('form', { class: 'modal', onsubmit: (e) => { e.preventDefault(); done(input.value.trim() || null); } },
      h('h2', {}, title), input,
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'btn ghost small', onclick: () => done(null) }, 'Cancel'),
        h('button', { type: 'submit', class: 'btn primary small' }, 'Done')));
    openOverlay(form);
    input.focus();
  });
}

function confirmBox(title, text, okLabel = 'Delete') {
  return new Promise((resolve) => {
    const done = (v) => { closeOverlay(); resolve(v); };
    openOverlay(h('div', { class: 'modal' },
      h('h2', {}, title), h('p', {}, text),
      h('div', { class: 'actions' },
        h('button', { class: 'btn ghost small', onclick: () => done(false) }, 'Cancel'),
        h('button', { class: 'btn danger small', onclick: () => done(true) }, okLabel))));
  });
}

/* ------------------------------------------------------------------ auth */

let registerMode = false;
function setAuthMode(reg, hasUsers) {
  registerMode = reg;
  $('authTitle').textContent = reg ? 'Create an account' : 'Welcome back!';
  $('authSub').textContent = reg ? 'Join the chat.' : "We're so excited to see you again!";
  $('authBtn').textContent = reg ? 'Continue' : 'Log In';
  $('authSwitchText').textContent = reg ? 'Already have an account?' : 'Need an account?';
  $('authSwitch').textContent = reg ? 'Log In' : 'Register';
  $('authPass').autocomplete = reg ? 'new-password' : 'current-password';
  const note = $('authNote');
  if (reg && hasUsers === false) {
    note.textContent = "Nobody has an account yet. You'll be the first, so you'll become the Admin and can give everyone else roles.";
    note.classList.remove('hidden');
  } else note.classList.add('hidden');
  $('authErr').textContent = '';
}

async function showAuth() {
  $('app').classList.add('hidden');
  $('auth').classList.remove('hidden');
  let status = { hasUsers: true };
  try { status = await (await fetch('/api/status')).json(); } catch (e) { /* keep default */ }
  state.hasUsers = status.hasUsers;
  setAuthMode(!status.hasUsers, status.hasUsers);
  $('authSwitch').onclick = (e) => { e.preventDefault(); setAuthMode(!registerMode, state.hasUsers); };
}

$('authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('authErr').textContent = '';
  $('authBtn').disabled = true;
  try {
    const res = await fetch('/api/' + (registerMode ? 'register' : 'login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('authUser').value, password: $('authPass').value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Something went wrong');
    state.token = data.token;
    localStorage.setItem('token', data.token);
    $('authPass').value = '';
    await start();
  } catch (err) {
    $('authErr').textContent = err.message;
  } finally {
    $('authBtn').disabled = false;
  }
});

function logout(silent) {
  if (!silent) fetch('/api/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + state.token } }).catch(() => {});
  localStorage.removeItem('token');
  state.token = '';
  leaveVoice(true);
  if (state.ws) { state.ws.onclose = null; state.ws.close(); state.ws = null; }
  closeOverlay();
  showAuth();
}

/* ------------------------------------------------------------- bootstrap */

async function refresh() {
  const data = await api('/bootstrap');
  state.me = data.me;
  state.users = data.users;
  state.roles = data.roles;
  state.channels = data.channels;
  state.perms = data.perms;
  state.voiceChannels = data.voiceChannels || [];
  state.voice = data.voice || {};
  state.serverName = data.serverName;
  state.annIcon = data.annIcon || null;
  state.spaces = data.spaces || [{ id: 'main', name: data.serverName }];
  if (state.spaceId !== ANN_SPACE && !state.spaces.some((x) => x.id === state.spaceId)) state.spaceId = state.spaces[0].id;
  if (!state.channels.some((c) => c.id === state.channelId && (c.spaceId || state.spaces[0].id) === state.spaceId)) {
    state.channelId = (inSpace(state.spaceId).find((c) => !c.locked) || inSpace(state.spaceId)[0] || state.channels[0]).id;
    await loadMessages();
  }
  renderChrome();
  renderVoice();
  if (typeof onStateChange === 'function') onStateChange();
}

async function start() {
  $('auth').classList.add('hidden');
  $('app').classList.remove('hidden');
  state.channelId = null;
  await refresh();
  playIntro();
  connectWs();
  $('msgInput').focus();
}

function connectWs() {
  if (state.ws) { state.ws.onclose = null; state.ws.close(); }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(state.token)}`);
  state.ws = ws;
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === 'message') {
      if (m.msg.channelId === state.channelId) {
        state.messages.push(m.msg);
        appendMessage(m.msg);
        if (document.hidden && m.msg.userId !== state.me && mentionsMe(m.msg)) { state.hiddenPings++; updateTitle(); }
      } else if (m.msg.userId !== state.me) {
        const u = (state.unread[m.msg.channelId] = state.unread[m.msg.channelId] || { n: 0, m: 0 });
        u.n++;
        if (mentionsMe(m.msg)) u.m++;
        renderChrome();
      }
      const t = state.typing[m.msg.channelId];
      if (t) delete t[m.msg.userId];
      renderTyping();
    } else if (m.t === 'delete') {
      state.messages = state.messages.filter((x) => x.id !== m.id);
      const el = document.querySelector(`[data-mid="${m.id}"]`);
      if (el) { el.remove(); renderMessages(true); }
    } else if (m.t === 'reaction') {
      const x = state.messages.find((q) => q.id === m.id);
      if (x) { x.reactions = m.reactions; refreshMessage(m.id); }
    } else if (m.t === 'edit') {
      const x = state.messages.find((q) => q.id === m.id);
      if (x) { x.content = m.content; x.edited = m.edited; refreshMessage(m.id); }
    } else if (m.t === 'voice') {
      state.voice = m.voice; renderVoice();
    } else if (m.t === 'voice-joined') {
      onVoiceJoined(m);
    } else if (m.t === 'voice-left') {
      dropPeer(m.userId);
    } else if (m.t === 'voice-signal') {
      onVoiceSignal(m.from, m.data);
    } else if (m.t === 'voice-error') {
      cleanupVoice(); toast(m.error);
    } else if (m.t === 'announce') {
      showBanner(m.by, m.text);
    } else if (m.t === 'welcome') {
      if (m.userId !== state.me) showBanner(m.username, m.text, 'NEW MEMBER', 'welcome');
      attempt(async () => { await refresh(); });
    } else if (m.t === 'signin') {
      if (m.userId !== state.me) signinToast(m.username);
      attempt(async () => { await refresh(); });
    } else if (m.t === 'purged') {
      if (m.channelId === state.channelId) attempt(loadMessages);
    } else if (m.t === 'typing') {
      if (m.userId === state.me) return;
      (state.typing[m.channelId] ||= {})[m.userId] = Date.now() + 4000;
      renderTyping();
    } else {
      attempt(async () => { await refresh(); renderMessages(true); });
    }
  };
  ws.onclose = () => { cleanupVoice(); setTimeout(() => { if (state.token) { connectWs(); attempt(refresh); } }, 2000); };
}

setInterval(renderTyping, 1000);

/* ------------------------------------------------------------- rendering */

const inSpace = (id) => state.channels.filter((c) => (c.spaceId || state.spaces[0].id) === id);
const ANN_SPACE = 'announcements';
// Clean megaphone icon (fixed markup, no user text).
function annIcon(size) {
  const w = document.createElement('span');
  w.className = 'ann-ico';
  w.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path fill="currentColor" d="M3 10.5v3a1.5 1.5 0 0 0 1.5 1.5H6l1.4 4.2a1 1 0 0 0 .95.7h1.5a.8.8 0 0 0 .78-1L9.5 15H11l8.2 3.6A.9.9 0 0 0 20.5 17.8V6.2a.9.9 0 0 0-1.3-.8L11 9H4.5A1.5 1.5 0 0 0 3 10.5z"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M22 10.2c.8.6.8 3 0 3.6"/></svg>`;
  return w;
}
const curSpace = () => state.spaceId === ANN_SPACE ? { id: ANN_SPACE, name: 'Announcements' } : state.spaces.find((x) => x.id === state.spaceId) || state.spaces[0] || { id: 'main', name: state.serverName };
const spaceInitials = (name) => (name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2) || '#').toUpperCase();

function renderChrome() {
  updateTitle();
  const sp = curSpace();
  $('serverName').textContent = sp.name;
  $('onlineCount').textContent = state.users.filter((u) => u.online).length + ' online';

  $('addChannel').classList.toggle('hidden', !can('manage_channels'));
  const inAnn = state.spaceId === ANN_SPACE;
  $('newChat').classList.toggle('hidden', inAnn || !can('manage_channels'));
  $('addChannel').classList.toggle('hidden', inAnn || !can('manage_channels'));
  $('voiceSection').classList.toggle('hidden', inAnn);
  $('railAdd').classList.toggle('hidden', !isAdmin());
  const annUnread = inSpace(ANN_SPACE).map((c) => state.unread[c.id]).filter(Boolean);
  $('railAnn').className = 'rail-chat rail-ann' + (state.spaceId === ANN_SPACE ? ' active' : '');
  $('railAnn').classList.toggle('has-img', !!state.annIcon);
  $('railAnn').replaceChildren(state.annIcon ? h('img', { class: 'rail-img', src: state.annIcon, alt: '' }) : annIcon(22), annUnread.length ? h('i', { class: 'rail-dot' + (annUnread.some((x) => x.m) ? ' ping' : '') }) : null);
  $('railChats').replaceChildren(...state.spaces.map((sp2) => {
    const ids = inSpace(sp2.id).map((c) => c.id);
    const un = ids.map((id) => state.unread[id]).filter(Boolean);
    const ping = un.some((x) => x.m);
    return h('button', { class: 'rail-chat' + (sp2.id === state.spaceId ? ' active' : '') + (sp2.icon ? ' has-img' : ''), title: sp2.name, onclick: () => switchSpace(sp2.id) },
      sp2.icon ? h('img', { class: 'rail-img', src: sp2.icon, alt: '' }) : h('span', {}, spaceInitials(sp2.name)),
      un.length ? h('i', { class: 'rail-dot' + (ping ? ' ping' : '') }) : null);
  }));
  $('ownerBtn').classList.toggle('hidden', !isOwner());
  $('adminBtn').classList.toggle('hidden', !isAdmin());
  $('staffBtn').classList.toggle('hidden', isAdmin() || !hasStaffPerm());

  const list = $('channelList');
  list.replaceChildren(...inSpace(state.spaceId).map((c) =>
    h('div', { class: 'channel' + (c.id === state.channelId ? ' active' : '') + (state.unread[c.id] ? ' unread' : ''), onclick: () => switchChannel(c.id) },
      c.locked ? h('span', { class: 'hash' }, annIcon(16)) : h('span', { class: 'hash' }, '#'),
      h('span', { class: 'cname' }, c.name),
      c.locked ? h('span', { class: 'lock', title: 'Only the Owner can post here' }, '🔒') : null,
      state.unread[c.id] ? h('span', { class: 'badge' + (state.unread[c.id].m ? '' : ' soft') }, state.unread[c.id].m || state.unread[c.id].n) : null,
      can('manage_channels') && !c.locked && inSpace(state.spaceId).filter((x) => !x.locked).length > 1
        ? h('button', { class: 'icon-btn chan-x', title: 'Delete channel', onclick: (e) => { e.stopPropagation(); removeChannel(c); } }, '✕')
        : null)));

  const ch = state.channels.find((c) => c.id === state.channelId);
  $('channelTitle').textContent = ch ? ch.name : '';
  const muted = muteMinutes(me());
  const readOnly = !!(ch && ch.locked && !isOwner());
  $('msgInput').disabled = readOnly;
  $('attachBtn').classList.toggle('hidden', readOnly);
  document.querySelector('.composer').classList.toggle('readonly', readOnly);
  $('msgInput').placeholder = readOnly ? '🔒 Only the Owner can post in #' + ch.name : muted ? `You are muted for ${muted} more min` : ch ? 'Message #' + ch.name : 'Message';

  const u = me();
  $('meAvatar').replaceWith(Object.assign(avatar(u, false), { id: 'meAvatar' }));
  $('meName').textContent = u.username;
  $('meName').style.color = myRole().color;
  $('meRole').textContent = myRole().name;

  renderMembers();
  renderTyping();
}

function updateTitle() {
  const pings = state.hiddenPings + Object.values(state.unread).reduce((n, u) => n + u.m, 0);
  document.title = (pings ? `(${pings}) ` : '') + curSpace().name;
}
window.addEventListener('focus', () => { state.hiddenPings = 0; updateTitle(); });

function renderMembers() {
  const box = $('members');
  const groups = [];
  const sorted = state.roles.slice().sort((a, b) => a.position - b.position);
  for (const role of sorted) {
    const people = state.users.filter((u) => u.roleId === role.id)
      .sort((a, b) => (b.online - a.online) || a.username.localeCompare(b.username));
    if (!people.length) continue;
    groups.push(h('div', { class: 'mgroup' },
      h('h4', {}, `${role.name}—${people.length}`),
      people.map((p) => h('div', {
        class: 'member' + (p.online ? '' : ' offline'),
        onclick: (e) => showPopover(p, e.currentTarget),
      }, avatar(p, true), h('div', { class: 'mtext' },
        h('span', { class: 'mname', style: `color:${role.color}` }, p.username),
        p.status ? h('span', { class: 'mstat' }, p.status) : null)))));
  }
  box.replaceChildren(...groups);
}

function renderTyping() {
  const t = state.typing[state.channelId] || {};
  const now = Date.now();
  const names = [];
  for (const [id, exp] of Object.entries(t)) {
    if (exp < now) { delete t[id]; continue; }
    const u = userById(id);
    if (u) names.push(u.username);
  }
  const el = $('typing');
  if (!names.length) { el.innerHTML = '&nbsp;'; return; }
  const who = names.length === 1 ? [h('b', {}, names[0]), ' is typing…']
    : names.length === 2 ? [h('b', {}, names[0]), ' and ', h('b', {}, names[1]), ' are typing…']
    : ['Several people are typing…'];
  el.replaceChildren(...who);
}

const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Turns @name into highlighted mentions, built from DOM nodes so message text is never parsed as HTML.
function renderText(content) {
  const names = state.users.map((u) => u.username).sort((x, y) => y.length - x.length).map(escRe);
  if (!names.length || !content.includes('@')) return [content];
  const re = new RegExp('@(' + names.join('|') + ')(?![A-Za-z0-9_])', 'gi');
  const out = [];
  let last = 0, m;
  while ((m = re.exec(content))) {
    if (m.index > last) out.push(content.slice(last, m.index));
    const u = state.users.find((x) => x.username.toLowerCase() === m[1].toLowerCase());
    out.push(h('span', { class: 'mention' + (u && u.id === state.me ? ' me' : '') }, m[0]));
    last = m.index + m[0].length;
  }
  if (last < content.length) out.push(content.slice(last));
  return out;
}

function mentionsMe(msg) {
  const u = me();
  if (!u || msg.userId === state.me || !msg.content) return false;
  return new RegExp('@' + escRe(u.username) + '(?![A-Za-z0-9_])', 'i').test(msg.content);
}

function jumpTo(id) {
  const el = document.querySelector(`[data-mid="${id}"]`);
  if (!el) return toast('That message is further up than what is loaded');
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}

function refreshMessage(id) {
  const i = state.messages.findIndex((m) => m.id === id);
  const old = document.querySelector(`[data-mid="${id}"]`);
  if (i < 0 || !old) return;
  old.replaceWith(messageNode(state.messages[i], state.messages[i - 1]));
}

let pickerEl = null;
function closePicker() { if (pickerEl) { pickerEl.remove(); pickerEl = null; } }
function openPicker(anchor, msg) {
  closePicker();
  pickerEl = h('div', { class: 'picker' }, EMOJI.map((e) =>
    h('button', { type: 'button', onclick: () => { closePicker(); attempt(() => api(`/messages/${msg.id}/reactions`, 'PUT', { emoji: e })); } }, e)));
  document.body.append(pickerEl);
  const r = anchor.getBoundingClientRect();
  pickerEl.style.left = Math.max(8, Math.min(r.right - 220, window.innerWidth - 228)) + 'px';
  pickerEl.style.top = (r.bottom + 230 > window.innerHeight ? Math.max(8, r.top - pickerEl.offsetHeight - 6) : r.bottom + 6) + 'px';
}
document.addEventListener('mousedown', (e) => { if (pickerEl && !e.target.closest('.picker') && !e.target.closest('.tools')) closePicker(); });

function startReply(msg) {
  state.replyTo = msg;
  const u = userById(msg.userId);
  $('replyBar').replaceChildren(
    h('span', {}, 'Replying to ', h('b', {}, u ? u.username : 'a removed user')),
    h('span', { class: 'rtxt' }, (msg.content || 'image').slice(0, 100)),
    h('button', { class: 'icon-btn', title: 'Cancel reply', onclick: clearReply }, '✕'));
  $('replyBar').classList.remove('hidden');
  $('msgInput').focus();
}
function clearReply() { state.replyTo = null; $('replyBar').classList.add('hidden'); $('replyBar').replaceChildren(); }

function startEdit(msg) {
  const box = document.querySelector(`[data-mid="${msg.id}"] .text`);
  if (!box) return;
  const input = h('input', { class: 'edit-in', value: msg.content, maxlength: 2000 });
  const cancel = () => refreshMessage(msg.id);
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); cancel(); }
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = input.value;
      if (!v.trim() || v === msg.content) return cancel();
      const ok = await attempt(() => api('/messages/' + msg.id, 'PATCH', { content: v }));
      if (!ok) cancel();
    }
  });
  box.replaceChildren(input, h('div', { class: 'edit-hint' }, 'Enter to save · Esc to cancel'));
  input.focus();
}

// Small pill shown next to a name for anyone with a role other than the default Member.
function roleTag(role) {
  if (!role || role.id === 'member') return null;
  const label = (role.id === 'moderator' ? 'Mod' : role.id === 'owner' ? '♛ Owner' : role.name).slice(0, 14);
  return h('span', {
    class: 'rtag' + (role.id === 'admin' ? ' admin' : '') + (role.id === 'owner' ? ' owner' : ''),
    title: role.name,
    style: `color:${role.color};border-color:color-mix(in srgb, ${role.color} 55%, transparent);background:color-mix(in srgb, ${role.color} 16%, transparent)`,
  }, label);
}

function messageNode(msg, prev) {
  if (msg.system) {
    return h('div', { class: 'msg sysmsg', 'data-mid': msg.id },
      h('span', { class: 'sys-arrow' }, '➜'),
      h('span', { class: 'sys-text' }, renderText(msg.content)),
      h('span', { class: 'time' }, fmtStamp(msg.ts)),
      can('delete_messages') ? h('button', { class: 'sys-x', title: 'Delete', onclick: () => attempt(() => api('/messages/' + msg.id, 'DELETE')) }, '✕') : null);
  }
  const author = userById(msg.userId);
  const name = author ? author.username : 'Removed user';
  const color = author ? roleById(author.roleId).color : '#8e9297';
  const grouped = prev && prev.userId === msg.userId && msg.ts - prev.ts < 5 * 60 * 1000 && !msg.announce && !prev.announce && !msg.replyTo;
  const own = msg.userId === state.me;
  const canDelete = own || can('delete_messages');
  const pinged = mentionsMe(msg);

  const tools = h('div', { class: 'tools' },
    h('button', { title: 'Add reaction', onclick: (e) => openPicker(e.currentTarget, msg) }, '😀'),
    h('button', { title: 'Reply', onclick: () => startReply(msg) }, '↩'),
    own && !msg.announce && msg.content ? h('button', { title: 'Edit message', onclick: () => startEdit(msg) }, '✎') : null,
    canDelete ? h('button', { class: 'del', title: 'Delete message', onclick: () => attempt(() => api('/messages/' + msg.id, 'DELETE')) }, '🗑') : null);

  const ref = msg.replyTo ? state.messages.find((m) => m.id === msg.replyTo) : null;
  const refUser = ref ? userById(ref.userId) : null;
  const reply = msg.replyTo
    ? h('div', { class: 'reply', onclick: () => jumpTo(msg.replyTo) },
        ref ? [h('b', { style: `color:${refUser ? roleById(refUser.roleId).color : '#8e9297'}` }, refUser ? refUser.username : 'Removed user'), ' ' + (ref.content || 'image').slice(0, 90)]
            : 'Original message is not loaded')
    : null;

  const reacts = Object.entries(msg.reactions || {}).filter(([, ids]) => ids.length);
  const reactRow = reacts.length
    ? h('div', { class: 'reacts' }, reacts.map(([emoji, ids]) =>
        h('button', {
          class: 'react' + (ids.includes(state.me) ? ' mine' : ''),
          title: ids.map((id) => (userById(id) || { username: 'someone' }).username).join(', '),
          onclick: () => attempt(() => api(`/messages/${msg.id}/reactions`, 'PUT', { emoji })),
        }, h('span', {}, emoji), h('span', { class: 'rc' }, ids.length))))
    : null;

  const content = [
    msg.content ? h('div', { class: 'text' }, renderText(msg.content), msg.edited ? h('span', { class: 'edited' }, '(edited)') : null) : null,
    msg.image ? h('img', { class: 'att', src: msg.image, alt: 'attachment', loading: 'lazy', onclick: () => openLightbox(msg.image) }) : null,
    reactRow,
  ];
  const cls = (msg.announce ? ' announce' : '') + (pinged ? ' pinged' : '');
  if (grouped) {
    return h('div', { class: 'msg' + cls, 'data-mid': msg.id },
      h('div', { class: 'gutter' }, fmtTime(msg.ts)), h('div', { class: 'body' }, content), tools);
  }
  return h('div', { class: 'msg first' + cls, 'data-mid': msg.id },
    author ? avatar(author, false) : h('div', { class: 'avatar', style: 'background:#555' }, '?'),
    h('div', { class: 'body' },
      reply,
      h('div', { class: 'meta' },
        h('span', { class: 'author', style: `color:${color}`, onclick: (e) => author && showPopover(author, e.currentTarget) }, name),
        author ? roleTag(roleById(author.roleId)) : null,
        msg.announce ? h('span', { class: 'tag' }, 'ANNOUNCEMENT') : null,
        h('span', { class: 'time' }, fmtStamp(msg.ts))),
      content),
    tools);
}

const nearBottom = (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 120;

function renderMessages(keepScroll) {
  const box = $('messages');
  const stick = !keepScroll || nearBottom(box);
  const prevTop = box.scrollTop;
  if (!state.messages.length) {
    box.replaceChildren(h('div', { class: 'empty' }, 'This is the start of the channel. Say something!'));
    return;
  }
  box.replaceChildren(...state.messages.map((m, i) => messageNode(m, state.messages[i - 1])));
  box.scrollTop = stick ? box.scrollHeight : prevTop;
}

function appendMessage(msg) {
  const box = $('messages');
  const stick = nearBottom(box) || msg.userId === state.me;
  if (box.querySelector('.empty')) box.replaceChildren();
  const prev = state.messages[state.messages.length - 2];
  box.append(messageNode(msg, prev));
  if (stick) box.scrollTop = box.scrollHeight;
}

async function loadMessages() {
  state.messages = await api(`/channels/${state.channelId}/messages`);
  renderMessages(false);
}

async function switchChannel(id) {
  if (id === state.channelId) return;
  state.channelId = id;
  const chosen = state.channels.find((c) => c.id === id);
  if (chosen && chosen.spaceId) { state.spaceId = chosen.spaceId; state.lastChan[chosen.spaceId] = id; }
  delete state.unread[id];
  clearPending();
  clearReply();
  renderChrome();
  await attempt(loadMessages);
  $('msgInput').focus();
}

function openLightbox(src) {
  openOverlay(h('div', { class: 'lightbox', onclick: closeOverlay }, h('img', { src, alt: '' })));
}

/* ----------------------------------------------------- sending messages */

function clearPending() {
  state.pendingImage = null;
  $('pending').classList.add('hidden');
  $('pending').replaceChildren();
}

async function uploadFile(file) {
  if (!file) return;
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) return toast('Only PNG, JPG, GIF or WEBP images');
  if (file.size > 5 * 1024 * 1024) return toast('Image is over 5 MB');
  const dataUrl = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
  const out = await attempt(() => api('/upload', 'POST', { data: dataUrl }));
  if (!out) return;
  state.pendingImage = out.url;
  $('pending').replaceChildren(
    h('img', { src: out.url, alt: 'pending upload' }),
    h('span', {}, 'Press Enter to send'),
    h('button', { class: 'icon-btn', title: 'Remove', onclick: clearPending }, '✕'));
  $('pending').classList.remove('hidden');
  $('msgInput').focus();
}

$('attachBtn').onclick = () => $('fileInput').click();
$('fileInput').onchange = (e) => { uploadFile(e.target.files[0]); e.target.value = ''; };
$('msgInput').addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (item) { e.preventDefault(); uploadFile(item.getAsFile()); }
});

let lastTyping = 0;
$('msgInput').addEventListener('input', () => {
  if (Date.now() - lastTyping > 3000 && $('msgInput').value) {
    lastTyping = Date.now();
    api('/typing', 'POST', { channelId: state.channelId }).catch(() => {});
  }
});

// Fun slash commands anyone can use. Results are posted as normal messages.
const rnd = (n) => { const b = new Uint32Array(1); crypto.getRandomValues(b); return b[0] % n; };
const BALL = ['It is certain.', 'Without a doubt.', 'Yes.', 'Most likely.', 'Ask again later.', 'Cannot predict now.', "Don't count on it.", 'My sources say no.', 'Very doubtful.'];
function slash(text) {
  const name = me().username;
  let m;
  if ((m = /^\/roll(?:\s+(\d+))?\s*$/i.exec(text))) {
    const sides = Math.min(1000, Math.max(2, parseInt(m[1], 10) || 6));
    return `\uD83C\uDFB2 ${name} rolled a ${rnd(sides) + 1} (1-${sides})`;
  }
  if (/^\/flip\s*$/i.test(text)) return `\uD83E\uDE99 ${name} flipped ${rnd(2) ? 'heads' : 'tails'}`;
  if ((m = /^\/8ball\s+(.+)$/i.exec(text))) return `\uD83C\uDFB1 ${m[1]}\n${BALL[rnd(BALL.length)]}`;
  if ((m = /^\/shrug\s*(.*)$/i.exec(text))) return (m[1] + ' \u00AF\\_(\u30C4)_/\u00AF').trim();
  return text;
}

$('msgInput').addEventListener('keydown', (e) => { if (e.key === 'Escape') clearReply(); });
$('msgInput').addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
  e.preventDefault();
  const input = $('msgInput');
  const content = input.value;
  if (!content.trim() && !state.pendingImage) return;
  const image = state.pendingImage;
  const replyTo = state.replyTo ? state.replyTo.id : undefined;
  input.value = '';
  clearPending();
  clearReply();
  const ok = await attempt(() => api(`/channels/${state.channelId}/messages`, 'POST', { content: slash(content), image, replyTo }));
  if (!ok) input.value = content;
});

/* ------------------------------------------------------------- channels */

async function switchSpace(id) {
  if (id === state.spaceId) return;
  const target = inSpace(id);
  const last = state.lastChan[id];
  const ch = target.find((c) => c.id === last) || target.find((c) => !c.locked) || target[0];
  state.spaceId = id;
  if (ch) await switchChannel(ch.id);
}

async function newSpace() {
  if (!isAdmin()) return toast('Only the Owner and Admins can create spaces');
  const name = await ask('New space', 'Space name');
  if (!name) return;
  attempt(async () => {
    const r = await api('/spaces', 'POST', { name });
    await refresh();
    state.spaceId = r.space.id;
    await switchChannel(r.channel.id);
    toast2('Created ' + r.space.name);
  });
}

async function newChat() {
  const name = await ask('New chat', 'new-chat-name');
  if (!name) return;
  attempt(async () => {
    const ch = await api('/channels', 'POST', { name, spaceId: state.spaceId });
    await refresh();
    switchChannel(ch.id);
    toast2('Created #' + ch.name);
  });
}
$('addChannel').onclick = newChat;
$('newChat').onclick = newChat;
$('railAdd').onclick = newSpace;
$('railAnn').onclick = () => switchSpace(ANN_SPACE);

async function removeChannel(c) {
  if (await confirmBox('Delete #' + c.name + '?', 'All messages in this channel will be deleted for good.')) {
    attempt(() => api('/channels/' + c.id, 'DELETE'));
  }
}

/* ------------------------------------------------------- member popover */

function hidePopover() { $('popover').classList.add('hidden'); }
document.addEventListener('mousedown', (e) => { if (!e.target.closest('#popover')) hidePopover(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { hidePopover(); closePicker(); if (!$('overlay').classList.contains('hidden')) closeOverlay(); else if ($('cc')) closeCommandCenter(); else if ($('staffcc')) closeStaffPanel(); } });

function assignableRoles(target) {
  // Mirrors the server rules: admins can give anything; others only roles below their own.
  if (!can('manage_roles')) return [];
  if (target.roleId === 'owner') return [];
  if (target.id !== state.me && !outranksUser(me(), target)) return [];
  return state.roles.filter((r) => r.id !== 'owner' && r.position > myRole().position);
}

function showPopover(user, anchor) {
  const pop = $('popover');
  const role = roleById(user.roleId);
  const options = assignableRoles(user);
  const body = [
    h('div', { class: 'pop-banner', style: `background:${role.color}` }),
    h('div', { class: 'pop-body' },
      avatar(user, true),
      h('div', { class: 'pop-name' }, user.username),
      h('div', { class: 'pop-sub' }, (user.online ? 'Online' : 'Offline') + ' · Joined ' + new Date(user.createdAt).toLocaleDateString()),
      user.status ? h('div', { class: 'pop-status' }, user.status) : null,
      h('div', { class: 'pop-sec' }, h('h6', {}, 'Role'),
        options.length
          ? h('select', {
              onchange: (e) => attempt(async () => { await api(`/users/${user.id}/role`, 'PUT', { roleId: e.target.value }); hidePopover(); }),
            }, options.map((r) => h('option', { value: r.id, selected: r.id === user.roleId }, r.name)),
              options.some((r) => r.id === user.roleId) ? null : h('option', { value: user.roleId, selected: true, disabled: true }, role.name))
          : h('span', { class: 'pill', style: `border-color:${role.color}` }, h('span', { class: 'dot', style: `background:${role.color}` }), role.name)),
      can('manage_users') && user.id !== state.me && user.roleId !== 'owner' && outranksUser(me(), user)
        ? h('button', {
            class: 'btn danger small',
            onclick: async () => {
              hidePopover();
              if (await confirmBox('Remove ' + user.username + '?', 'Their account will be deleted and they will be signed out. They can register again.', 'Remove')) {
                attempt(() => api('/users/' + user.id, 'DELETE'));
              }
            },
          }, 'Remove from server')
        : null),
  ];
  pop.replaceChildren(...body);
  pop.classList.remove('hidden');
  const r = anchor.getBoundingClientRect();
  const w = 280, hgt = pop.offsetHeight;
  let left = r.left - w - 8;
  if (left < 8) left = Math.min(r.right + 8, window.innerWidth - w - 8);
  pop.style.left = left + 'px';
  pop.style.top = Math.max(8, Math.min(r.top, window.innerHeight - hgt - 8)) + 'px';
}

/* ------------------------------------------------------------- settings */

$('settingsBtn').onclick = () => openSettings('account');

function openSettings(tab) {
  const tabs = [['account', 'My Account'], ['look', 'Appearance']];
  if (can('manage_channels')) tabs.push(['server', 'Server']);
  if (can('manage_roles')) tabs.push(['roles', 'Roles']);
  if (!tabs.some((t) => t[0] === tab)) tab = 'account';

  const pane = h('div', { class: 'pane' });
  const nav = h('div', { class: 'nav' },
    h('h5', {}, 'Settings'),
    tabs.map(([id, label]) => h('button', { class: id === tab ? 'active' : '', onclick: () => openSettings(id) }, label)),
    h('div', { class: 'spacer' }),
    h('button', { onclick: () => { closeOverlay(); openReport(); } }, 'Report a problem'),
    h('button', { class: 'logout', onclick: () => logout(false) }, 'Log Out'));
  pane.append(h('button', { class: 'close', title: 'Close', onclick: closeOverlay }, '✕'));
  const body = h('div', {});
  pane.append(body);
  openOverlay(h('div', { class: 'settings' }, nav, pane));

  if (tab === 'account') renderAccountTab(body);
  if (tab === 'server') renderServerTab(body);
  if (tab === 'roles') renderRolesTab(body);
  if (tab === 'look') renderAppearanceTab(body);
}

function renderAccountTab(el) {
  const u = me(), r = myRole();
  const preview = avatar(u, false);
  const status = h('input', { type: 'text', value: u.status || '', maxlength: 60, placeholder: 'What are you up to?' });
  const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', hidden: true });
  file.addEventListener('change', async () => {
    const f = file.files[0]; file.value = '';
    if (!f) return;
    if (!/^image\/(png|jpeg|gif|webp)$/.test(f.type) || f.size > 5 * 1024 * 1024) return toast('Use a PNG, JPG, GIF or WEBP under 5 MB');
    const dataUrl = await new Promise((res, rej) => { const rd = new FileReader(); rd.onload = () => res(rd.result); rd.onerror = rej; rd.readAsDataURL(f); });
    await attempt(async () => {
      const up = await api('/upload', 'POST', { data: dataUrl });
      await api('/me', 'PATCH', { avatar: up.url });
      await refresh(); openSettings('account');
    });
  });
  el.append(h('h2', {}, 'My Account'),
    h('div', { class: 'avatar-edit' }, preview,
      h('div', { class: 'col' },
        h('button', { class: 'btn small', onclick: () => file.click() }, 'Upload picture'),
        u.avatar ? h('button', { class: 'btn small ghost', onclick: () => attempt(async () => { await api('/me', 'PATCH', { avatar: null }); await refresh(); openSettings('account'); }) }, 'Remove') : null,
        file)),
    h('div', { class: 'field' }, h('label', {}, 'USERNAME'), h('div', {}, u.username)),
    h('div', { class: 'field' }, h('label', {}, 'STATUS'), status,
      h('div', { style: 'margin-top:8px' }, h('button', { class: 'btn primary small', onclick: () => attempt(async () => { await api('/me', 'PATCH', { status: status.value }); await refresh(); toast2('Saved'); }) }, 'Save status'))),
    h('div', { class: 'field' }, h('label', {}, 'ROLE'),
      h('span', { class: 'pill', style: `border-color:${r.color}` }, h('span', { class: 'dot', style: `background:${r.color}` }), r.name)),
    h('div', { class: 'field' }, h('label', {}, 'PERMISSIONS'),
      h('div', { class: 'note' }, r.id === 'owner' || r.id === 'admin' ? 'Everything.' : r.perms.length ? r.perms.map((p) => PERM_INFO[p][0]).join(', ') : 'Chat, react, reply and upload images.')),
    h('div', { class: 'field' }, h('label', {}, 'CHAT TRICKS'),
      h('div', { class: 'note' }, 'Type @name to mention someone. Slash commands: /roll [sides], /flip, /8ball question, /shrug.')));
}

function renderAppearanceTab(el) {
  const current = SKINS[pref('skin')] ? pref('skin') : 'warms';
  const accent = h('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(pref('accent') || '') ? pref('accent') : '#7289da', style: 'width:60px;height:36px;border:0;background:none;padding:0' });
  accent.addEventListener('input', () => { pref('accent', accent.value); applySkin(); });
  el.append(h('h2', {}, 'Appearance'),
    h('div', { class: 'field' }, h('label', {}, 'THEME'),
      h('div', { class: 'skins' }, Object.entries(SKINS).map(([id, [label, sw]]) =>
        h('button', { class: 'skin' + (id === current ? ' active' : ''), onclick: () => { pref('skin', id); pref('accent', null); applySkin(); openSettings('look'); } },
          h('span', { class: 'sw' }, sw.map((c) => h('i', { style: `background:${c}` }))),
          h('span', { class: 'sn' }, label))))),
    h('div', { class: 'field' }, h('label', {}, 'ACCENT COLOR'), accent,
      h('div', { style: 'margin-top:8px' }, h('button', { class: 'btn small', onclick: () => { pref('accent', null); applySkin(); openSettings('look'); } }, 'Reset to theme'))),
    h('div', { class: 'note' }, 'Your look is saved on this device only. Other people keep their own.'));
}

// Lets the Owner / Admins upload or remove the picture shown on the far-left bar.
function iconEditor(spaceId, current, reopen) {
  const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', hidden: true });
  file.addEventListener('change', async () => {
    const f = file.files[0]; file.value = '';
    if (!f) return;
    if (!/^image\/(png|jpeg|gif|webp)$/.test(f.type) || f.size > 5 * 1024 * 1024) return toast('Use a PNG, JPG, GIF or WEBP under 5 MB');
    const dataUrl = await new Promise((res, rej) => { const rd = new FileReader(); rd.onload = () => res(rd.result); rd.onerror = rej; rd.readAsDataURL(f); });
    attempt(async () => {
      const up = await api('/upload', 'POST', { data: dataUrl });
      await api(`/spaces/${spaceId}/icon`, 'PUT', { icon: up.url });
      await refresh(); reopen(); toast2('Picture updated');
    });
  });
  return h('div', { class: 'field' }, h('label', {}, 'PICTURE (SHOWN ON THE FAR-LEFT BAR)'),
    h('div', { class: 'avatar-edit' },
      h('div', { class: 'icon-prev' }, current ? h('img', { src: current, alt: '' }) : h('span', {}, 'None')),
      h('div', { class: 'col' },
        h('button', { class: 'btn small', onclick: () => file.click() }, current ? 'Change picture' : 'Upload picture'),
        current ? h('button', { class: 'btn small ghost', onclick: () => attempt(async () => { await api(`/spaces/${spaceId}/icon`, 'PUT', { icon: null }); await refresh(); reopen(); }) }, 'Remove') : null,
        file)));
}

function renderServerTab(el) {
  if (state.spaceId === ANN_SPACE) { el.append(h('h2', {}, 'Announcements'), h('div', { class: 'note' }, 'This is shared by everyone. Only the Owner can post here.'), isAdmin() ? iconEditor(ANN_SPACE, state.annIcon, () => openSettings('server')) : null); return; }
  const sp = curSpace();
  const input = h('input', { type: 'text', value: sp.name, maxlength: 32 });
  const isFirst = sp.id === state.spaces[0].id;
  el.append(h('h2', {}, 'Space'),
    h('div', { class: 'field' }, h('label', {}, 'SPACE NAME'), input),
    isAdmin() ? iconEditor(sp.id, sp.icon, () => openSettings('server')) : null,
    h('button', { class: 'btn primary small', onclick: () => attempt(async () => { await api('/server', 'PATCH', { name: input.value, spaceId: sp.id }); toast2('Saved'); }) }, 'Save'),
    isAdmin() && !isFirst ? h('div', { class: 'field', style: 'margin-top:24px' }, h('label', {}, 'DANGER ZONE'),
      h('button', { class: 'btn danger small', onclick: async () => {
        if (await confirmBox('Delete ' + sp.name + '?', 'Every chat and message in this space will be deleted for good.', 'Delete space')) {
          attempt(async () => { closeOverlay(); await api('/spaces/' + sp.id, 'DELETE'); await refresh(); toast2('Space deleted'); });
        }
      } }, 'Delete this space')) : null);
}
function toast2(t) { const x = h('div', { class: 'toast', style: 'border-left-color:#43b581' }, t); document.body.append(x); setTimeout(() => x.remove(), 2000); }

let selectedRoleId = null;
async function renderRolesTab(el) {
  el.replaceChildren();
  const ordered = state.roles.slice().sort((a, b) => a.position - b.position);
  if (!selectedRoleId || !state.roles.some((r) => r.id === selectedRoleId)) selectedRoleId = ordered[0].id;
  const sel = roleById(selectedRoleId);
  const editable = (r) => isOwner() || myRole().position < r.position;
  const movable = ordered.filter((r) => !['owner', 'admin', 'member'].includes(r.id));

  const reload = async () => { await refresh(); renderRolesTab(el); };

  const list = h('div', { class: 'roles-list' },
    ordered.map((r) => {
      const i = movable.indexOf(r);
      return h('div', { class: 'role-row' + (r.id === selectedRoleId ? ' active' : ''), onclick: () => { selectedRoleId = r.id; renderRolesTab(el); } },
        h('span', { class: 'dot', style: `background:${r.color}` }),
        h('span', { class: 'rname' }, r.name),
        i > -1 && editable(r) ? h('button', { class: 'mv', title: 'Move up', disabled: i === 0, onclick: (e) => { e.stopPropagation(); attempt(async () => { await api(`/roles/${r.id}/move`, 'POST', { dir: 'up' }); await reload(); }); } }, '▲') : null,
        i > -1 && editable(r) ? h('button', { class: 'mv', title: 'Move down', disabled: i === movable.length - 1, onclick: (e) => { e.stopPropagation(); attempt(async () => { await api(`/roles/${r.id}/move`, 'POST', { dir: 'down' }); await reload(); }); } }, '▼') : null);
    }),
    h('button', { class: 'btn small', style: 'margin-top:12px;width:100%', onclick: async () => {
      const name = await ask('Create role', 'Role name');
      if (!name) return;
      attempt(async () => { const r = await api('/roles', 'POST', { name, color: '#99aab5', perms: [] }); selectedRoleId = r.id; await reload(); openSettings('roles'); });
    } }, '+ Create role'));

  const canEdit = editable(sel);
  const nameIn = h('input', { type: 'text', value: sel.name, maxlength: 24, disabled: !canEdit });
  const colorIn = h('input', { type: 'color', value: sel.color, disabled: !canEdit, style: 'width:60px;height:36px;border:0;background:none;padding:0' });
  const checks = {};
  const permRows = state.perms.map((p) => {
    const locked = sel.id === 'owner' || sel.id === 'admin' || !canEdit || (!isAdmin() && !sel.perms.includes(p) && !myRole().perms.includes(p));
    const cb = h('input', { type: 'checkbox', checked: sel.id === 'owner' || sel.id === 'admin' || sel.perms.includes(p), disabled: locked });
    checks[p] = cb;
    return h('label', { class: 'perm' + (locked ? ' locked' : '') }, cb,
      h('div', {}, h('div', { class: 'pt' }, PERM_INFO[p][0]), h('div', { class: 'pd' }, PERM_INFO[p][1])));
  });

  const edit = h('div', { class: 'role-edit' },
    h('h2', {}, sel.name),
    sel.id === 'owner' ? h('div', { class: 'note' }, 'The Owner always has every permission. The first person to register is the Owner.') : null,
    sel.id === 'admin' ? h('div', { class: 'note' }, 'Admins have every permission except Owner powers. Only the Owner can make someone an Admin.') : null,
    !canEdit && sel.id !== 'owner' && sel.id !== 'admin' ? h('div', { class: 'note' }, 'You can only edit roles ranked below your own.') : null,
    h('div', { class: 'field' }, h('label', {}, 'ROLE NAME'), nameIn),
    h('div', { class: 'field' }, h('label', {}, 'COLOR'), colorIn),
    h('div', { class: 'field' }, h('label', {}, 'PERMISSIONS'), permRows),
    canEdit ? h('div', { style: 'display:flex;gap:8px' },
      h('button', { class: 'btn primary small', onclick: () => attempt(async () => {
        const perms = state.perms.filter((p) => checks[p].checked);
        await api('/roles/' + sel.id, 'PATCH', { name: nameIn.value, color: colorIn.value, perms });
        await reload(); toast2('Saved');
      }) }, 'Save changes'),
      !['owner', 'admin', 'member'].includes(sel.id)
        ? h('button', { class: 'btn danger small', onclick: async () => {
            if (await confirmBox('Delete role "' + sel.name + '"?', 'Anyone with this role goes back to Member.')) {
              attempt(async () => { await api('/roles/' + sel.id, 'DELETE'); selectedRoleId = null; await refresh(); openSettings('roles'); });
            }
          } }, 'Delete role') : null) : null);

  el.append(h('h2', {}, 'Roles'),
    h('div', { class: 'note' }, 'Higher roles are listed first. To give someone a role, click their name in the member list.'),
    h('div', { class: 'roles-layout' }, list, edit));
}

/* ------------------------------------------------------- admin panel */

const adminLog = [];       // { kind: 'cmd' | 'ok' | 'err' | 'info', text }
const adminHistory = [];
let adminHistoryAt = 0;

async function runAdminCommand(command, termEl) {
  if (!command.trim()) return;
  adminHistory.push(command);
  adminHistoryAt = adminHistory.length;
  adminLog.push({ kind: 'cmd', text: command });
  try {
    const res = await api('/admin/command', 'POST', { command });
    for (const line of res.output) adminLog.push({ kind: res.ok === false ? 'err' : 'out', text: line });
  } catch (e) {
    if (e.message === 'Signed out') return;
    adminLog.push({ kind: 'err', text: e.message });
  }
  drawTerm(termEl);
}

function drawTerm(termEl) {
  if (!termEl.isConnected) return;
  termEl.replaceChildren(...adminLog.map((l) => h('div', { class: 'tl ' + l.kind }, l.kind === 'cmd' ? '> ' + l.text : l.text)));
  termEl.scrollTop = termEl.scrollHeight;
}

/* --------------------------------------------------- command center */

const NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  for (const kid of kids.flat()) if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const niceMax = (m) => { if (m <= 4) return 4; const p = 10 ** Math.floor(Math.log10(m)); const f = m / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; };
function ago(ts) {
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 60) return 'just now';
  if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
  if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
  return Math.floor(sec / 86400) + 'd ago';
}
function countUp(el, to) {
  const from = el._v || 0;
  el._v = to;
  if (from === to || (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches)) { el.textContent = to.toLocaleString(); return; }
  const t0 = performance.now(), dur = 900;
  const tick = (t) => {
    const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
    el.textContent = Math.round(from + (to - from) * e).toLocaleString();
    if (k < 1 && el.isConnected) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function closeCommandCenter() { const el = $('cc'); if (el) el.remove(); }

function openCommandCenter() {
  closeCommandCenter();
  const els = {};
  let n = 0;
  const panel = (cls, ...kids) => h('section', { class: 'panel ' + cls, style: `--n:${n++}` }, kids);
  const stat = (key, label, glyph) => {
    els[key] = h('div', { class: 'num' }, '0');
    els[key + 'Hint'] = h('div', { class: 'hint' }, ' ');
    return panel('s3 stat', h('div', { class: 'glyph' }, glyph), h('h3', {}, label), els[key], els[key + 'Hint']);
  };

  els.chart = h('div', { class: 'chart' });
  els.roles = h('div', { class: 'donut-wrap' });
  els.chans = h('div', { class: 'bars' });
  els.posters = h('div', { class: 'bars' });
  els.onlineList = h('div', { class: 'live-list' });
  els.audit = h('div', { class: 'audit' });
  els.activityHint = h('em', {}, '');

  // broadcast composer
  const box = h('textarea', { maxlength: 500, placeholder: 'Write something everyone will see…', 'aria-label': 'Global message' });
  const prev = h('div', { class: 'preview dim' }, 'Preview appears here');
  box.addEventListener('input', () => {
    const t = box.value.trim();
    prev.className = 'preview' + (t ? '' : ' dim');
    prev.replaceChildren(...(t ? [h('span', { class: 'b-tag' }, 'ANNOUNCEMENT'), h('span', { class: 'b-text' }, t)] : ['Preview appears here']));
  });
  const sendBtn = h('button', { class: 'cc-btn', type: 'button' }, 'Send to everyone');
  const term = h('div', { class: 'term', role: 'log', 'aria-live': 'polite' });
  const run = async (c) => { await runAdminCommand(c, term); load(); };
  sendBtn.onclick = async () => {
    const t = box.value.trim();
    if (!t) return;
    box.value = ''; box.dispatchEvent(new Event('input'));
    await run('announce ' + t);
    sendBtn.classList.add('sent'); sendBtn.textContent = 'Sent ✓';
    setTimeout(() => { sendBtn.classList.remove('sent'); sendBtn.textContent = 'Send to everyone'; }, 2000);
  };

  if (!adminLog.length) adminLog.push({ kind: 'info', text: 'Admin console. Type help to see every command.' });
  const input = h('input', { type: 'text', class: 'term-in', placeholder: 'role Priya Moderator', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Command' });
  const form = h('form', { class: 'term-form', onsubmit: (e) => { e.preventDefault(); const c = input.value; input.value = ''; run(c); } }, h('span', { class: 'prompt' }, '>'), input);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' && adminHistory.length) { e.preventDefault(); adminHistoryAt = Math.max(0, adminHistoryAt - 1); input.value = adminHistory[adminHistoryAt]; }
    if (e.key === 'ArrowDown' && adminHistory.length) { e.preventDefault(); adminHistoryAt = Math.min(adminHistory.length, adminHistoryAt + 1); input.value = adminHistory[adminHistoryAt] || ''; }
  });
  const chips = ['help', 'stats', 'who', 'users', 'channels'].map((c) => h('button', { class: 'chip', type: 'button', onclick: () => run(c) }, c));

  const cc = h('div', { class: 'cc', id: 'cc', role: 'dialog', 'aria-label': 'Command Center' },
    h('div', { class: 'cc-bg' }, h('i', { class: 'orb o1' }), h('i', { class: 'orb o2' })),
    h('header', { class: 'cc-top' },
      h('span', { class: 'cc-title' }, 'Command Center'),
      h('span', { class: 'cc-server' }, state.serverName),
      h('span', { class: 'live' }, h('i'), 'LIVE'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'cc-close', onclick: closeCommandCenter }, 'Close  ✕')),
    h('main', { class: 'cc-grid' },
      stat('members', 'MEMBERS', '👥'), stat('online', 'ONLINE NOW', '🟢'), stat('messages', 'MESSAGES', '💬'), stat('channels', 'CHANNELS', '#'),
      panel('s8', h('h3', {}, 'Activity · last 24 hours', els.activityHint), els.chart),
      panel('s4', h('h3', {}, 'Roles'), els.roles),
      panel('s4', h('h3', {}, 'Busiest channels'), els.chans),
      panel('s4', h('h3', {}, 'Top posters'), els.posters),
      panel('s4', h('h3', {}, 'Online now'), els.onlineList),
      panel('s6 bc', h('h3', {}, 'Global message', h('em', {}, 'posts in every channel + banner')), box, prev, sendBtn),
      panel('s6', h('h3', {}, 'Console'), h('div', { class: 'chips' }, chips), term, form),
      panel('s12', h('h3', {}, 'Audit log', h('em', {}, 'what admins did')), els.audit)));
  document.body.append(cc);
  drawTerm(term);

  function paint(d) {
    countUp(els.members, d.members);
    els.membersHint.replaceChildren(h('b', {}, '+' + d.newMembers7d), ' this week');
    countUp(els.online, d.online);
    els.onlineHint.textContent = d.members ? Math.round((d.online / d.members) * 100) + '% of members' : ' ';
    countUp(els.messages, d.messages);
    els.messagesHint.replaceChildren(h('b', {}, d.messages24h.toLocaleString()), ' in the last 24h');
    countUp(els.channels, d.channels.length);
    const top = d.channels.slice().sort((x, y) => y.count - x.count)[0];
    els.channelsHint.textContent = top ? 'busiest: #' + top.name : ' ';

    // activity bar chart: one scale for bars, grid and labels
    const W = 640, H = 200, L = 34, R = 6, T = 10, B = 24, pw = W - L - R, ph = H - T - B;
    const max = niceMax(Math.max(...d.buckets, 1));
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Messages per hour over the last 24 hours, peak ${Math.max(...d.buckets)}` });
    svg.append(s('defs', {}, s('linearGradient', { id: 'ccg', x1: 0, y1: 1, x2: 0, y2: 0 },
      s('stop', { offset: '0', style: 'stop-color:var(--accent)' }), s('stop', { offset: '1', style: 'stop-color:#3de0ff' }))));
    for (const v of [0, max / 2, max]) {
      const y = T + ph - (v / max) * ph;
      svg.append(s('line', { class: 'grid', x1: L, x2: W - R, y1: y, y2: y }), s('text', { x: L - 6, y: y + 3, 'text-anchor': 'end' }, v));
    }
    const bw = pw / 24;
    d.buckets.forEach((v, i) => {
      const x = L + i * bw + bw * 0.19, w = bw * 0.62, hh = (v / max) * ph;
      const start = d.now - (24 - i) * 3600000;
      const label = new Date(start).toLocaleTimeString([], { hour: 'numeric' });
      svg.append(s('rect', { class: 'track', x, y: T, width: w, height: ph, rx: 3 }));
      if (v > 0) svg.append(s('rect', { class: 'bar' + (i === 23 ? ' now' : ''), x, y: T + ph - hh, width: w, height: hh, rx: 3, fill: 'url(#ccg)', style: `animation-delay:${i * 22}ms` }, s('title', {}, `${label}: ${v} message${v === 1 ? '' : 's'}`)));
      if (i % 4 === 0) svg.append(s('text', { x: x + w / 2, y: H - 6, 'text-anchor': 'middle' }, label));
    });
    els.chart.replaceChildren(svg);
    els.activityHint.textContent = `peak ${Math.max(...d.buckets)}/hour`;

    // role donut
    const total = d.roles.reduce((q, r) => q + r.count, 0) || 1, C = 2 * Math.PI * 42;
    const donut = s('svg', { class: 'donut', viewBox: '0 0 120 120', role: 'img', 'aria-label': 'Members by role' });
    donut.append(s('circle', { cx: 60, cy: 60, r: 42, fill: 'none', stroke: 'rgba(255,255,255,.07)', 'stroke-width': 14 }));
    let acc = 0;
    for (const r of d.roles) {
      if (!r.count) continue;
      const len = (r.count / total) * C;
      donut.append(s('circle', { cx: 60, cy: 60, r: 42, fill: 'none', stroke: r.color, 'stroke-width': 14, 'stroke-dasharray': `${Math.max(0, len - 2)} ${C - Math.max(0, len - 2)}`, 'stroke-dashoffset': -acc, transform: 'rotate(-90 60 60)' }));
      acc += len;
    }
    donut.append(s('text', { class: 'big', x: 60, y: 63 }, d.members), s('text', { class: 'sm', x: 60, y: 77 }, 'MEMBERS'));
    els.roles.replaceChildren(donut, h('div', { class: 'legend' }, d.roles.map((r) => h('div', {}, h('i', { style: `background:${r.color}` }), r.name, h('span', { class: 'n' }, r.count)))));

    const bars = (list, unit, hash) => {
      const m = Math.max(...list.map((x) => x.count), 1);
      return list.length ? list.map((x) => h('div', { class: 'brow' },
        h('div', { class: 'top' }, h('span', {}, (hash ? '#' : '') + (x.name || x.username)), h('span', {}, x.count.toLocaleString() + ' ' + unit)),
        h('div', { class: 'track' }, h('div', { class: 'fill', style: `width:${(x.count / m) * 100}%` })))) : [h('div', { class: 'empty' }, 'Nothing yet')];
    };
    els.chans.replaceChildren(...bars(d.channels.slice().sort((x, y) => y.count - x.count).slice(0, 5), 'msgs', true));
    els.posters.replaceChildren(...bars(d.topPosters, 'msgs', false));

    els.onlineList.replaceChildren(...(d.onlineUsers.length ? d.onlineUsers.map((u) => h('div', { class: 'live-chip' }, avatar({ username: u.username, avatar: u.avatar }, false), h('span', { style: `color:${roleById(u.roleId).color}` }, u.username))) : [h('div', { class: 'empty' }, 'Nobody online')]));
    els.audit.replaceChildren(...(d.audit.length ? d.audit.map((a) => h('div', { class: 'row' }, h('span', { class: 'when' }, ago(a.ts)), h('span', {}, h('b', {}, a.by), ' ' + a.text))) : [h('div', { class: 'empty' }, 'No admin activity yet. Role changes, removals and console commands show up here.')]));
  }

  async function load() { try { paint(await api('/admin/overview')); } catch (e) { if (e.message !== 'Signed out') toast(e.message); } }
  load();
  const timer = setInterval(() => { if (!cc.isConnected) clearInterval(timer); else load(); }, 4000);
}

$('adminBtn').onclick = openCommandCenter;

/* ------------------------------------------------------- staff panel */

function closeStaffPanel() { const el = $('staffcc'); if (el) el.remove(); onStateChange = null; }

function openStaffPanel() {
  closeStaffPanel();
  const role = myRole();
  const showMembers = can('manage_users') || can('manage_roles');
  const showMsgs = can('delete_messages');
  const showChans = can('manage_channels');
  const els = {};
  let n = 0;
  const panel = (cls, ...kids) => h('section', { class: 'panel ' + cls, style: `--n:${n++}` }, kids);
  const stat = (key, label, glyph) => {
    els[key] = h('div', { class: 'num' }, '0');
    els[key + 'Hint'] = h('div', { class: 'hint' }, ' ');
    return panel('s4 stat', h('div', { class: 'glyph' }, glyph), h('h3', {}, label), els[key], els[key + 'Hint']);
  };
  // run an action, then reload shared state so every list repaints
  const act = async (fn) => { await attempt(fn); await attempt(refresh); loadLog(); };
  const canKick = (u) => can('manage_users') && u.id !== state.me && u.roleId !== 'owner' && outranksUser(me(), u);

  /* members */
  const search = h('input', { type: 'text', class: 's-in', placeholder: 'Search members…', 'aria-label': 'Search members' });
  const rows = h('div', { class: 'srows' });
  const memberRow = (u) => {
    const r = roleById(u.roleId), left = muteMinutes(u), actions = [];
    const opts = u.id !== state.me ? assignableRoles(u) : [];
    if (opts.length) {
      actions.push(h('select', { class: 's-sel', 'aria-label': 'Role for ' + u.username, onchange: (e) => act(() => api(`/users/${u.id}/role`, 'PUT', { roleId: e.target.value })) },
        opts.map((o) => h('option', { value: o.id, selected: o.id === u.roleId }, o.name)),
        opts.some((o) => o.id === u.roleId) ? null : h('option', { value: u.roleId, selected: true, disabled: true }, r.name)));
    }
    if (canKick(u)) {
      if (left) actions.push(h('button', { class: 'mini', onclick: () => act(() => api(`/users/${u.id}/mute`, 'PUT', { minutes: 0 })) }, 'Unmute'));
      else actions.push(h('select', { class: 's-sel', 'aria-label': 'Mute ' + u.username, onchange: (e) => { const m = parseInt(e.target.value, 10); e.target.value = ''; if (m) act(() => api(`/users/${u.id}/mute`, 'PUT', { minutes: m })); } },
        h('option', { value: '' }, 'Mute…'),
        [[5, '5 minutes'], [15, '15 minutes'], [60, '1 hour'], [1440, '24 hours']].map(([m, l]) => h('option', { value: m }, l))));
      actions.push(h('button', { class: 'mini danger', onclick: async () => {
        if (await confirmBox('Remove ' + u.username + '?', 'Their account will be deleted and they will be signed out. They can register again.', 'Remove')) act(() => api('/users/' + u.id, 'DELETE'));
      } }, 'Remove'));
    }
    return h('div', { class: 'srow' }, avatar(u, true),
      h('div', { class: 'sname' }, h('span', { class: 'nm', style: `color:${r.color}` }, u.username), roleTag(r), left ? h('span', { class: 'muted-chip' }, `muted · ${left}m`) : null),
      h('div', { class: 'sact' }, actions));
  };
  const paintMembers = () => {
    const q = search.value.trim().toLowerCase();
    const list = state.users.slice().sort((a, b) => roleById(a.roleId).position - roleById(b.roleId).position || a.username.localeCompare(b.username))
      .filter((u) => !q || u.username.toLowerCase().includes(q)).map(memberRow);
    rows.replaceChildren(...(list.length ? list : [h('div', { class: 'empty' }, 'No one matches')]));
  };
  search.addEventListener('input', paintMembers);

  /* message moderation */
  const chSel = h('select', { class: 's-sel', 'aria-label': 'Channel filter' }, h('option', { value: 'all' }, 'All channels'), state.channels.map((c) => h('option', { value: c.id }, '#' + c.name)));
  const mq = h('input', { type: 'text', class: 's-in', placeholder: 'Search text or author…', 'aria-label': 'Search messages' });
  const mrows = h('div', { class: 'mrows' });
  const loadMsgs = async () => {
    if (!showMsgs || !mrows.isConnected) return;
    try {
      const list = await api(`/staff/messages?channel=${encodeURIComponent(chSel.value)}&q=${encodeURIComponent(mq.value.trim())}`);
      mrows.replaceChildren(...(list.length ? list.map((m) => h('div', { class: 'mrow' },
        h('div', { class: 'mmain' },
          h('div', { class: 'mmeta' }, h('b', {}, m.username), m.announce ? h('span', { class: 'tag' }, 'ANNOUNCEMENT') : null, h('span', { class: 'dim' }, ` #${m.channel} · ${ago(m.ts)}`)),
          h('div', { class: 'mtxt' }, m.content || (m.image ? '(image)' : ''))),
        h('button', { class: 'mini danger', onclick: async () => { await attempt(() => api('/messages/' + m.id, 'DELETE')); loadMsgs(); loadLog(); } }, 'Delete'))) : [h('div', { class: 'empty' }, 'No messages found')]));
    } catch (e) { if (e.message !== 'Signed out') toast(e.message); }
  };
  let mTimer = null;
  mq.addEventListener('input', () => { clearTimeout(mTimer); mTimer = setTimeout(loadMsgs, 250); });
  chSel.addEventListener('change', loadMsgs);

  /* channels + server name */
  const crows = h('div', { class: 'srows' });
  const newCh = h('input', { type: 'text', class: 's-in', placeholder: 'new-channel', maxlength: 32, 'aria-label': 'New channel name' });
  const srvName = h('input', { type: 'text', class: 's-in', value: state.serverName, maxlength: 32, 'aria-label': 'Server name' });
  const paintChannels = () => {
    crows.replaceChildren(...inSpace(state.spaceId).map((c) => h('div', { class: 'srow' }, h('span', { class: 'hash' }, '#'),
      h('div', { class: 'sname' }, h('span', { class: 'nm' }, c.name)),
      inSpace(state.spaceId).filter((x) => !x.locked).length > 1 && !c.locked ? h('button', { class: 'mini danger', onclick: async () => {
        if (await confirmBox('Delete #' + c.name + '?', 'All messages in this channel will be deleted for good.')) act(() => api('/channels/' + c.id, 'DELETE'));
      } }, 'Delete') : null)));
  };

  /* powers + staff log */
  els.log = h('div', { class: 'audit' });
  const loadLog = async () => {
    try {
      const d = await api('/staff/overview');
      els.log.replaceChildren(...(d.audit.length ? d.audit.map((x) => h('div', { class: 'row' }, h('span', { class: 'when' }, ago(x.ts)), h('span', {}, h('b', {}, x.by), ' ' + x.text))) : [h('div', { class: 'empty' }, 'No staff actions yet. Mutes, removals and deletions show up here.')]));
    } catch (e) { if (e.message !== 'Signed out') toast(e.message); }
  };
  const powers = h('div', { class: 'powers' }, state.perms.map((p) => {
    const has = can(p);
    return h('div', { class: 'pw' + (has ? '' : ' off') }, h('span', { class: 'ck' }, has ? '✓' : '–'), h('div', {}, h('div', { class: 'pt' }, PERM_INFO[p][0]), h('div', { class: 'pd' }, PERM_INFO[p][1])));
  }));

  const msgW = showChans ? 's8' : 's12', chanW = showMsgs ? 's4' : 's12', powW = showMembers ? 's4' : 's12';
  const cc = h('div', { class: 'cc staff', id: 'staffcc', role: 'dialog', 'aria-label': role.name + ' panel', style: `--accent:${role.color}` },
    h('div', { class: 'cc-bg' }, h('i', { class: 'orb o1' }), h('i', { class: 'orb o2' })),
    h('header', { class: 'cc-top' },
      h('span', { class: 'cc-title' }, role.name + ' Panel'),
      h('span', { class: 'cc-server' }, state.serverName),
      h('span', { class: 'spacer' }),
      h('button', { class: 'cc-close', onclick: closeStaffPanel }, 'Close  ✕')),
    h('main', { class: 'cc-grid' },
      stat('online', 'ONLINE NOW', '🟢'), stat('members', 'MEMBERS', '👥'), stat('muted', 'MUTED NOW', '🔇'),
      showMembers ? panel('s8', h('h3', {}, 'Members', h('em', {}, 'only people ranked below you can be changed')), search, rows) : null,
      panel(powW, h('h3', {}, 'Your powers'), powers),
      showMsgs ? panel(msgW, h('h3', {}, 'Message moderation', h('em', {}, 'newest first')), h('div', { class: 'filters' }, chSel, mq), mrows) : null,
      showChans ? panel(chanW, h('h3', {}, 'Channels & server'), crows,
        h('form', { class: 'inline-form', onsubmit: (e) => { e.preventDefault(); const name = newCh.value.trim(); if (!name) return; newCh.value = ''; act(() => api('/channels', 'POST', { name, spaceId: state.spaceId })); } }, newCh, h('button', { class: 'mini', type: 'submit' }, 'Add')),
        h('form', { class: 'inline-form', onsubmit: (e) => { e.preventDefault(); act(() => api('/server', 'PATCH', { name: srvName.value })); } }, srvName, h('button', { class: 'mini', type: 'submit' }, 'Rename'))) : null,
      panel('s12', h('h3', {}, 'Staff log', h('em', {}, 'what staff did recently')), els.log)));
  document.body.append(cc);

  const paintStats = () => {
    countUp(els.online, state.users.filter((u) => u.online).length);
    countUp(els.members, state.users.length);
    const m = state.users.filter((u) => muteMinutes(u)).length;
    countUp(els.muted, m);
    els.onlineHint.textContent = state.users.length ? Math.round((state.users.filter((u) => u.online).length / state.users.length) * 100) + '% of members' : ' ';
    els.membersHint.textContent = role.name + ' view';
    els.mutedHint.textContent = m ? 'quiet for now' : 'nobody is muted';
  };
  onStateChange = () => {
    if (!cc.isConnected) { onStateChange = null; return; }
    paintStats();
    if (showMembers) paintMembers();
    if (showChans) paintChannels();
  };
  onStateChange();
  loadMsgs();
  loadLog();
  const timer = setInterval(() => { if (!cc.isConnected) { clearInterval(timer); return; } loadLog(); loadMsgs(); if (showMembers && !rows.contains(document.activeElement)) paintMembers(); paintStats(); }, 5000);
}

$('staffBtn').onclick = openStaffPanel;

/* ------------------------------------------------- sign-in notices */

function signinToast(name) {
  const old = document.querySelector('.signin-toast');
  if (old) old.remove();
  const t = h('div', { class: 'signin-toast' }, h('i', { class: 'pulse' }), h('b', {}, name), ' signed in');
  document.body.append(t);
  setTimeout(() => t.classList.add('out'), 3200);
  setTimeout(() => t.remove(), 3800);
}

/* ------------------------------------------------------ report a problem */

const REPORT_KINDS = [['bug', 'Something is broken'], ['abuse', 'Report a person'], ['idea', 'Idea or request'], ['other', 'Something else']];
$('reportBtn').onclick = openReport;

function openReport() {
  let kind = 'bug';
  const chips = h('div', { class: 'rep-kinds' }, REPORT_KINDS.map(([id, label]) =>
    h('button', { type: 'button', class: 'rep-kind' + (id === kind ? ' on' : ''), onclick: (e) => { kind = id; chips.querySelectorAll('.rep-kind').forEach((b) => b.classList.toggle('on', b === e.currentTarget)); } }, label)));
  const box = h('textarea', { class: 'rep-text', maxlength: 1500, rows: 6, placeholder: 'What happened? What were you doing? The more detail, the easier it is to fix.' });
  const send = h('button', { type: 'submit', class: 'btn primary small' }, 'Send report');
  const form = h('form', { class: 'modal report', onsubmit: (e) => {
    e.preventDefault();
    if (box.value.trim().length < 5) return toast('Please describe the problem first');
    send.disabled = true;
    attempt(async () => {
      try {
        const r = await api('/reports', 'POST', { kind, message: box.value }); closeOverlay();
        if (r.emailed === false) toast('Saved in your Owner Panel, but the email was NOT sent: ' + (r.mailError || 'unknown error'));
        else toast2(r.emailed ? 'Sent to the Owner and emailed' : 'Thanks! Your report was sent to the Owner');
      }
      finally { send.disabled = false; }
    });
  } },
    h('h2', {}, 'Report a problem'),
    h('p', {}, 'This goes straight to the Owner of the site.'),
    chips, box,
    h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn ghost small', onclick: closeOverlay }, 'Cancel'), send));
  openOverlay(form);
  box.focus();
}

/* ------------------------------------------------------- owner panel */

$('ownerBtn').onclick = openOwnerPanel;

async function openOwnerPanel() {
  if (!isOwner()) return;
  let data, reports = [];
  try { data = await api('/owner/overview'); reports = await api('/owner/reports'); } catch (e) { return toast(e.message); }
  const reopen = () => openOwnerPanel();
  const others = state.users.filter((u) => u.id !== state.me);
  const admins = state.users.filter((u) => u.roleId === 'admin');

  const adminRows = admins.length
    ? admins.map((u) => h('div', { class: 'own-row' }, avatar(u, true), h('span', { class: 'own-name' }, u.username),
        h('button', { class: 'btn small', onclick: () => attempt(async () => { await api(`/users/${u.id}/role`, 'PUT', { roleId: 'member' }); await refresh(); reopen(); }) }, 'Remove admin')))
    : [h('div', { class: 'note' }, 'No admins yet. Pick someone below to make them an Admin.')];

  const promoteSel = h('select', {}, h('option', { value: '' }, 'Choose a member…'),
    others.filter((u) => u.roleId !== 'admin').map((u) => h('option', { value: u.id }, u.username)));
  const makeAdmin = h('button', { class: 'btn primary small', onclick: () => {
    if (!promoteSel.value) return toast('Choose a member first');
    attempt(async () => { await api(`/users/${promoteSel.value}/role`, 'PUT', { roleId: 'admin' }); await refresh(); reopen(); });
  } }, 'Make Admin');

  const open = h('input', { type: 'checkbox', checked: data.registrationOpen });
  open.addEventListener('change', () => attempt(async () => { await api('/owner/settings', 'PUT', { registrationOpen: open.checked }); toast2(open.checked ? 'Sign-ups are open' : 'Sign-ups are closed'); }));
  const welcome = h('input', { type: 'text', value: data.welcomeText, maxlength: 120 });

  const xferSel = h('select', {}, h('option', { value: '' }, 'Choose new Owner…'), others.map((u) => h('option', { value: u.id }, u.username)));
  const xferPass = h('input', { type: 'password', placeholder: 'Your password', autocomplete: 'current-password' });
  const wipeIn = h('input', { type: 'text', placeholder: 'Type the server name to confirm' });

  const panel = h('div', { class: 'ownerp' },
    h('button', { class: 'close', title: 'Close', onclick: closeOverlay }, '✕'),
    h('div', { class: 'own-crown' }, '♛'),
    h('h2', {}, 'Owner Panel'),
    h('p', { class: 'own-sub' }, 'Only you can see this. ' + state.serverName),
    h('div', { class: 'own-stats' },
      h('div', {}, h('b', {}, data.members), h('span', {}, 'members')),
      h('div', {}, h('b', {}, state.users.filter((u) => u.online).length), h('span', {}, 'online')),
      h('div', {}, h('b', {}, admins.length), h('span', {}, 'admins')),
      h('div', {}, h('b', {}, data.sessions), h('span', {}, 'sessions'))),
    h('section', {}, h('h4', {}, 'Admins'), adminRows,
      h('div', { class: 'own-add' }, promoteSel, makeAdmin)),
    h('section', {}, h('h4', {}, 'Reports' + (reports.filter((r) => !r.resolved).length ? ` (${reports.filter((r) => !r.resolved).length} open)` : '')),
      h('div', { class: 'own-add' }, h('button', { class: 'btn small', onclick: () => attempt(async () => {
        const t = await api('/owner/test-email', 'POST');
        if (t.emailed) toast2('Test email sent to ' + t.to + '. Check the inbox and Junk.'); else toast('Test email failed: ' + t.error);
      }) }, 'Send a test email')),
      reports.length ? reports.slice(0, 15).map((r) => h('div', { class: 'own-report' + (r.resolved ? ' done' : '') },
        h('div', { class: 'rr-head' }, h('b', {}, r.username), h('span', { class: 'rr-kind' }, (REPORT_KINDS.find((k) => k[0] === r.kind) || [0, 'Other'])[1]), h('span', { class: 'time' }, fmtStamp(r.ts))),
        h('div', { class: 'rr-msg' }, r.message),
        r.emailed ? h('div', { class: 'rr-mail ok' }, 'Emailed') : r.mailError ? h('div', { class: 'rr-mail bad' }, 'Not emailed: ' + r.mailError) : null,
        h('div', { class: 'rr-act' },
          h('button', { class: 'btn small', onclick: () => attempt(async () => { await api(`/owner/reports/${r.id}/resolve`, 'POST'); reopen(); }) }, r.resolved ? 'Reopen' : 'Mark done'),
          h('button', { class: 'btn small ghost', onclick: () => attempt(async () => { await api(`/owner/reports/${r.id}`, 'DELETE'); reopen(); }) }, 'Delete'))))
        : h('div', { class: 'note' }, 'No reports yet.')),
    h('section', {}, h('h4', {}, 'Sign-ups & welcome'),
      h('label', { class: 'own-check' }, open, ' Allow new people to register'),
      h('div', { class: 'own-add' }, welcome,
        h('button', { class: 'btn small', onclick: () => attempt(async () => { await api('/owner/settings', 'PUT', { welcomeText: welcome.value }); toast2('Welcome message saved'); }) }, 'Save')),
      h('div', { class: 'note' }, 'Use {name} for the new member’s name. Shown to everyone when a brand-new person joins.')),
    h('section', {}, h('h4', {}, 'Security'),
      h('button', { class: 'btn small', onclick: async () => {
        if (await confirmBox('Sign everyone out?', 'Everyone except you will have to log in again.', 'Sign out all')) attempt(async () => { const r = await api('/owner/signout-all', 'POST'); toast2('Signed out ' + r.signedOut + ' session(s)'); });
      } }, 'Sign everyone else out')),
    h('section', {}, h('h4', {}, 'Hand over ownership'),
      h('div', { class: 'note' }, 'You become an Admin and the person you pick becomes the Owner.'),
      h('div', { class: 'own-add' }, xferSel, xferPass),
      h('button', { class: 'btn danger small', style: 'margin-top:8px', onclick: async () => {
        if (!xferSel.value || !xferPass.value) return toast('Choose a member and enter your password');
        if (await confirmBox('Transfer ownership?', 'This takes effect immediately.', 'Transfer')) attempt(async () => { await api('/owner/transfer', 'POST', { userId: xferSel.value, password: xferPass.value }); await refresh(); closeOverlay(); toast2('Ownership transferred'); });
      } }, 'Transfer ownership')),
    h('section', {}, h('h4', {}, 'Danger zone'),
      h('div', { class: 'own-add' }, wipeIn,
        h('button', { class: 'btn danger small', onclick: () => attempt(async () => { await api('/owner/wipe-messages', 'POST', { confirm: wipeIn.value }); toast2('All messages wiped'); await loadMessages(); }) }, 'Wipe all messages'))),
    h('section', {}, h('h4', {}, 'Recent activity'),
      data.audit.length ? data.audit.slice(0, 12).map((a) => h('div', { class: 'own-log' }, h('b', {}, a.by || ''), ' ' + (a.text || ''), h('span', { class: 'time' }, fmtStamp(a.ts))))
        : h('div', { class: 'note' }, 'Nothing yet.')));
  openOverlay(panel);
}


/* ------------------------------------------------------ announcements */

let bannerTimer = null;
function showBanner(by, text, tag = 'ANNOUNCEMENT', kind = '') {
  const b = $('banner');
  clearTimeout(bannerTimer);
  const speaker = state.users.find((u) => u.username === by);
  const words = text.trim().split(/\s+/).filter(Boolean);
  const step = Math.max(35, Math.min(110, Math.floor(2400 / Math.max(1, words.length))));
  const spans = [];
  words.forEach((w, i) => { if (i) spans.push(' '); spans.push(h('span', { class: 'w', style: `--i:${i}` }, w)); });
  b.style.setProperty('--step', step + 'ms');
  b.style.setProperty('--n', words.length);
  b.replaceChildren(
    h('i', { class: 'b-ring' }), h('i', { class: 'b-ring r2' }),
    h('div', { class: 'b-head' },
      h('span', { class: 'b-tag' }, tag),
      h('button', { class: 'icon-btn', title: 'Dismiss', onclick: () => b.classList.add('hidden') }, '✕')),
    h('div', { class: 'b-words' }, spans),
    h('div', { class: 'b-by' }, kind === 'welcome' ? '✦ ' + by + ' just joined' : ['— ', h('b', { class: 'b-name', style: speaker ? `color:${roleById(speaker.roleId).color}` : '' }, by), speaker ? roleTag(roleById(speaker.roleId)) : null]));
  b.classList.toggle('welcome', kind === 'welcome');
  b.classList.remove('hidden');
  b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop');
  bannerTimer = setTimeout(() => b.classList.add('hidden'), Math.min(20000, 6000 + words.length * step + 2000));
}

/* ----------------------------------------------------- entrance intro */

function playIntro() {
  if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const u = me(), r = myRole();
  const title = h('h1', {}, [...state.serverName].map((ch, i) =>
    h('span', { style: `--i:${i}` }, ch === ' ' ? ' ' : ch)));
  const intro = h('div', { class: 'intro', title: 'Click to skip' },
    h('i', { class: 'ring' }), h('i', { class: 'ring' }), h('i', { class: 'ring' }),
    title,
    h('div', { class: 'welcome' },
      h('span', {}, 'Welcome, '),
      h('b', { style: `color:${r.color}` }, u.username)),
    r.id === 'owner' ? h('div', { class: 'admin-badge owner' }, '♛ WELCOME BACK, OWNER')
      : r.id === 'admin' ? h('div', { class: 'admin-badge' }, 'ADMIN ACCESS GRANTED') : null);
  document.body.append(intro);
  let over = false;
  const finish = () => {
    if (over) return; over = true;
    $('app').classList.add('enter');
    intro.classList.add('out');
    setTimeout(() => { intro.remove(); $('app').classList.remove('enter'); }, 1400);
  };
  intro.addEventListener('click', finish);
  setTimeout(finish, 2600);
}

/* ------------------------------------------------------------ voice chat
   Audio goes straight between browsers (WebRTC). The server only passes the handshake along. */

const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] };
const V = { room: null, local: null, peers: new Map(), muted: false, deaf: false, ctx: null, pending: false };
const wsSend = (o) => { if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(o)); };

async function joinVoice(room) {
  if (V.pending) return;
  if (V.room === room) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return toast('Voice needs a secure (https) connection and a browser with microphone support');
  V.pending = true;
  try {
    leaveVoice();
    try {
      V.local = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    } catch (e) { return toast('Could not use your microphone. Allow microphone access for this site and try again.'); }
    V.room = room; V.muted = false; V.deaf = false;
    watchLevel('me', V.local);
    wsSend({ t: 'voice-join', room });
    renderVoice();
  } finally { V.pending = false; }
}

function leaveVoice(silent) {
  if (V.room && !silent) wsSend({ t: 'voice-leave' });
  cleanupVoice();
}

function cleanupVoice() {
  for (const id of [...V.peers.keys()]) dropPeer(id);
  if (V.local) V.local.getTracks().forEach((t) => t.stop());
  V.local = null; V.room = null; V.muted = false; V.deaf = false;
  levels.clear();
  renderVoice();
}

function onVoiceJoined(m) {
  if (V.room !== m.room) return;
  m.peers.forEach((id) => makePeer(id, true));
}

function makePeer(id, initiator) {
  if (V.peers.has(id)) return V.peers.get(id);
  const pc = new RTCPeerConnection(ICE);
  const peer = { pc, audio: null, queue: [], ready: false };
  V.peers.set(id, peer);
  V.local.getTracks().forEach((t) => pc.addTrack(t, V.local));
  pc.onicecandidate = (e) => { if (e.candidate) wsSend({ t: 'voice-signal', to: id, data: { candidate: e.candidate } }); };
  pc.ontrack = (e) => {
    if (!peer.audio) {
      peer.audio = new Audio(); peer.audio.autoplay = true; peer.audio.playsInline = true;
      peer.audio.muted = V.deaf;
      document.body.append(peer.audio); peer.audio.hidden = true;
    }
    peer.audio.srcObject = e.streams[0];
    peer.audio.play().catch(() => {});
    watchLevel(id, e.streams[0]);
  };
  pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') { toast('Voice connection to ' + ((userById(id) || {}).username || 'someone') + ' failed (a strict network may block it)'); dropPeer(id); } };
  if (initiator) {
    pc.onnegotiationneeded = async () => {
      try { await pc.setLocalDescription(await pc.createOffer()); wsSend({ t: 'voice-signal', to: id, data: { sdp: pc.localDescription } }); } catch (e) { /* peer left */ }
    };
  }
  return peer;
}

async function onVoiceSignal(from, data) {
  if (!V.room || !V.local || !data) return;
  const peer = makePeer(from, false);
  const pc = peer.pc;
  try {
    if (data.sdp) {
      await pc.setRemoteDescription(data.sdp);
      peer.ready = true;
      for (const c of peer.queue.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      if (data.sdp.type === 'offer') {
        await pc.setLocalDescription(await pc.createAnswer());
        wsSend({ t: 'voice-signal', to: from, data: { sdp: pc.localDescription } });
      }
    } else if (data.candidate) {
      if (peer.ready) await pc.addIceCandidate(data.candidate).catch(() => {}); else peer.queue.push(data.candidate);
    }
  } catch (e) { /* stale handshake */ }
}

function dropPeer(id) {
  const p = V.peers.get(id);
  if (!p) return;
  V.peers.delete(id);
  p.pc.onicecandidate = p.pc.ontrack = p.pc.onconnectionstatechange = p.pc.onnegotiationneeded = null;
  try { p.pc.close(); } catch (e) { /* already closed */ }
  if (p.audio) { p.audio.srcObject = null; p.audio.remove(); }
  levels.delete(id);
}

function setVoiceState(muted, deaf) {
  V.muted = muted; V.deaf = deaf;
  if (V.local) V.local.getAudioTracks().forEach((t) => { t.enabled = !muted; });
  V.peers.forEach((p) => { if (p.audio) p.audio.muted = deaf; });
  wsSend({ t: 'voice-state', muted, deaf });
  renderVoice();
}

/* "who is talking" ring */
const levels = new Map(); // id -> { analyser, data }
function watchLevel(id, stream) {
  try {
    V.ctx = V.ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (V.ctx.state === 'suspended') V.ctx.resume();
    const src = V.ctx.createMediaStreamSource(stream), analyser = V.ctx.createAnalyser();
    analyser.fftSize = 256; src.connect(analyser);
    levels.set(id, { analyser, data: new Uint8Array(analyser.frequencyBinCount) });
  } catch (e) { /* speaking rings are optional */ }
}
setInterval(() => {
  if (!levels.size) return;
  for (const [id, l] of levels) {
    l.analyser.getByteFrequencyData(l.data);
    let sum = 0; for (const v of l.data) sum += v;
    const talking = sum / l.data.length > 14 && !(id === 'me' && V.muted);
    const uid = id === 'me' ? state.me : id;
    document.querySelectorAll(`[data-vuid="${uid}"]`).forEach((el) => el.classList.toggle('speaking', talking));
  }
}, 150);

function renderVoice() {
  const list = $('voiceList'), bar = $('voiceBar');
  if (!list || !state.voiceChannels) return;
  list.replaceChildren(...(state.voiceChannels || []).filter((c) => !c.spaceId || c.spaceId === state.spaceId).map((c) => {
    const people = (state.voice && state.voice[c.id]) || [];
    return h('div', { class: 'vchan' + (V.room === c.id ? ' on' : '') },
      h('div', { class: 'vhead', title: V.room === c.id ? 'Connected' : 'Join voice', onclick: () => joinVoice(c.id) },
        h('span', { class: 'vico' }, '🔊'), h('span', { class: 'cname' }, c.name), people.length ? h('span', { class: 'vcount' }, people.length) : null),
      people.map((p) => {
        const u = userById(p.userId);
        if (!u) return null;
        return h('div', { class: 'vuser', 'data-vuid': p.userId },
          avatar(u, false), h('span', { class: 'vname' }, u.username),
          p.muted || p.deaf ? h('span', { class: 'vflag', title: p.deaf ? 'Deafened' : 'Muted' }, p.deaf ? '🔇' : '🎙️✕') : null);
      }));
  }));
  bar.classList.toggle('hidden', !V.room);
  if (V.room) {
    const c = state.voiceChannels.find((x) => x.id === V.room);
    const vb = (cls, icon, label, title, fn) => h('button', { class: 'vbtn ' + cls, title, onclick: fn }, h('span', { class: 'vb-ico' }, icon), h('span', { class: 'vb-lbl' }, label));
    bar.replaceChildren(
      h('div', { class: 'vb-info' }, h('div', { class: 'vb-state' }, h('i', { class: 'pulse' }), 'Voice connected'), h('div', { class: 'vb-room' }, c ? '🔊 ' + c.name : '')),
      h('div', { class: 'vb-btns' },
        vb(V.muted ? 'off' : '', V.muted ? '🔇' : '🎤', V.muted ? 'Unmute' : 'Mute', V.muted ? 'You are muted. Click to turn your microphone back on' : 'Turn your microphone off', () => setVoiceState(!V.muted, V.deaf && V.muted ? false : V.deaf)),
        vb(V.deaf ? 'off' : '', V.deaf ? '🙉' : '🎧', V.deaf ? 'Hear' : 'Deafen', V.deaf ? 'You cannot hear anyone. Click to hear again' : 'Stop hearing everyone (also mutes you)', () => setVoiceState(!V.deaf, !V.deaf)),
        vb('leave', '📞', 'Leave', 'Disconnect from this voice channel', () => leaveVoice())));
  }
}
window.addEventListener('beforeunload', () => { if (V.room) wsSend({ t: 'voice-leave' }); });

/* ------------------------------------------------------------------ boot */

(async function boot() {
  if (!state.token) return showAuth();
  try { await start(); } catch (e) { showAuth(); }
})();

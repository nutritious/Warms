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

// Browsers turn a null child into the word "null"; skip empty slots the same way h() does.
const nativeReplace = Element.prototype.replaceChildren;
Element.prototype.replaceChildren = function (...nodes) { return nativeReplace.apply(this, nodes.flat().filter((n) => n != null && n !== false)); };

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

// Avatar that opens the person's profile card (with the Add friend button) when pressed.
function clickableAvatar(user) {
  const a = avatar(user, false);
  a.style.cursor = 'pointer';
  a.addEventListener('click', (e) => showPopover(user, a));
  return a;
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
  if (data.economy) takeEco(data.economy);
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
  loadFriends();
  loadUpdates();
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
    } else if (m.t === 'voice-share-denied') {
      stopShare(); toast(`${userName(m.by)} is already sharing in this channel`);
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
    } else if (m.t === 'updates') {
      attempt(loadUpdates);
    } else if (m.t === 'dm') {
      pushDm(m.msg);
    } else if (m.t === 'dm-del') {
      dmDeleted(m);
    } else if (m.t === 'dm-typing') {
      dmTyping(m.from);
    } else if (m.t === 'friends') {
      if (m.kind === 'request') toast2(`🤝 ${m.from} sent you a friend request`);
      else if (m.kind === 'accepted') toast2(`🎉 ${m.from} is now your friend`);
      attempt(loadFriends);
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
  renderCoins();
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
    return h('button', { class: 'rail-chat' + (sp2.id === state.spaceId ? ' active' : '') + (sp2.icon ? ' has-img' : ''), title: sp2.name, onclick: () => { closeDm(); switchSpace(sp2.id); } },
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
  const pings = state.hiddenPings + Object.values(state.unread).reduce((n, u) => n + u.m, 0) + dmUnreadTotal();
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
        userTag(p),
        p.status ? h('span', { class: 'mstat' }, p.status) : null),
        p.id !== state.me && state.fr && state.fr.friends.includes(p.id)
          ? h('button', { type: 'button', class: 'mem-dm', title: 'Message ' + p.username, onclick: (e) => { e.stopPropagation(); openFriends(p.id); } }, '💬') : null))));
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
    return h('div', { class: 'msg sysmsg' + (msg.bot ? ' bot' : ''), 'data-mid': msg.id },
      h('span', { class: 'sys-arrow' }, '➜'),
      h('span', { class: 'sys-text' }, renderText(msg.content)),
      h('span', { class: 'time' }, fmtStamp(msg.ts)),
      can('delete_messages') ? h('button', { class: 'sys-x', title: 'Delete', onclick: () => attempt(() => api('/messages/' + msg.id, 'DELETE')) }, '✕') : null);
  }
  const author = userById(msg.userId);
  const name = author ? author.username : 'Removed user';
  const color = author ? roleById(author.roleId).color : '#8e9297';
  const grouped = prev && !prev.system && prev.userId === msg.userId && msg.ts - prev.ts < 5 * 60 * 1000 && !msg.announce && !prev.announce && !msg.replyTo;
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
    author ? clickableAvatar(author) : h('div', { class: 'avatar', style: 'background:#555' }, '?'),
    h('div', { class: 'body' },
      reply,
      h('div', { class: 'meta' },
        h('span', { class: 'author', style: `color:${color}`, onclick: (e) => author && showPopover(author, e.currentTarget) }, name),
        author ? roleTag(roleById(author.roleId)) : null,
        author ? userTag(author) : null,
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
  closeDm();
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
$('railAnn').onclick = () => { closeDm(); switchSpace(ANN_SPACE); };

async function removeChannel(c) {
  if (await confirmBox('Delete #' + c.name + '?', 'All messages in this channel will be deleted for good.')) {
    attempt(() => api('/channels/' + c.id, 'DELETE'));
  }
}

/* ------------------------------------------------------- member popover */

function hidePopover() { $('popover').classList.add('hidden'); }
document.addEventListener('mousedown', (e) => { if (!e.target.closest('#popover')) hidePopover(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { hidePopover(); closePicker(); if (!$('overlay').classList.contains('hidden')) closeOverlay(); else if (dmOpen()) closeDm(); else if ($('cc')) closeCommandCenter(); else if ($('staffcc')) closeStaffPanel(); } });

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
      h('div', { class: 'pop-name' }, user.username, userTag(user)),
      h('div', { class: 'pop-sub' }, (user.online ? 'Online' : 'Offline') + ' · Joined ' + new Date(user.createdAt).toLocaleDateString()),
      user.status ? h('div', { class: 'pop-status' }, user.status) : null,
      friendButtons(user),
      h('div', { class: 'pop-sec' }, h('h6', {}, 'Role'),
        options.length
          ? h('select', {
              onchange: (e) => attempt(async () => { await api(`/users/${user.id}/role`, 'PUT', { roleId: e.target.value }); hidePopover(); }),
            }, options.map((r) => h('option', { value: r.id, selected: r.id === user.roleId }, r.name)),
              options.some((r) => r.id === user.roleId) ? null : h('option', { value: user.roleId, selected: true, disabled: true }, role.name))
          : h('span', { class: 'pill', style: `border-color:${role.color}` }, h('span', { class: 'dot', style: `background:${role.color}` }), role.name)),
      staffTagTools(user),
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
    sel.id === 'owner' ? h('div', { class: 'note' }, 'The Owner always has every permission. Registering with the username "Warmaster" makes you the Owner.') : null,
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
  // give / take tags and coins
  const ccWho = h('select', { 'aria-label': 'Member' }, h('option', { value: '' }, 'Choose a member…'), state.users.map((u) => h('option', { value: u.id }, u.username + (u.id === state.me ? ' (you)' : ''))));
  const ccTag = h('select', { 'aria-label': 'Tag or pack' }, h('option', { value: '' }, 'Choose a tag or a whole pack…'),
    ((state.eco && state.eco.packs) || []).map((p) => h('optgroup', { label: `${p.icon} ${p.name}` },
      h('option', { value: 'pack:' + p.id }, `★ Whole ${p.name}`),
      state.eco.tags.filter((t) => t.pack === p.id).map((t) => h('option', { value: t.id }, `${t.icon} ${t.name} (${t.rarity})`)))));
  const ccCoins = h('input', { type: 'number', placeholder: 'Coins (e.g. 500)', step: 1, 'aria-label': 'Coins' });
  const ccGive = (action) => {
    if (!ccWho.value) return toast('Choose a member first');
    if (!ccTag.value) return toast('Choose a tag first');
    const body = ccTag.value.startsWith('pack:') ? { pack: ccTag.value.slice(5), action } : { tag: ccTag.value, action };
    attempt(async () => {
      const r = await api(`/users/${ccWho.value}/tags`, 'POST', body);
      toast2(r.changed.length ? `${action === 'take' ? 'Took' : 'Gave'} ${r.changed.length > 2 ? r.changed.length + ' tags' : r.changed.join(', ')} ${action === 'take' ? 'from' : 'to'} ${r.username}` : `${r.username} ${action === 'take' ? "doesn't have" : 'already has'} that`);
      load();
    });
  };
  const ccCoinGo = () => {
    const who = state.users.find((u) => u.id === ccWho.value), n = parseInt(ccCoins.value, 10);
    if (!who) return toast('Choose a member first');
    if (!n) return toast('Enter how many coins (a minus takes coins away)');
    ccCoins.value = ''; run(`givecoins "${who.username}" ${n}`);
  };
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
      panel('s6 gift', h('h3', {}, 'Give tags & coins', h('em', {}, 'pick a member')), ccWho, ccTag,
        h('div', { class: 'cc-row' }, h('button', { class: 'cc-btn', type: 'button', onclick: () => ccGive('give') }, '🎁 Give tag'), h('button', { class: 'chip', type: 'button', onclick: () => ccGive('take') }, 'Take back')),
        h('div', { class: 'cc-row' }, ccCoins, h('button', { class: 'cc-btn', type: 'button', onclick: ccCoinGo }, '🪙 Give coins'))),
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
    if (left && !canKick(u) && isAdmin() && u.id !== state.me) actions.push(h('button', { class: 'mini', onclick: () => act(() => api(`/users/${u.id}/mute`, 'PUT', { minutes: 0 })) }, 'Unmute'));
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

/* ------------------------------------------------------ shop: coins, wheel, packs */

const RARITY_COLOR = { common: '#aab0b8', uncommon: '#4ade80', rare: '#38bdf8', epic: '#c084fc', legendary: '#fbbf24', croma: '#ff5fd2' };
const RARITY_ORDER = ['croma', 'legendary', 'epic', 'rare', 'uncommon', 'common'];
const tagDef = (id) => ((state.eco && state.eco.tags) || []).find((t) => t.id === id);
let shopPack = 'halloween';

// Small pill with a profile tag the person chose to show.
function userTag(u) {
  const t = u && u.tag && tagDef(u.tag);
  if (!t) return null;
  const c = RARITY_COLOR[t.rarity] || '#aab0b8';
  return h('span', Object.assign({ class: 'utag r-' + t.rarity, title: t.rarity + ' tag' },
    t.rarity === 'croma' ? {} : { style: `color:${c};border-color:color-mix(in srgb, ${c} 60%, transparent);background:color-mix(in srgb, ${c} 14%, transparent)` }),
    (t.icon ? t.icon + ' ' : '') + t.name);
}

const ECO_KEYS = ['coins', 'nextSpinAt', 'owned', 'equipped', 'cost', 'baseCost', 'events', 'tags', 'packs', 'rarities', 'wheel'];
function takeEco(r) {
  const eco = state.eco || {};
  for (const k of ECO_KEYS) if (r[k] !== undefined) eco[k] = r[k];
  if (r.now) eco.skew = Date.now() - r.now;
  state.eco = eco;
  renderCoins();
}
const ecoNow = () => Date.now() - ((state.eco && state.eco.skew) || 0);
const evLeft = (e) => Math.max(0, e.until - ecoNow());
const liveEvents = () => ((state.eco && state.eco.events) || []).filter((e) => evLeft(e) > 0);
const spinWait = () => (state.eco && state.eco.nextSpinAt ? Math.max(0, state.eco.nextSpinAt - ecoNow()) : 0);
function renderCoins() {
  const b = $('coinBtn');
  if (!b || !state.eco) return;
  b.replaceChildren(h('span', { class: 'coin-ico' }, '🛍️'), h('span', { class: 'coin-lbl' }, 'Shop'), h('span', { class: 'coin-n' }, '🪙 ' + state.eco.coins));
  b.classList.toggle('ready', spinWait() === 0);
  b.classList.toggle('hot', liveEvents().length > 0);
  b.title = spinWait() === 0 ? 'Shop: your daily spin is ready!' : 'Shop: coins, wheel and tag packs';
}
function fmtWait(ms) {
  const s = Math.ceil(ms / 1000), p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
}
const fmtLeft = (ms) => { const s = Math.ceil(ms / 1000), p = (n) => String(n).padStart(2, '0'); return s >= 3600 ? `${Math.floor(s / 3600)}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}` : `${Math.floor(s / 60)}:${p(s % 60)}`; };
const evDetail = (e) => (e.type === 'luck' ? `rare chances x${e.mult}` : e.type === 'double' ? `wheel pays x${e.mult}` : e.type === 'sale' ? `${e.percent}% off packs` : '');
setInterval(() => { if (state.eco) renderCoins(); }, 30000);

$('coinBtn').onclick = () => openRewards('wheel');

async function openRewards(tab) {
  try { takeEco(await api('/economy')); } catch (e) { return toast(e.message); }
  const body = h('div', { class: 'rw-body' });
  const tabs = h('div', { class: 'rw-tabs' });
  const evBar = h('div', { class: 'rw-events' });
  let shown = '';
  const paintEvents = () => {
    const evs = liveEvents();
    const sig = evs.map((e) => e.id).join();
    evBar.replaceChildren(...evs.map((e) => h('div', { class: 'rw-ev ev-' + e.type }, h('span', { class: 'rw-ev-ico' }, e.icon),
      h('span', { class: 'rw-ev-txt' }, h('b', {}, e.name), ' ' + evDetail(e)), h('span', { class: 'rw-ev-time' }, fmtLeft(evLeft(e))))));
    return sig;
  };
  const draw = (which) => {
    tab = which;
    tabs.replaceChildren(...[['wheel', '🎡 Daily Wheel'], ['machine', '🎁 Tag Packs'], ['tags', '🏷 My Tags']].map(([id, label]) =>
      h('button', { type: 'button', class: 'rw-tab' + (id === which ? ' on' : ''), onclick: () => draw(id) }, label)));
    body.replaceChildren(which === 'wheel' ? wheelPane() : which === 'machine' ? machinePane(draw) : tagsPane(draw));
    shown = paintEvents(); syncRw();
  };
  const box = h('div', { class: 'modal rewards' },
    h('button', { type: 'button', class: 'rw-x', title: 'Close', onclick: closeOverlay }, '✕'),
    h('div', { class: 'rw-head' }, h('h2', {}, '🛍️ Shop'), h('div', { class: 'rw-coins', id: 'rwCoins' }, '🪙 ' + state.eco.coins)),
    evBar, tabs, body,
    h('p', { class: 'rw-fine' }, 'Coins are just for fun — they have no real-world value and can’t be bought.'));
  draw(tab);
  openOverlay(box);
  const tick = setInterval(async () => {
    if (!document.body.contains(box)) return clearInterval(tick);
    const sig = paintEvents();
    if (sig !== shown) { // an event ended: ask the server for the new prices and odds
      shown = sig;
      try { takeEco(await api('/economy')); if (tab !== 'wheel') draw(tab); else shown = paintEvents(); } catch {}
    }
  }, 1000);
}
const syncRw = () => { const el = document.getElementById('rwCoins'); if (el && state.eco) el.textContent = '🪙 ' + state.eco.coins; };

function wheelPane() {
  const vals = state.eco.wheel, n = vals.length, seg = 360 / n;
  const colors = ['#ff8a3d', '#ffb347', '#ff6b35', '#ffd08a', '#ff9a52', '#e8590c', '#ffc078', '#f76707', '#fcc419', '#e03131'];
  const grad = vals.map((_, i) => `${colors[i % colors.length]} ${i * seg}deg ${(i + 1) * seg}deg`).join(',');
  const dbl = Math.max(1, ...liveEvents().filter((e) => e.type === 'double').map((e) => e.mult));
  const disc = h('div', { class: 'wheel', style: `background:conic-gradient(${grad})` },
    vals.map((v, i) => h('span', { class: 'wlabel', style: `transform:rotate(${(i + 0.5) * seg}deg) translateY(-92px)` }, String(v * dbl))));
  const result = h('div', { class: 'wheel-result' }, ' ');
  const btn = h('button', { type: 'button', class: 'btn primary spin-btn' }, 'SPIN');
  let spinning = false, rot = 0, timer = null;
  const paint = () => {
    const w = spinWait();
    if (spinning) return;
    btn.disabled = w > 0;
    btn.textContent = w > 0 ? 'Next spin in ' + fmtWait(w) : 'SPIN';
    if (w === 0 && timer) { clearInterval(timer); timer = null; renderCoins(); }
  };
  const watch = () => { timer = setInterval(() => { if (!document.body.contains(btn)) { clearInterval(timer); timer = null; } else paint(); }, 1000); };
  btn.onclick = async () => {
    if (spinning || spinWait() > 0) return;
    spinning = true; btn.disabled = true; btn.textContent = 'Spinning…'; result.textContent = ' ';
    let r;
    try { r = await api('/wheel/spin', 'POST'); }
    catch (e) { spinning = false; toast(e.message); try { takeEco(await api('/economy')); } catch {} paint(); return; }
    rot += 360 * 6 + (360 - ((r.index + 0.5) * seg + (rot % 360)) % 360);
    disc.style.transform = `rotate(${rot}deg)`;
    setTimeout(() => {
      spinning = false; takeEco(r); syncRw();
      result.replaceChildren(h('b', {}, `+${r.won} coins!`), r.won !== r.base ? h('small', {}, ` (event bonus x${r.won / r.base})`) : null);
      result.classList.remove('pop'); void result.offsetWidth; result.classList.add('pop');
      paint(); watch();
    }, 4600);
  };
  paint();
  if (spinWait() > 0) watch();
  return h('div', { class: 'wheel-pane' },
    h('p', { class: 'rw-sub' }, 'One free spin every 24 hours.'),
    h('div', { class: 'wheel-wrap' }, h('div', { class: 'wheel-pointer' }), disc, h('div', { class: 'wheel-hub' })),
    result, btn);
}

const pctText = (p) => String(+p.toFixed(p < 1 ? 2 : 1));

function machinePane(redraw) {
  const eco = state.eco, cost = eco.cost;
  if (!eco.packs.some((p) => p.id === shopPack)) shopPack = eco.packs[0].id;
  const pack = eco.packs.find((p) => p.id === shopPack);
  const owned = new Set(eco.owned);
  const packRow = h('div', { class: 'packs' }, eco.packs.map((p) => {
    const mine = eco.tags.filter((t) => t.pack === p.id && owned.has(t.id)).length, all = eco.tags.filter((t) => t.pack === p.id).length;
    return h('button', { type: 'button', class: 'packcard' + (p.id === shopPack ? ' on' : ''), onclick: () => { shopPack = p.id; redraw('machine'); } },
      h('span', { class: 'pk-ico' }, p.icon), h('b', {}, p.name), h('small', {}, `${mine}/${all} collected`));
  }));
  const reel = h('div', { class: 'reel' }, h('span', { class: 'reel-text' }, pack.icon));
  const msg = h('div', { class: 'machine-msg' }, pack.blurb);
  const price = cost < eco.baseCost ? [h('s', {}, String(eco.baseCost)), ' ' + cost] : [String(cost)];
  const btn = h('button', { type: 'button', class: 'btn primary roll-btn' }, 'OPEN PACK — ', ...price, ' 🪙');
  const check = () => { btn.disabled = state.eco.coins < cost; if (btn.disabled) msg.textContent = `You need ${cost} coins — spin the wheel to earn more`; };
  let busy = false;
  btn.onclick = async () => {
    if (busy) return; busy = true; btn.disabled = true;
    reel.className = 'reel spinning'; msg.textContent = 'Opening…';
    const names = eco.tags.filter((t) => t.pack === shopPack).map((t) => (t.icon || '') + ' ' + t.name);
    const text = reel.firstChild;
    const flick = setInterval(() => { text.textContent = names[Math.floor(Math.random() * names.length)]; }, 70);
    let r, err;
    try { r = await api('/machine/roll', 'POST', { pack: shopPack }); } catch (e) { err = e; }
    await new Promise((ok) => setTimeout(ok, 1800));
    clearInterval(flick); busy = false;
    if (err) { reel.className = 'reel'; text.textContent = pack.icon; toast(err.message); check(); return; }
    takeEco(r); syncRw();
    const c = RARITY_COLOR[r.tag.rarity];
    reel.className = 'reel won r-' + r.tag.rarity; reel.style.setProperty('--rc', c);
    text.textContent = (r.tag.icon || '') + ' ' + r.tag.name;
    const label = r.tag.rarity.toUpperCase();
    msg.replaceChildren(r.duplicate
      ? h('span', {}, `Duplicate ${r.tag.rarity} tag — ${r.refund} coins back`)
      : h('span', {}, h('b', { class: 'newtag r-' + r.tag.rarity, style: `color:${c}` }, 'NEW ' + label + '! '), 'Wear it from My Tags'));
    btn.disabled = state.eco.coins < state.eco.cost;
  };
  check();
  const luck = Math.max(1, ...liveEvents().filter((e) => e.type === 'luck').map((e) => e.mult));
  const w = (r) => (r.id === 'common' ? r.chance : r.chance * luck);
  const total = eco.rarities.reduce((n, r) => n + w(r), 0);
  const odds = h('table', { class: 'odds' }, h('tbody', {}, eco.rarities.map((r) => {
    const n = eco.tags.filter((t) => t.pack === shopPack && t.rarity === r.id).length;
    return h('tr', {}, h('td', { class: 'od-' + r.id, style: `color:${RARITY_COLOR[r.id]}` }, r.label), h('td', {}, pctText(w(r) / total * 100) + '%'), h('td', { class: 'dim' }, n + (n === 1 ? ' tag' : ' tags')));
  })));
  return h('div', { class: 'machine-pane' },
    packRow, reel, msg, btn,
    h('h4', { class: 'odds-h' }, 'Chances' + (luck > 1 ? ` · 🍀 luck x${luck} is on` : '')), odds);
}

function tagsPane(redraw) {
  const eco = state.eco, owned = new Set(eco.owned);
  const mk = (t) => {
    const c = RARITY_COLOR[t.rarity], has = owned.has(t.id), on = eco.equipped === t.id;
    return h('button', {
      type: 'button', class: 'tagcard r-' + t.rarity + (has ? '' : ' locked') + (on ? ' on' : ''), style: `--rc:${c}`,
      title: has ? (on ? 'Click to remove' : 'Click to wear') : 'Not unlocked yet',
      onclick: () => { if (!has) return; attempt(async () => { takeEco(await api('/tags/equip', 'POST', { tag: on ? null : t.id })); redraw('tags'); }); },
    }, h('span', { class: 'tc-name' }, has ? (t.icon || '') + ' ' + t.name : '👁 ???'), h('span', { class: 'tc-r' }, t.rarity), on ? h('span', { class: 'tc-on' }, 'Wearing') : null);
  };
  return h('div', { class: 'tags-pane' },
    h('p', { class: 'rw-sub' }, `You have ${owned.size} of ${eco.tags.length} tags. Pick one to show next to your name.`),
    eco.packs.map((p) => {
      const mine = eco.tags.filter((t) => t.pack === p.id);
      const sorted = mine.slice().sort((a, b) => RARITY_ORDER.indexOf(a.rarity) - RARITY_ORDER.indexOf(b.rarity));
      return h('section', { class: 'tg-pack' }, h('h4', {}, `${p.icon} ${p.name}`, h('small', {}, ` ${mine.filter((t) => owned.has(t.id)).length}/${mine.length}`)),
        h('div', { class: 'tagrid' }, sorted.map(mk)));
    }));
}

/* ------------------------------------------------------ update log */

state.updates = [];
const logSeen = () => { try { return Number(localStorage.getItem('logSeen')) || 0; } catch { return 0; } };
const markLogSeen = () => { try { localStorage.setItem('logSeen', String(state.updates.reduce((m, x) => Math.max(m, x.seq), 0))); } catch {} renderLogDot(); };
function renderLogDot() {
  const latest = state.updates.reduce((m, x) => Math.max(m, x.seq), 0);
  $('railLogDot').classList.toggle('hidden', !(latest > logSeen()));
}
async function loadUpdates() {
  try { state.updates = await api('/updates'); } catch { return; }
  renderLogDot();
  if (document.getElementById('ulogList')) drawLog();
}
$('railLog').onclick = openUpdateLog;

function openUpdateLog() {
  const box = h('div', { class: 'modal ulog' },
    h('button', { type: 'button', class: 'rw-x', title: 'Close', onclick: closeOverlay }, '✕'),
    h('h2', {}, '📜 Update log'),
    h('p', { class: 'rw-sub' }, isOwner() ? 'Everything that changed, newest first. You can add, edit and delete entries.' : 'Everything that changed, newest first.'),
    isOwner() ? h('div', { class: 'ul-new' }, h('button', { type: 'button', class: 'btn primary small', onclick: () => editEntry(null) }, '＋ New entry')) : null,
    h('div', { id: 'ulogList', class: 'ul-list' }));
  openOverlay(box);
  drawLog();
  markLogSeen();
  loadUpdates();
}

function drawLog() {
  const list = document.getElementById('ulogList');
  if (!list) return;
  const latest = state.updates.reduce((m, x) => Math.max(m, x.seq), 0);
  list.replaceChildren(...(state.updates.length ? state.updates.map((e) => entryCard(e, e.seq === latest)) : [h('div', { class: 'note' }, 'Nothing here yet.')]));
}

function entryCard(e, newest) {
  return h('article', { class: 'ul-entry' + (newest ? ' newest' : ''), 'data-id': e.id },
    h('div', { class: 'ul-head' },
      h('span', { class: 'ul-badge' }, e.id.startsWith('v') ? e.id : 'update'),
      h('b', { class: 'ul-title' }, e.title),
      newest ? h('span', { class: 'ul-latest' }, 'LATEST') : null,
      h('span', { class: 'ul-date' }, e.date)),
    h('ul', {}, e.notes.map((n) => h('li', {}, n))),
    isOwner() ? h('div', { class: 'ul-actions' },
      h('button', { type: 'button', class: 'mini', onclick: () => editEntry(e) }, '✎ Edit'),
      h('button', { type: 'button', class: 'mini danger', onclick: async () => {
        if (await confirmBox('Delete this entry?', e.title, 'Delete')) attempt(async () => { state.updates = await api('/owner/updates/' + e.id, 'DELETE'); openUpdateLog(); });
      } }, 'Delete')) : null);
}

// Owner only: add (e = null) or edit an entry. The server refuses everyone else.
function editEntry(e) {
  const title = h('input', { type: 'text', maxlength: 80, value: e ? e.title : '', placeholder: 'Title, e.g. Pet tags are here' });
  const date = h('input', { type: 'text', maxlength: 10, value: e ? e.date : new Date().toISOString().slice(0, 10), placeholder: 'YYYY-MM-DD' });
  const notes = h('textarea', { rows: 7, maxlength: 3000, placeholder: 'One change per line' }, e ? e.notes.join('\n') : '');
  const form = h('form', { class: 'modal ulog-edit', onsubmit: (ev) => {
    ev.preventDefault();
    if (!title.value.trim()) return toast('Give the entry a title');
    const body = { title: title.value, date: date.value, notes: notes.value.split('\n') };
    attempt(async () => { state.updates = e ? await api('/owner/updates/' + e.id, 'PUT', body) : await api('/owner/updates', 'POST', body); toast2('Saved'); openUpdateLog(); });
  } },
    h('h2', {}, e ? 'Edit entry' : 'New entry'), title, date, notes,
    h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn ghost small', onclick: openUpdateLog }, 'Cancel'), h('button', { type: 'submit', class: 'btn primary small' }, 'Save')));
  openOverlay(form);
  title.focus();
}

/* ------------------------------------------------------ friends and direct messages */

state.fr = { friends: [], incoming: [], outgoing: [], unread: {}, last: {} };
const D = { active: null, msgs: [], view: null, list: null, chat: null, feed: null, search: '', typing: {}, pendingImage: null };
const dmOpen = () => !!(D.view && D.view.isConnected);
const userName = (id) => (userById(id) || { username: 'Someone' }).username;
const dmUnreadTotal = () => Object.values(state.fr.unread || {}).reduce((a, b) => a + b, 0);

function renderDmBadge() {
  const n = dmUnreadTotal() + state.fr.incoming.length;
  for (const id of ['railDMBadge', 'headDMBadge']) {
    const b = $(id);
    if (!b) continue;
    b.textContent = n > 9 ? '9+' : String(n);
    b.classList.toggle('hidden', !n);
  }
  updateTitle();
}
async function loadFriends() {
  try { state.fr = Object.assign({ last: {} }, await api('/friends')); } catch { return; }
  renderDmBadge();
  renderMembers();
  if (dmOpen()) drawFriends();
}
const friendState = (id) => (state.fr.friends.includes(id) ? 'friend' : state.fr.incoming.includes(id) ? 'incoming' : state.fr.outgoing.includes(id) ? 'outgoing' : 'none');
const frAct = (path, method, body) => attempt(async () => { state.fr = Object.assign(state.fr, await api(path, method, body)); renderDmBadge(); renderMembers(); if (dmOpen()) drawFriends(); });

$('railDM').onclick = () => (dmOpen() ? closeDm() : openFriends());
$('headDM').onclick = () => openFriends();

function closeDm() {
  if (D.view) D.view.remove();
  D.view = D.list = D.chat = D.feed = null;
  $('app').classList.remove('dm-open');
  $('railDM').classList.remove('active');
}

// The messages screen sits right in the app (next to the left bar), not in a pop-up.
function openFriends(withId) {
  if (!state.me) return;
  if (!dmOpen()) {
    const list = h('div', { class: 'dm-list' }), chat = h('div', { class: 'dm-chat' });
    D.view = h('section', { class: 'dmview' + (withId || D.active ? ' has-chat' : '') }, list, chat);
    D.list = list; D.chat = chat;
    $('app').append(D.view);
    $('app').classList.add('dm-open');
    $('railDM').classList.add('active');
    loadFriends();
  }
  if (withId && state.fr.friends.includes(withId)) { openChat(withId); return; }
  if (D.active && state.fr.friends.includes(D.active)) openChat(D.active);
  else { D.active = null; D.view.classList.remove('has-chat'); drawFriends(); drawChat(); }
}

function personRow(id, extra, onclick, sub) {
  const u = userById(id);
  if (!u) return null;
  return h('div', { class: 'dm-row' + (D.active === id ? ' on' : '') + (state.fr.unread[id] ? ' unread' : ''), onclick },
    h('div', { class: 'dm-av' }, avatar(u, true), h('i', { class: 'dm-dot' + (u.online ? ' on' : '') })),
    h('span', { class: 'dm-mid' }, h('span', { class: 'dm-name' }, u.username, userTag(u)), sub ? h('span', { class: 'dm-sub' }, sub) : null), extra);
}

const ago2 = (ts) => {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
};

function drawFriends() {
  if (!D.list) return;
  const fr = state.fr, q = D.search.trim().toLowerCase();
  const search = h('input', { type: 'search', class: 'dm-search', placeholder: 'Search friends…', 'aria-label': 'Search friends', value: D.search,
    oninput: (e) => { D.search = e.target.value; const pos = e.target.selectionStart; drawFriends(); const n = D.list.querySelector('.dm-search'); if (n) { n.focus(); n.setSelectionRange(pos, pos); } } });
  const pick = h('select', { 'aria-label': 'Add a friend' }, h('option', { value: '' }, 'Add a friend…'),
    state.users.filter((u) => u.id !== state.me && friendState(u.id) === 'none').map((u) => h('option', { value: u.id }, u.username)));
  const add = h('button', { type: 'button', class: 'btn primary small', onclick: () => { if (!pick.value) return toast('Choose someone first'); frAct('/friends/request', 'POST', { userId: pick.value }); toast2('Friend request sent'); } }, 'Add');
  const lastOf = (id) => (fr.last || {})[id];
  const friends = fr.friends.filter((id) => !q || userName(id).toLowerCase().includes(q)).sort((a, b) => {
    const la = lastOf(a), lb = lastOf(b);
    if (la && lb) return lb.ts - la.ts;
    if (la || lb) return la ? -1 : 1;
    return ((userById(b) || {}).online ? 1 : 0) - ((userById(a) || {}).online ? 1 : 0) || userName(a).localeCompare(userName(b));
  });
  const row = (id) => {
    const l = lastOf(id), typing = (D.typing[id] || 0) > Date.now();
    const sub = typing ? 'typing…' : l ? (l.from === state.me ? 'You: ' : '') + l.text : (userById(id) || {}).online ? 'Online' : 'Say hi';
    return personRow(id, h('span', { class: 'dm-meta' }, l ? h('span', { class: 'dm-when' }, ago2(l.ts)) : null,
      fr.unread[id] ? h('span', { class: 'dm-unread' }, String(fr.unread[id])) : null), () => openChat(id), sub);
  };
  D.list.replaceChildren(
    h('div', { class: 'dm-title' }, h('h3', {}, '💬 Messages'),
      h('button', { type: 'button', class: 'dm-close', title: 'Close messages (Esc)', onclick: closeDm }, '✕')),
    search,
    fr.incoming.length ? h('div', { class: 'dm-sec' }, h('h6', {}, `Friend requests — ${fr.incoming.length}`),
      fr.incoming.map((id) => personRow(id, h('span', { class: 'dm-btns' },
        h('button', { type: 'button', class: 'mini', title: 'Accept', onclick: (e) => { e.stopPropagation(); frAct('/friends/accept', 'POST', { userId: id }); } }, '✓'),
        h('button', { type: 'button', class: 'mini danger', title: 'Decline', onclick: (e) => { e.stopPropagation(); frAct('/friends/decline', 'POST', { userId: id }); } }, '✕')), null, 'wants to be friends'))) : null,
    h('div', { class: 'dm-sec dm-friends' }, h('h6', {}, `Friends — ${fr.friends.length}`),
      friends.length ? friends.map(row)
        : h('div', { class: 'note' }, fr.friends.length ? 'No one matches.' : 'No friends yet. Add someone below, or open a name in the member list and press Add friend.')),
    fr.outgoing.length ? h('div', { class: 'dm-sec' }, h('h6', {}, 'Waiting for an answer'),
      fr.outgoing.map((id) => personRow(id, h('button', { type: 'button', class: 'mini', onclick: (e) => { e.stopPropagation(); frAct('/friends/decline', 'POST', { userId: id }); } }, 'Cancel'), null, 'request sent'))) : null,
    h('div', { class: 'dm-add' }, pick, add));
}

async function openChat(id) {
  D.active = id;
  D.pendingImage = null;
  if (D.view) D.view.classList.add('has-chat');
  state.fr.unread[id] = 0; renderDmBadge();
  drawFriends();
  try { D.msgs = await api('/dm/' + id); } catch (e) { toast(e.message); D.msgs = []; }
  if (D.active !== id) return;
  drawFriends(); drawChat();
}

async function dmUpload(file) {
  if (!file) return null;
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) { toast('Only PNG, JPG, GIF or WEBP images'); return null; }
  if (file.size > 5 * 1024 * 1024) { toast('Image is over 5 MB'); return null; }
  const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
  const out = await attempt(() => api('/upload', 'POST', { data: dataUrl }));
  return out ? out.url : null;
}

function drawChat() {
  if (!D.chat) return;
  const id = D.active;
  if (!id) { D.chat.replaceChildren(h('div', { class: 'dm-empty' }, h('div', { class: 'big' }, '💬'), h('div', {}, 'Pick a friend to start chatting'), h('div', { class: 'note' }, 'Your messages are private between the two of you.'))); D.feed = null; return; }
  const u = userById(id);
  const feed = h('div', { class: 'dm-feed' });
  D.feed = feed;
  const typingEl = h('div', { class: 'dm-typing' }, ' ');
  D.typingEl = typingEl;
  const pending = h('div', { class: 'dm-pending hidden' });
  D.pendingEl = pending;
  const input = h('textarea', { rows: 1, maxlength: 2000, placeholder: 'Message ' + (u ? u.username : ''), 'aria-label': 'Message' });
  D.input = input;
  const grow = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 140) + 'px'; };
  let lastType = 0;
  input.addEventListener('input', () => {
    grow();
    if (input.value && Date.now() - lastType > 3000) { lastType = Date.now(); api(`/dm/${id}/typing`, 'POST').catch(() => {}); }
  });
  const showPending = () => {
    pending.classList.toggle('hidden', !D.pendingImage);
    pending.replaceChildren(...(D.pendingImage ? [h('img', { src: D.pendingImage, alt: 'pending upload' }), h('span', {}, 'Ready to send'),
      h('button', { type: 'button', class: 'icon-btn', title: 'Remove', onclick: () => { D.pendingImage = null; showPending(); } }, '✕')] : []));
  };
  const attach = async (file) => { const url = await dmUpload(file); if (url) { D.pendingImage = url; showPending(); input.focus(); } };
  const send = () => {
    const text = input.value.trim(), image = D.pendingImage;
    if (!text && !image) return;
    input.value = ''; D.pendingImage = null; grow(); showPending();
    attempt(async () => {
      try { const m = await api('/dm/' + id, 'POST', { content: text, image }); pushDm(m); }
      catch (err) { input.value = text; D.pendingImage = image; grow(); showPending(); throw err; }
    });
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
  input.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (item) { e.preventDefault(); attach(item.getAsFile()); }
  });
  const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', hidden: true, onchange: (e) => { attach(e.target.files[0]); e.target.value = ''; } });
  const form = h('form', { class: 'dm-compose', onsubmit: (e) => { e.preventDefault(); send(); } },
    h('button', { type: 'button', class: 'attach', title: 'Send a picture', onclick: () => file.click() }, '⇡'), file, input,
    h('button', { type: 'submit', class: 'btn primary small' }, 'Send'));
  D.chat.replaceChildren(
    h('header', { class: 'dm-head' },
      h('button', { type: 'button', class: 'dm-back', title: 'Back to friends', onclick: () => { D.active = null; D.view.classList.remove('has-chat'); drawFriends(); drawChat(); } }, '‹'),
      u ? h('div', { class: 'dm-av' }, avatar(u, true), h('i', { class: 'dm-dot' + (u.online ? ' on' : '') })) : null,
      h('div', { class: 'dm-who' }, h('b', {}, u ? u.username : 'Unknown', u ? userTag(u) : null), h('span', { class: 'dm-status' }, u && u.online ? 'Online' : 'Offline')),
      h('button', { type: 'button', class: 'mini danger', style: 'margin-left:auto', onclick: async () => {
        if (await confirmBox('Remove friend?', `${u ? u.username : 'This person'} will be removed from your friends and you will not be able to message each other.`, 'Remove')) { D.active = null; if (D.view) D.view.classList.remove('has-chat'); await frAct('/friends/' + id, 'DELETE'); drawChat(); }
      } }, 'Unfriend'),
      h('button', { type: 'button', class: 'dm-close', title: 'Close messages (Esc)', onclick: closeDm }, '✕')),
    feed, pending, typingEl, form);
  drawFeed();
  showPending();
  drawDmTyping();
  input.focus();
}

const dayLabel = (ts) => {
  const d = new Date(ts), t = new Date(), y = new Date(Date.now() - 86400000);
  if (d.toDateString() === t.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
};

function drawFeed() {
  const feed = D.feed;
  if (!feed) return;
  if (!D.msgs.length) { feed.replaceChildren(h('div', { class: 'dm-empty small' }, 'This is the start of your chat. Say hi!')); return; }
  const out = [];
  D.msgs.forEach((m, i) => {
    const mine = m.from === state.me, prev = D.msgs[i - 1];
    if (!prev || new Date(prev.ts).toDateString() !== new Date(m.ts).toDateString()) out.push(h('div', { class: 'dm-day' }, h('span', {}, dayLabel(m.ts))));
    const first = !prev || prev.from !== m.from || m.ts - prev.ts > 5 * 60 * 1000 || (out[out.length - 1] && out[out.length - 1].classList.contains('dm-day'));
    out.push(h('div', { class: 'dm-msg' + (mine ? ' mine' : '') + (first ? ' first' : ''), 'data-dmid': m.id },
      h('div', { class: 'dm-line' },
        mine ? h('button', { type: 'button', class: 'dm-del', title: 'Delete this message', onclick: async () => {
          if (await confirmBox('Delete message?', 'It will disappear for both of you.', 'Delete')) attempt(() => api(`/dm/${D.active}/${m.id}`, 'DELETE'));
        } }, '🗑') : null,
        h('div', { class: 'dm-bubble' + (m.image && !m.content ? ' pic' : ''), title: fmtStamp(m.ts) },
          m.image ? h('img', { class: 'dm-img', src: m.image, alt: 'picture', onclick: () => openLightbox(m.image) }) : null,
          m.content ? renderText(m.content) : null)),
      first ? h('span', { class: 'time' }, fmtTime(m.ts)) : null));
  });
  feed.replaceChildren(...out);
  feed.scrollTop = feed.scrollHeight;
  for (const img of feed.querySelectorAll('img.dm-img')) img.addEventListener('load', () => { feed.scrollTop = feed.scrollHeight; }, { once: true });
}

function drawDmTyping() {
  if (!D.typingEl || !D.active) return;
  const on = (D.typing[D.active] || 0) > Date.now();
  D.typingEl.textContent = on ? `${userName(D.active)} is typing…` : ' ';
}
setInterval(() => { if (dmOpen()) { drawDmTyping(); } }, 1000);

function dmToast(text, id) {
  const x = h('div', { class: 'toast dmtoast', style: 'border-left-color:#43b581;cursor:pointer', title: 'Open this chat', onclick: () => { x.remove(); openFriends(id); } }, text);
  document.body.append(x);
  setTimeout(() => x.remove(), 5000);
}

function pushDm(msg) {
  const other = msg.from === state.me ? msg.to : msg.from;
  state.fr.last = state.fr.last || {};
  state.fr.last[other] = { from: msg.from, text: msg.content || (msg.image ? '📷 Photo' : ''), ts: msg.ts };
  if (msg.from !== state.me) delete D.typing[other];
  if (D.active === other && dmOpen()) {
    if (!D.msgs.some((x) => x.id === msg.id)) D.msgs.push(msg);
    drawFeed(); drawFriends(); drawDmTyping();
    if (msg.from !== state.me) api('/dm/' + other + '/read', 'POST').catch(() => {});
    return;
  }
  if (msg.from !== state.me) {
    state.fr.unread[other] = (state.fr.unread[other] || 0) + 1;
    renderDmBadge();
    dmToast(`💬 ${userName(other)}: ${msg.content ? msg.content.slice(0, 60) : '📷 Photo'}`, other);
  }
  if (dmOpen()) drawFriends();
}

function dmDeleted(m) {
  const other = m.a === state.me ? m.b : m.a;
  if (D.active === other) { D.msgs = D.msgs.filter((x) => x.id !== m.id); drawFeed(); }
  attempt(loadFriends);
}
function dmTyping(from) {
  D.typing[from] = Date.now() + 4000;
  if (dmOpen()) { drawDmTyping(); drawFriends(); setTimeout(() => dmOpen() && drawFriends(), 4100); }
}

// Owner and Admins: give or take tags from any pack on a person's profile card.
function staffTagTools(user) {
  if (!isAdmin() || !state.eco || !state.eco.packs) return null;
  const sel = h('select', { 'aria-label': 'Tag to give' }, h('option', { value: '' }, 'Choose a tag…'),
    state.eco.packs.map((p) => h('optgroup', { label: `${p.icon} ${p.name}` },
      h('option', { value: 'pack:' + p.id }, `★ Whole ${p.name}`),
      state.eco.tags.filter((t) => t.pack === p.id).map((t) => h('option', { value: t.id }, `${t.icon} ${t.name} (${t.rarity})`)))));
  const go = (action) => {
    if (!sel.value) return toast('Choose a tag first');
    const body = sel.value.startsWith('pack:') ? { pack: sel.value.slice(5), action } : { tag: sel.value, action };
    attempt(async () => {
      const r = await api(`/users/${user.id}/tags`, 'POST', body);
      toast2(r.changed.length ? `${action === 'take' ? 'Took' : 'Gave'} ${r.changed.length > 2 ? r.changed.length + ' tags' : r.changed.join(', ')} ${action === 'take' ? 'from' : 'to'} ${r.username}` : `${r.username} ${action === 'take' ? "doesn't have" : 'already has'} that`);
    });
  };
  return h('div', { class: 'pop-sec' }, h('h6', {}, 'Tags (staff)'), sel,
    h('div', { class: 'pop-tagbtns' }, h('button', { class: 'btn primary small', onclick: () => go('give') }, '🎁 Give'), h('button', { class: 'btn small', onclick: () => go('take') }, 'Take back')));
}

// Buttons shown on a person's profile card.
function friendButtons(user) {
  if (user.id === state.me) return null;
  const st = friendState(user.id), done = () => { hidePopover(); };
  if (st === 'friend') return h('div', { class: 'pop-sec pop-friend' }, h('button', { class: 'btn primary small', onclick: () => { done(); openFriends(user.id); } }, '💬 Message'), h('span', { class: 'pill' }, '✓ Friends'));
  if (st === 'incoming') return h('div', { class: 'pop-sec pop-friend' }, h('button', { class: 'btn primary small', onclick: () => { done(); frAct('/friends/accept', 'POST', { userId: user.id }); } }, 'Accept friend request'));
  if (st === 'outgoing') return h('div', { class: 'pop-sec pop-friend' }, h('span', { class: 'pill' }, 'Friend request sent'));
  return h('div', { class: 'pop-sec pop-friend' }, h('button', { class: 'btn primary small', onclick: () => { done(); frAct('/friends/request', 'POST', { userId: user.id }); toast2('Friend request sent'); } }, '➕ Add friend'));
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
  let data, reports = [], am = { enabled: true, includeStaff: false, words: [], muted: [] };
  try { data = await api('/owner/overview'); reports = await api('/owner/reports'); am = await api('/owner/automod'); takeEco(await api('/economy')); } catch (e) { return toast(e.message); }
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

  const coinSel = h('select', {}, h('option', { value: '' }, 'Choose a member…'), state.users.map((u) => h('option', { value: u.id }, u.username + (u.id === state.me ? ' (you)' : ''))));
  const coinAmt = h('input', { type: 'number', placeholder: 'Coins (e.g. 500)', step: 1, inputmode: 'numeric' });
  const coinBox = h('div', { class: 'own-coins' });
  const paintCoins = () => {
    const rows = state.users.map((u) => ({ u, c: (data.coins || {})[u.id] || 0 })).sort((a, b) => b.c - a.c || a.u.username.localeCompare(b.u.username));
    const total = rows.reduce((n, r) => n + r.c, 0);
    coinBox.replaceChildren(
      h('div', { class: 'note' }, `${total.toLocaleString()} coins across ${rows.length} member${rows.length === 1 ? '' : 's'}`),
      ...rows.map((r) => h('div', { class: 'own-row' }, avatar(r.u, true), h('span', { class: 'own-name' }, r.u.username + (r.u.id === state.me ? ' (you)' : '')),
        h('span', { class: 'own-coinamt' }, '🪙 ' + r.c.toLocaleString()))));
  };
  paintCoins();
  const st = data.storage || { persistent: true };
  const restoreFile = h('input', { type: 'file', accept: '.json,application/json', class: 'hidden' });
  restoreFile.addEventListener('change', async () => {
    const f = restoreFile.files[0]; restoreFile.value = '';
    if (!f) return;
    let obj; try { obj = JSON.parse(await f.text()); } catch { return toast('That file is not a Warms backup'); }
    if (await confirmBox('Restore this backup?', 'This REPLACES everything on the site (accounts, chats, coins) with the backup, and signs everyone else out.', 'Restore')) attempt(async () => { const r = await api('/owner/restore', 'POST', obj); closeOverlay(); await refresh(); await loadMessages(); toast2('Restored ' + r.users + ' accounts'); });
  });
  /* events */
  const activeBox = h('div', { class: 'ev-active' });
  const endBtn = (e) => h('button', { class: 'btn small', onclick: () => attempt(async () => { await api('/owner/events/' + e.id, 'DELETE'); takeEco(await api('/economy')); drawActive(); toast2('Event ended'); }) }, 'End now');
  const drawActive = () => {
    const evs = liveEvents();
    const rows = evs.map((e) => h('div', { class: 'own-row' }, h('span', { class: 'own-name' }, `${e.icon} ${e.name} ${evDetail(e)} · ${fmtLeft(evLeft(e))} left`), endBtn(e)));
    activeBox.replaceChildren(...(rows.length ? rows : [h('div', { class: 'note' }, 'No events running.')]));
  };
  drawActive();
  const sel = (opts, def) => h('select', {}, opts.map(([v, l]) => h('option', { value: v, selected: v === def }, l)));
  const start = (payload) => attempt(async () => { await api('/owner/events', 'POST', payload); takeEco(await api('/economy')); drawActive(); toast2('Event started — everyone was told'); });
  const mins = () => sel([[15, '15 min'], [30, '30 min'], [60, '1 hour'], [180, '3 hours'], [1440, '24 hours']], 30);
  const luckMult = sel([[2, 'x2'], [3, 'x3'], [5, 'x5'], [10, 'x10']], 3), luckMin = mins();
  const dblMult = sel([[2, 'x2'], [3, 'x3']], 2), dblMin = mins();
  const salePct = sel([[25, '25% off'], [50, '50% off'], [75, '75% off']], 50), saleMin = mins();
  const rainAmt = h('input', { type: 'number', value: 100, min: 1, max: 10000, 'aria-label': 'Coins per person' });
  const evRow = (icon, title, desc, controls, go, label = 'Start') => h('div', { class: 'ev-row' }, h('div', { class: 'ev-info' }, h('b', {}, `${icon} ${title}`), h('small', {}, desc)),
    h('div', { class: 'ev-ctl' }, controls, h('button', { class: 'btn primary small', onclick: go }, label)));
  const eventsSection = h('section', {}, h('h4', {}, '🎉 Events for everyone'),
    activeBox,
    evRow('🍀', 'Lucky Hour', 'Multiplies the chance of rare tags when opening packs', [luckMult, luckMin], () => start({ type: 'luck', mult: Number(luckMult.value), minutes: Number(luckMin.value) })),
    evRow('🎡', 'Double Coins', 'The Daily Wheel pays more', [dblMult, dblMin], () => start({ type: 'double', mult: Number(dblMult.value), minutes: Number(dblMin.value) })),
    evRow('🏷️', 'Pack Sale', 'Tag packs cost less', [salePct, saleMin], () => start({ type: 'sale', percent: Number(salePct.value), minutes: Number(saleMin.value) })),
    evRow('🎁', 'Coin Rain', 'Gives every member coins right now', [rainAmt], () => start({ type: 'gift', amount: Number(rainAmt.value) }), 'Give'),
    evRow('🔄', 'Free Spin For All', 'Everyone can spin the wheel again now', [], () => start({ type: 'freespin' })));

  /* AutoMod */
  const amOn = h('input', { type: 'checkbox', checked: am.enabled });
  const amStaff = h('input', { type: 'checkbox', checked: am.includeStaff });
  const amWords = h('input', { type: 'text', value: (am.words || []).join(', '), placeholder: 'extra banned words, separated by commas' });
  const amSave = (extra = {}) => attempt(async () => {
    am = await api('/owner/automod', 'PUT', Object.assign({ enabled: amOn.checked, includeStaff: amStaff.checked, words: amWords.value.split(',').map((x) => x.trim()).filter(Boolean) }, extra));
    amWords.value = am.words.join(', '); toast2('AutoMod saved');
  });
  const mutedBox = h('div', {});
  const unmuteBtn = (m) => h('button', { class: 'btn small', onclick: () => attempt(async () => { await api(`/users/${m.id}/mute`, 'PUT', { minutes: 0 }); am = await api('/owner/automod'); drawMuted(); await refresh(); toast2(m.username + ' was unmuted'); }) }, 'Unmute');
  const drawMuted = () => {
    const rows = am.muted.map((m) => h('div', { class: 'own-row' }, h('span', { class: 'own-name' }, `${m.username} · muted ${m.minutes}m · strike ${m.offenses || '–'}`), unmuteBtn(m)));
    mutedBox.replaceChildren(...(rows.length ? rows : [h('div', { class: 'note' }, 'Nobody is muted right now.')]));
  };
  drawMuted();
  const automodSection = h('section', {}, h('h4', {}, '🤖 AutoMod (chat filter)'),
    h('label', { class: 'own-check' }, amOn, ' AutoMod is on'),
    h('label', { class: 'own-check' }, amStaff, ' Also filter Owner and Admins (for testing)'),
    h('div', { class: 'own-add' }, amWords, h('button', { class: 'btn small', onclick: () => amSave() }, 'Save')),
    h('div', { class: 'note' }, 'It blocks cuss words and spam (flooding, repeats, link spam). First offence = 10 minute mute, then it doubles: 20, 40, 80… Strikes fade after a week. Admins and the Owner can unmute from the Staff panel, or here.'),
    mutedBox);

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
    eventsSection,
    automodSection,
    h('section', {}, h('h4', {}, '🪙 Give coins'),
      h('div', { class: 'own-add' }, coinSel, coinAmt),
      h('button', { class: 'btn primary small', style: 'margin-top:8px', onclick: () => {
        if (!coinSel.value) return toast('Choose a member first');
        if (!coinAmt.value) return toast('Enter how many coins');
        attempt(async () => { const r = await api('/owner/give-coins', 'POST', { userId: coinSel.value, amount: Number(coinAmt.value) }); coinAmt.value = ''; (data.coins ||= {})[coinSel.value] = r.coins; paintCoins(); toast2(r.username + ' now has ' + r.coins + ' coins'); });
      } }, 'Give coins'),
      h('div', { class: 'note' }, 'Use a minus number (like -100) to take coins away.'),
      h('h5', { class: 'own-sub' }, 'Coins each member has'), coinBox),
    h('section', {}, h('h4', {}, '💾 Save & restore'),
      h('div', { class: 'note ' + (st.persistent ? 'store-ok' : 'store-bad') }, st.persistent
        ? (st.database ? '✔ Your data is saved in an external database. Updates will not erase it.' : '✔ Your data is on a permanent disk. Updates will not erase it.')
        : '⚠ Temporary storage! Every update to the site ERASES accounts, chats and coins. Add a Render disk (see the guide) or download a backup before each update and restore it after.'),
      h('div', { class: 'own-add' },
        h('button', { class: 'btn small', onclick: () => attempt(async () => {
          const data = await api('/owner/backup');
          const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' })), download: 'warms-backup-' + new Date().toISOString().slice(0, 10) + '.json' });
          document.body.append(a); a.click(); a.remove(); toast2('Backup downloaded');
        }) }, 'Download backup'),
        h('button', { class: 'btn small', onclick: () => restoreFile.click() }, 'Restore from backup'), restoreFile),
      h('div', { class: 'note' }, 'Backups hold accounts, roles, chats, coins and tags. Uploaded pictures are not included.')),
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
const V = { room: null, local: null, peers: new Map(), muted: false, deaf: false, ctx: null, pending: false, screen: null, sharer: null, watching: null, sharePending: false };
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
  if (V.screen) { V.screen.getTracks().forEach((t) => { t.onended = null; t.stop(); }); V.screen = null; }
  for (const id of [...V.peers.keys()]) dropPeer(id);
  V.sharer = null; V.watching = null;
  if (V.local) V.local.getTracks().forEach((t) => t.stop());
  V.local = null; V.room = null; V.muted = false; V.deaf = false;
  levels.clear();
  renderVoice();
}

function onVoiceJoined(m) {
  if (V.room !== m.room) return;
  m.peers.forEach((id) => makePeer(id));
}

// "Perfect negotiation": either side may start a new handshake (needed when someone starts sharing their screen).
// The side with the smaller id is "polite" and backs down if both start at once.
async function setLocal(pc) {
  try { await pc.setLocalDescription(); }
  catch (e) { await pc.setLocalDescription(pc.signalingState === 'have-remote-offer' ? await pc.createAnswer() : await pc.createOffer()); }
}

function makePeer(id) {
  if (V.peers.has(id)) return V.peers.get(id);
  const pc = new RTCPeerConnection(ICE);
  const peer = { pc, audio: null, video: null, queue: [], polite: String(state.me) < String(id), makingOffer: false, ignoreOffer: false, screenSender: null };
  V.peers.set(id, peer);
  V.local.getTracks().forEach((t) => pc.addTrack(t, V.local));
  if (V.screen) addScreenTrack(peer);
  pc.onicecandidate = (e) => { if (e.candidate) wsSend({ t: 'voice-signal', to: id, data: { candidate: e.candidate } }); };
  pc.ontrack = (e) => {
    if (e.track.kind === 'video') {
      peer.video = e.streams[0] || new MediaStream([e.track]);
      e.track.onended = () => { if (peer.video && !peer.video.getTracks().some((t) => t.readyState === 'live')) peer.video = null; syncScreen(); };
      syncScreen();
      return;
    }
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
  pc.onnegotiationneeded = async () => {
    try {
      peer.makingOffer = true;
      await setLocal(pc);
      wsSend({ t: 'voice-signal', to: id, data: { sdp: pc.localDescription } });
    } catch (e) { /* peer left */ }
    finally { peer.makingOffer = false; }
  };
  return peer;
}

async function onVoiceSignal(from, data) {
  if (!V.room || !V.local || !data) return;
  const peer = makePeer(from);
  const pc = peer.pc;
  try {
    if (data.sdp) {
      const collision = data.sdp.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
      peer.ignoreOffer = !peer.polite && collision;
      if (peer.ignoreOffer) return;
      await pc.setRemoteDescription(data.sdp);
      for (const c of peer.queue.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      if (data.sdp.type === 'offer') {
        await setLocal(pc);
        wsSend({ t: 'voice-signal', to: from, data: { sdp: pc.localDescription } });
      }
    } else if (data.candidate) {
      if (!pc.remoteDescription) peer.queue.push(data.candidate);
      else await pc.addIceCandidate(data.candidate).catch(() => { /* harmless if we ignored that offer */ });
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
  p.video = null;
  levels.delete(id);
  syncScreen();
}

/* ---- screen sharing: the video goes straight to each person in the call, one sharer per channel ---- */

function addScreenTrack(peer) {
  const track = V.screen && V.screen.getVideoTracks()[0];
  if (!track || peer.screenSender) return;
  try {
    peer.screenSender = peer.pc.addTrack(track, V.screen);
    const s = peer.screenSender, p = s.getParameters();
    p.encodings = p.encodings && p.encodings.length ? p.encodings : [{}];
    p.encodings[0].maxBitrate = 2500000;
    s.setParameters(p).catch(() => {});
  } catch (e) { /* peer is closing */ }
}

const canShare = () => !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);

async function startShare() {
  if (!V.room || V.screen || V.sharePending) return;
  if (!canShare()) return toast("Your browser can't share its screen (most phones can't). Try a computer.");
  const other = ((state.voice && state.voice[V.room]) || []).find((p) => p.sharing && p.userId !== state.me);
  if (other) return toast(`${userName(other.userId)} is already sharing in this channel`);
  V.sharePending = true;
  let stream;
  try { stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 }, width: { max: 1920 }, height: { max: 1080 } }, audio: false }); }
  catch (e) { V.sharePending = false; return; /* they pressed cancel */ }
  V.sharePending = false;
  if (!V.room) { stream.getTracks().forEach((t) => t.stop()); return; }
  V.screen = stream;
  stream.getVideoTracks()[0].onended = () => stopShare();
  V.peers.forEach(addScreenTrack);
  wsSend({ t: 'voice-state', muted: V.muted, deaf: V.deaf, sharing: true });
  renderVoice();
}

function stopShare() {
  const s = V.screen;
  if (!s) return;
  V.screen = null;
  V.peers.forEach((p) => { if (p.screenSender) { try { p.pc.removeTrack(p.screenSender); } catch (e) { /* closed */ } p.screenSender = null; } });
  s.getTracks().forEach((t) => { t.onended = null; t.stop(); });
  if (V.room) wsSend({ t: 'voice-state', muted: V.muted, deaf: V.deaf, sharing: false });
  renderVoice();
}

// Shows or hides the floating viewer for whoever is sharing in my channel.
function syncScreen() {
  const room = (V.room && state.voice && state.voice[V.room]) || [];
  const sh = room.find((p) => p.sharing && p.userId !== state.me);
  const id = sh ? sh.userId : null;
  if (id !== V.sharer) { V.sharer = id; V.watching = id; } // auto-open when someone starts
  let box = $('screenView');
  const peer = V.watching && V.peers.get(V.watching);
  if (!V.watching || !peer || !peer.video) { if (box) box.remove(); return; }
  if (!box) {
    const video = h('video', { autoplay: true, playsinline: true, muted: true });
    video.muted = true;
    box = h('div', { id: 'screenView', class: 'screenview' },
      h('div', { class: 'sv-head' }, h('span', { class: 'sv-title' }),
        h('button', { type: 'button', class: 'sv-btn', title: 'Make bigger or smaller', onclick: () => box.classList.toggle('big') }, '⤢'),
        h('button', { type: 'button', class: 'sv-btn', title: 'Full screen', onclick: () => { const v = box.querySelector('video'); if (v.requestFullscreen) v.requestFullscreen().catch(() => {}); } }, '⛶'),
        h('button', { type: 'button', class: 'sv-btn', title: 'Stop watching', onclick: () => { V.watching = null; syncScreen(); renderVoice(); } }, '✕')),
      video);
    document.body.append(box);
  }
  box.querySelector('.sv-title').textContent = `🖥 ${userName(V.watching)}'s screen`;
  const v = box.querySelector('video');
  if (v.srcObject !== peer.video) { v.srcObject = peer.video; v.play().catch(() => {}); }
}

function setVoiceState(muted, deaf) {
  V.muted = muted; V.deaf = deaf;
  if (V.local) V.local.getAudioTracks().forEach((t) => { t.enabled = !muted; });
  V.peers.forEach((p) => { if (p.audio) p.audio.muted = deaf; });
  wsSend({ t: 'voice-state', muted, deaf, sharing: !!V.screen });
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
        const live = p.sharing && V.room === c.id;
        return h('div', { class: 'vuser' + (live && p.userId !== state.me ? ' watchable' : ''), 'data-vuid': p.userId,
          onclick: live && p.userId !== state.me ? () => { V.watching = p.userId; syncScreen(); } : null, title: live && p.userId !== state.me ? 'Watch their screen' : null },
          avatar(u, false), h('span', { class: 'vname' }, u.username),
          p.sharing ? h('span', { class: 'vlive' }, 'LIVE') : null,
          p.muted || p.deaf ? h('span', { class: 'vflag', title: p.deaf ? 'Deafened' : 'Muted' }, p.deaf ? '🔇' : '🎙️✕') : null);
      }));
  }));
  bar.classList.toggle('hidden', !V.room);
  syncScreen();
  if (V.room) {
    const c = state.voiceChannels.find((x) => x.id === V.room);
    const vb = (cls, icon, label, title, fn) => h('button', { class: 'vbtn ' + cls, title, onclick: fn }, h('span', { class: 'vb-ico' }, icon), h('span', { class: 'vb-lbl' }, label));
    bar.replaceChildren(
      h('div', { class: 'vb-info' }, h('div', { class: 'vb-state' }, h('i', { class: 'pulse' }), 'Voice connected'), h('div', { class: 'vb-room' }, c ? '🔊 ' + c.name : '')),
      h('div', { class: 'vb-btns' },
        vb(V.muted ? 'off' : '', V.muted ? '🔇' : '🎤', V.muted ? 'Unmute' : 'Mute', V.muted ? 'You are muted. Click to turn your microphone back on' : 'Turn your microphone off', () => setVoiceState(!V.muted, V.deaf && V.muted ? false : V.deaf)),
        vb(V.deaf ? 'off' : '', V.deaf ? '🙉' : '🎧', V.deaf ? 'Hear' : 'Deafen', V.deaf ? 'You cannot hear anyone. Click to hear again' : 'Stop hearing everyone (also mutes you)', () => setVoiceState(!V.deaf, !V.deaf)),
        canShare() ? vb(V.screen ? 'live' : '', '🖥', V.screen ? 'Stop' : 'Share', V.screen ? 'You are sharing your screen. Click to stop' : 'Share your screen with everyone in this channel', () => (V.screen ? stopShare() : startShare())) : null,
        vb('leave', '📞', 'Leave', 'Disconnect from this voice channel', () => leaveVoice())));
  }
}
window.addEventListener('beforeunload', () => { if (V.room) wsSend({ t: 'voice-leave' }); });

/* ------------------------------------------------------------------ boot */

(async function boot() {
  if (!state.token) return showAuth();
  try { await start(); } catch (e) { showAuth(); }
})();

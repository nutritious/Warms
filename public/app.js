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
  // The first letter is always there. The picture sits on top of it, so if the picture file is missing or slow, the letter shows instead of an empty circle.
  const a = h('div', { class: 'avatar', style: `background:${colorFor(user.username)}` }, h('span', { class: 'av-letter' }, user.username[0].toUpperCase()));
  if (user.avatar) {
    const img = h('img', { class: 'av-img', src: user.avatar, alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' });
    img.addEventListener('error', () => img.remove());
    a.append(img);
  }
  if (user.fx && user.fx.ring) a.classList.add('fx-' + user.fx.ring);
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
  candy: ['Candy', ['#2a1030', '#4a1d52', '#ff5fb0']],
  mint: ['Mint', ['#0b1f1d', '#17403a', '#4cf2c4']],
  galaxy: ['Galaxy', ['#070818', '#171a45', '#7c8cff']],
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

/* ---- Halloween lobby: decorations that disappear on November 1st (midnight Pacific) ---- */
const HALLOWEEN_END = Date.UTC(2026, 10, 1, 7, 0, 0);
const halloweenOn = () => pref('halloween') !== 'off' && Date.now() < HALLOWEEN_END;
function applyHalloween() {
  const on = halloweenOn(), had = document.body.classList.contains('halloween');
  document.body.classList.toggle('halloween', on);
  const old = document.getElementById('hwDeco');
  if (!on) { if (old) old.remove(); return; }
  if (had && old) return;
  const deco = h('div', { id: 'hwDeco', 'aria-hidden': 'true' },
    h('div', { class: 'hw-web tl' }), h('div', { class: 'hw-web tr' }),
    [0, 1, 2, 3, 4, 5].map((i) => h('span', { class: 'hw-bat', style: `top:${6 + i * 11}%;animation-duration:${16 + i * 3}s;animation-delay:${-i * 4.5}s;font-size:${18 + (i % 3) * 8}px` }, '🦇')),
    [0, 1, 2].map((i) => h('span', { class: 'hw-ghost', style: `left:${14 + i * 30}%;animation-delay:${-i * 2.3}s` }, '👻')));
  document.body.append(deco);
}
applyHalloween();
setInterval(applyHalloween, 30000);

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

// Long panels get a row of jump chips under the title so you can hop to any section.
function panelNav(panel) {
  let sig = '';
  const build = () => {
    const secs = [...panel.querySelectorAll(':scope > section, :scope > div > section')].filter((x) => x.querySelector(':scope > h4'));
    const key = secs.map((x) => x.querySelector(':scope > h4').textContent).join('|');
    if (key === sig || secs.length < 4) { if (secs.length < 4) { const old = panel.querySelector('.pnav'); if (old) old.remove(); sig = ''; } return; }
    sig = key; const old = panel.querySelector('.pnav'); if (old) old.remove();
    const nav = h('div', { class: 'pnav' }, secs.map((x) => { const t = x.querySelector(':scope > h4').textContent.trim(); return h('button', { type: 'button', class: 'pchip', onclick: () => { x.scrollIntoView({ behavior: calmMotion() ? 'auto' : 'smooth', block: 'start' }); x.classList.remove('flash'); void x.offsetWidth; x.classList.add('flash'); } }, t); }));
    const first = secs[0]; first.parentNode.insertBefore(nav, first);
  };
  const mo = new MutationObserver(() => { if (!panel.isConnected) return mo.disconnect(); build(); });
  mo.observe(panel, { childList: true, subtree: true });
  setTimeout(build, 0);
}
function closeOverlay() { $('overlay').classList.add('hidden'); $('overlay').replaceChildren(); }
function openOverlay(node, dismissable = true) {
  if (node && node.classList && node.classList.contains('ownerp')) panelNav(node);
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
  $('authRulesWrap').classList.toggle('hidden', !reg);
  $('authInviteWrap').classList.toggle('hidden', !(reg && state.inviteOnly && hasUsers !== false));
  if (reg) {
    $('authAgree').checked = false;
    $('authBtn').disabled = true;
    loadRules().then((d) => { if (d && !$('authRules').firstChild) $('authRules').append(rulesNode(d)); });
  } else $('authBtn').disabled = false;
}

async function showAuth() {
  $('app').classList.add('hidden');
  $('auth').classList.remove('hidden');
  let status = { hasUsers: true };
  try { status = await (await fetch('/api/status')).json(); } catch (e) { /* keep default */ }
  state.hasUsers = status.hasUsers; state.inviteOnly = !!status.inviteOnly;
  const link = new URLSearchParams(location.search).get('invite');
  if (link && state.inviteOnly) $('authInvite').value = link.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 24);
  setAuthMode(!status.hasUsers || !!link, status.hasUsers);
  $('authSwitch').onclick = (e) => { e.preventDefault(); setAuthMode(!registerMode, state.hasUsers); };
}

$('authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('authErr').textContent = '';
  if (registerMode && !$('authAgree').checked) { $('authErr').textContent = 'Please read and agree to the Server Rules first'; return; }
  $('authBtn').disabled = true;
  try {
    const res = await fetch('/api/' + (registerMode ? 'register' : 'login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('authUser').value, password: $('authPass').value, agreeRules: registerMode ? $('authAgree').checked : undefined, inviteCode: registerMode ? $('authInvite').value : undefined }),
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
    $('authBtn').disabled = registerMode && !$('authAgree').checked;
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

// Many small server messages (people coming and going...) used to each reload everything and redraw every message. Now they are merged into one refresh.
let refreshTimer = null, refreshMsgs = false;
function scheduleRefresh(redrawMessages) {
  if (redrawMessages) refreshMsgs = true;
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null; const redraw = refreshMsgs; refreshMsgs = false;
    attempt(async () => { await refresh(); if (redraw) renderMessages(true); });
  }, 1500);
}

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
  state.perks = data.perks || { troll: false, community: false };
  if (data.economy) takeEco(data.economy);
  state.tour = !!data.tour; setCountdown(data.countdown);
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
  loadMinigame();
  loadShow();
  attempt(loadPolls); attempt(loadQuests); attempt(loadWebGames);
  playIntro();
  if (state.tour) { const tryTour = () => { if (!state.tour) return; if ($('overlay').classList.contains('hidden') && !document.querySelector('.intro')) openTour(true); else setTimeout(tryTour, 4000); }; setTimeout(tryTour, 3000); } // never covers something you opened
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
        if (m.msg.userId !== state.me) uiSound('recv');
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
    } else if (m.t === 'call-ring') {
      showRing(m);
    } else if (m.t === 'call-cancel') {
      hideRing(m.room);
    } else if (m.t === 'call-declined') {
      toast2(`📞 ${m.by} declined the call`); if (V.room) cleanupVoice();
    } else if (m.t === 'call-missed') {
      toast2(m.offline ? `📞 ${m.to} is offline right now` : `📞 ${m.to} did not pick up`); if (V.room) cleanupVoice();
    } else if (m.t === 'voice-joined') {
      onVoiceJoined(m);
    } else if (m.t === 'voice-left') {
      dropPeer(m.userId);
      if (V.room && V.room.startsWith('dm:')) { toast2('📞 Call ended'); leaveVoice(); }
    } else if (m.t === 'voice-signal') {
      onVoiceSignal(m.from, m.data);
    } else if (m.t === 'voice-share-denied') {
      stopShare(); toast(`${userName(m.by)} is already sharing in this channel`);
    } else if (m.t === 'voice-error') {
      cleanupVoice(); toast(m.error);
    } else if (m.t === 'announce') {
      if (!m.channelId || m.channelId === state.channelId) showBanner(m.by, m.text); // the pop-up only shows in #general
    } else if (m.t === 'troll') {
      runTroll(m);
    } else if (m.t === 'minigame') {
      if (m.kind === 'win') { if (m.username !== me().username) toast2(`🏆 ${m.username} won the minigame in ${m.time}s`); }
      else if (m.kind === 'start') { toast2('🎮 A minigame started! Look for the 🎮 button'); }
      attempt(loadMinigame);
    } else if (m.t === 'show') {
      if (m.kind === 'start') { toast2(m.theme === 'halloween' ? '💀 The Halloween show is starting. Hit Join on the bar at the top' : '⚡ A live show is starting. Hit Join on the bar at the top'); sfx('airhorn'); }
      else if (m.kind === 'announce' && m.text) { showAnnounce(m.by, m.text); }
      else if (m.kind === 'award' && m.text) { toast2('🎁 You got ' + m.text); attempt(loadEcoSoft); }
      attempt(loadShow);
    } else if (m.t === 'poll') {
      attempt(async () => { await loadPolls(); if (m.fresh) pollPopup(m.id); });
    } else if (m.t === 'quest') {
      for (const d of m.done || []) { toast2(`📋 Quest done: ${d.text}  +${d.reward} 🪙`); }
      uiSound('win'); popConfetti(); attempt(async () => { await loadQuests(); await refreshEco(); });
    } else if (m.t === 'countdown') {
      attempt(async () => { setCountdown((await api('/countdown')).countdown); });
    } else if (m.t === 'webgames') {
      attempt(loadWebGames);
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
      scheduleRefresh(m.t !== 'presence');
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
    const canDel = isAdmin() && !sp2.system && sp2.id !== state.spaces[0].id;
    return h('div', { class: 'rail-wrap' },
      h('button', { class: 'rail-chat' + (sp2.id === state.spaceId ? ' active' : '') + (sp2.icon ? ' has-img' : ''), title: sp2.name, onclick: () => { closeDm(); switchSpace(sp2.id); } },
        sp2.icon ? h('img', { class: 'rail-img', src: sp2.icon, alt: '' }) : h('span', {}, sp2.system ? '🛡️' : spaceInitials(sp2.name)),
        un.length ? h('i', { class: 'rail-dot' + (ping ? ' ping' : '') }) : null),
      canDel ? h('button', { type: 'button', class: 'rail-x', title: 'Delete ' + sp2.name, onclick: async (e) => {
        e.stopPropagation();
        if (await confirmBox('Delete ' + sp2.name + '?', 'Every chat and message in this space will be deleted for good.', 'Delete space')) attempt(async () => { await api('/spaces/' + sp2.id, 'DELETE'); await refresh(); toast2('Space deleted'); });
      } }, '✕') : null);
  }));
  $('ownerBtn').classList.toggle('hidden', !isOwner());
  $('commBtn').classList.toggle('hidden', !(state.perks && state.perks.community));
  $('trollBtn').classList.toggle('hidden', !(state.perks && state.perks.troll));
  $('adminBtn').classList.toggle('hidden', !isAdmin());
  $('adminPanelBtn').classList.toggle('hidden', !isAdmin());
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
  $('meAvatar').replaceWith(Object.assign(avatar(u, false), { id: 'meAvatar', title: 'My profile', onclick: () => openProfile(me()) }));
  $('meAvatar').style.cursor = 'pointer';
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
    h('button', { type: 'button', onclick: (ev) => { burstAt(ev.currentTarget, e); uiSound('pop'); closePicker(); attempt(() => api(`/messages/${msg.id}/reactions`, 'PUT', { emoji: e })); } }, e)));
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
          onclick: (ev) => { if (!ids.includes(state.me)) { burstAt(ev.currentTarget, emoji); uiSound('pop'); } attempt(() => api(`/messages/${msg.id}/reactions`, 'PUT', { emoji })); },
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
  const node = messageNode(msg, prev);
  if (!calmMotion()) node.classList.add('fresh');
  box.append(node);
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
  else { uiSound('send'); if (/🎉|🥳|🎊/.test(content)) { burstAt($('msgInput'), '🎉', 14); popConfetti(); } }
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
      h('button', { type: 'button', class: 'btn small pop-prof', onclick: () => { hidePopover(); openProfile(user); } }, '👤 View profile'),
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

// Profile pictures are shrunk to a small square before upload, so the chat stays fast (a 5 MB photo used to be loaded for every message). Animated GIFs are kept as they are when they are small.
async function smallPicture(file, size) {
  const raw = await new Promise((res, rej) => { const rd = new FileReader(); rd.onload = () => res(rd.result); rd.onerror = rej; rd.readAsDataURL(file); });
  if (file.type === 'image/gif' && file.size <= 800 * 1024) return raw;
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = raw; });
    const side = Math.min(img.width, img.height), c = document.createElement('canvas');
    c.width = c.height = Math.min(size, side);
    c.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, c.width, c.height);
    const out = c.toDataURL('image/webp', 0.85);
    return out.startsWith('data:image/webp') ? out : c.toDataURL('image/jpeg', 0.85);
  } catch (e) { return raw; }
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
    const dataUrl = await smallPicture(f, 256);
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
    h('div', { class: 'field' }, h('label', {}, 'SOUNDS AND EFFECTS'),
      h('label', { class: 'own-check' }, h('input', { type: 'checkbox', checked: soundsOn(), onchange: (e) => { pref('sounds', e.target.checked ? null : 'off'); if (e.target.checked) uiSound('win'); } }), ' Soft click, message and coin sounds'),
      h('label', { class: 'own-check' }, h('input', { type: 'checkbox', checked: bouncyOn(), onchange: (e) => { pref('bouncy', e.target.checked ? null : 'off'); applyBouncy(); } }), ' Bouncy animations and sparkles')),
    h('div', { class: 'field' }, h('label', {}, 'PRANKS'),
      h('label', { class: 'own-check' }, h('input', { type: 'checkbox', checked: pranksOn(), onchange: (e) => pref('pranks', e.target.checked ? null : 'off') }), ' Allow scary screen pranks from the Troll Panel (jump scares, spiders, lights out...)')),
    HALLOWEEN_END > Date.now() ? h('div', { class: 'field' }, h('label', {}, '🎃 HALLOWEEN'),
      h('label', { class: 'own-check' }, h('input', { type: 'checkbox', checked: pref('halloween') !== 'off', onchange: (e) => { pref('halloween', e.target.checked ? null : 'off'); applyHalloween(); } }), ' Show Halloween decorations (they leave on November 1st)')) : null,
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
    isOwner() ? accessEditor(sp, () => openSettings('server')) : null,
    h('button', { class: 'btn primary small', onclick: () => attempt(async () => { await api('/server', 'PATCH', { name: input.value, spaceId: sp.id }); toast2('Saved'); }) }, 'Save'),
    isAdmin() && !isFirst && !sp.system ? h('div', { class: 'field', style: 'margin-top:24px' }, h('label', {}, 'DANGER ZONE'),
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
  const movable = ordered.filter((r) => !SYSTEM_ROLES.includes(r.id));

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
      !SYSTEM_ROLES.includes(sel.id)
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

const ECO_KEYS = ['coins', 'freeRolls', 'nextSpinAt', 'owned', 'equipped', 'equippedFx', 'cost', 'baseCost', 'events', 'tags', 'packs', 'rarities', 'wheel'];
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
  const prevCoins = renderCoins.last; renderCoins.last = state.eco.coins;
  const nEl = h('span', { class: 'coin-n' }, '🪙 ' + state.eco.coins);
  if (prevCoins != null && prevCoins !== state.eco.coins && !calmMotion()) { nEl.classList.add('bump'); if (state.eco.coins > prevCoins) uiSound('coin'); }
  b.replaceChildren(h('span', { class: 'coin-ico' }, '🛍️'), h('span', { class: 'coin-lbl' }, 'Shop'), nEl);
  b.classList.toggle('ready', spinWait() === 0);
  b.classList.toggle('hot', liveEvents().length > 0);
  b.title = spinWait() === 0 ? 'Shop: your daily spin is ready!' : 'Shop: coins, wheel and tag packs';
}
function fmtWait(ms) {
  const s = Math.ceil(ms / 1000), p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
}
const fmtLeft = (ms) => { const s = Math.ceil(ms / 1000), p = (n) => String(n).padStart(2, '0'); return s >= 3600 ? `${Math.floor(s / 3600)}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}` : `${Math.floor(s / 60)}:${p(s % 60)}`; };
const evDetail = (e) => (e.type === 'luck' ? `rare chances x${e.mult}` : e.type === 'double' ? `wheel pays x${e.mult}` : e.type === 'sale' ? `${e.percent}% off packs` : e.type === 'rush' ? 'spin every hour' : e.type === 'refund' ? `duplicates pay x${e.mult}` : '');
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
    tabs.replaceChildren(...[['wheel', '🎡 Daily Wheel'], ['machine', '🎁 Tag Packs'], ['tags', '🏷 My Tags'], ['codes', '🎟️ Codes']].map(([id, label]) =>
      h('button', { type: 'button', class: 'rw-tab' + (id === which ? ' on' : ''), onclick: () => draw(id) }, label)));
    body.replaceChildren(which === 'wheel' ? wheelPane() : which === 'machine' ? machinePane(draw) : which === 'codes' ? codesPane(draw) : tagsPane(draw));
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

/* ---- celebration when a code is redeemed ---- */
function chime(kind) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    audioCtx = audioCtx || new AC(); const c = audioCtx; if (c.state === 'suspended') c.resume();
    const t0 = c.currentTime, note = (f, at, dur, vol, type = 'triangle') => { const o = c.createOscillator(), g = c.createGain(); o.type = type; o.frequency.value = f; g.gain.setValueAtTime(0.0001, t0 + at); g.gain.exponentialRampToValueAtTime(vol, t0 + at + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur); o.connect(g); g.connect(c.destination); o.start(t0 + at); o.stop(t0 + at + dur + 0.05); };
    if (kind === 'open') { [523, 659, 784, 1047, 1319].forEach((f, i) => note(f, 0.55 + i * 0.09, 0.5, 0.16)); note(2093, 0.95, 0.9, 0.07, 'sine'); }
    else if (kind === 'rumble') { for (let i = 0; i < 6; i++) note(120 + i * 18, i * 0.1, 0.12, 0.1, 'square'); }
    else if (kind === 'coin') { note(1568, 0, 0.12, 0.09, 'square'); note(2093, 0.07, 0.2, 0.09, 'square'); }
  } catch (e) { /* sound is optional */ }
}
function redeemCelebration(r) {
  const rw = r.reward || {}, tag = rw.tag, col = tag ? RARITY_COLOR[tag.rarity] || '#ffd23f' : '#ffd23f';
  document.getElementById('redeemFx')?.remove();
  const calm = calmMotion();
  const parts = [];
  if (!calm) {
    for (let i = 0; i < 34; i++) { const a = (i / 34) * Math.PI * 2 + Math.random() * 0.3, d = 140 + Math.random() * 260; parts.push(h('span', { class: 'rd-part', style: `--dx:${Math.cos(a) * d}px;--dy:${Math.sin(a) * d - 40}px;--rot:${Math.random() * 720 - 360}deg;animation-delay:${1.05 + Math.random() * 0.25}s;font-size:${18 + Math.random() * 18}px` }, ['🪙', '✨', '⭐', '🪙', '💫'][i % 5])); }
    for (let i = 0; i < 70; i++) parts.push(h('i', { class: 'fx-piece', style: `left:${Math.random() * 100}%;background:${['#ffd23f', '#ff8a3d', '#4ade80', '#38bdf8', '#e879f9', '#fff'][i % 6]};animation-delay:${1.2 + Math.random() * 1.2}s;animation-duration:${2.2 + Math.random() * 1.6}s` }));
  }
  const coinNum = h('b', { class: 'rd-num' }, '0');
  const cards = [];
  if (rw.coins) cards.push(h('div', { class: 'rd-card rd-coins' }, h('div', { class: 'rd-ico' }, '🪙'), h('div', { class: 'rd-big' }, '+', coinNum), h('div', { class: 'rd-lbl' }, 'coins')));
  if (tag) cards.push(h('div', { class: 'rd-card rd-tag', style: `--rc:${col}` }, h('div', { class: 'rd-ico' }, tag.icon || '🏷️'), h('div', { class: 'rd-big' }, tag.name), h('div', { class: 'rd-lbl' }, tag.rarity.toUpperCase() + (rw.duplicate ? ` · you had it, so +${rw.refund} coins` : ' · NEW TAG!'))));
  const fx = h('div', { id: 'redeemFx', class: 'redeemfx' + (calm ? ' calm' : ''), role: 'dialog', 'aria-label': 'Code redeemed' },
    h('div', { class: 'rd-rays', style: `--rc:${col}` }), h('div', { class: 'rd-flash' }),
    h('div', { class: 'rd-ticket' }, '🎟️'),
    h('div', { class: 'rd-title' }, '🎉 Code redeemed!'),
    h('div', { class: 'rd-cards' }, cards), ...parts,
    h('div', { class: 'rd-hint' }, 'Click anywhere to close'));
  document.body.append(fx);
  const done = () => { fx.classList.add('out'); setTimeout(() => fx.remove(), 450); document.removeEventListener('keydown', esc); };
  const esc = (e) => { if (e.key === 'Escape') done(); };
  fx.addEventListener('click', done); document.addEventListener('keydown', esc); setTimeout(() => { if (document.body.contains(fx)) done(); }, 7000);
  if (!calm) { chime('rumble'); setTimeout(() => chime('open'), 50); }
  // count the coins up
  const target = Number(rw.coins) || 0, start = performance.now() + 1100;
  const tick = (now) => { if (!document.body.contains(fx)) return; const k = Math.min(1, Math.max(0, (now - start) / 1200)); coinNum.textContent = Math.round(target * (1 - Math.pow(1 - k, 3))).toLocaleString('en-US'); if (k < 1) requestAnimationFrame(tick); };
  if (calm) coinNum.textContent = target.toLocaleString('en-US'); else requestAnimationFrame(tick);
}

function codesPane(redraw) {
  const input = h('input', { type: 'text', maxlength: 24, placeholder: 'Enter a code', 'aria-label': 'Redeem code', autocomplete: 'off', spellcheck: 'false' });
  const msg = h('div', { class: 'machine-msg' }, 'Got a code from the Owner? Type it here for a reward.');
  const go = () => attempt(async () => {
    if (!input.value.trim()) return toast('Type a code first');
    const r = await api('/codes/redeem', 'POST', { code: input.value });
    takeEco(r); syncRw(); input.value = '';
    msg.textContent = '🎉 ' + r.message; msg.classList.add('won');
    redeemCelebration(r);
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  return h('div', { class: 'codebox' }, h('p', { class: 'rw-sub' }, 'Redeem a code'), h('div', { class: 'code-row' }, input, h('button', { type: 'button', class: 'btn primary small', onclick: go }, 'Redeem')), msg,
    h('div', { class: 'note' }, 'Each code can be used once per person. Codes can run out or expire.'));
}

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
  const shopPacks = eco.packs.filter((p) => !p.closed && !p.noShop && !(p.until && ecoNow() >= p.until));
  if (!shopPacks.some((p) => p.id === shopPack)) shopPack = (shopPacks.find((p) => p.until) || shopPacks[0]).id;
  const pack = shopPacks.find((p) => p.id === shopPack);
  const owned = new Set(eco.owned);
  const packRow = h('div', { class: 'packs' }, shopPacks.map((p) => {
    const mine = eco.tags.filter((t) => t.pack === p.id && owned.has(t.id)).length, all = eco.tags.filter((t) => t.pack === p.id).length;
    return h('button', { type: 'button', class: 'packcard' + (p.id === shopPack ? ' on' : ''), onclick: () => { shopPack = p.id; redraw('machine'); } },
      h('span', { class: 'pk-ico' }, p.icon), h('b', {}, p.name), h('small', {}, `${mine}/${all} collected`), p.until ? h('span', { class: 'pk-limited' }, '⏳ LIMITED · leaves Nov 1') : null);
  }));
  const reel = h('div', { class: 'reel' }, h('span', { class: 'reel-text' }, pack.icon));
  const msg = h('div', { class: 'machine-msg' }, pack.blurb);
  const price = cost < eco.baseCost ? [h('s', {}, String(eco.baseCost)), ' ' + cost] : [String(cost)];
  const btn = h('button', { type: 'button', class: 'btn primary roll-btn' }, 'OPEN PACK — ', ...price, ' 🪙');
  const setLabel = () => { const f = state.eco.freeRolls || 0; btn.replaceChildren(...(f > 0 ? ['OPEN PACK — FREE 🎁 (' + f + ' left)'] : ['OPEN PACK — ', ...price, ' 🪙'])); };
  setLabel();
  const check = () => { setLabel(); btn.disabled = state.eco.coins < cost && !(state.eco.freeRolls > 0); if (btn.disabled) msg.textContent = `You need ${cost} coins — spin the wheel to earn more`; };
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
    setLabel(); btn.disabled = state.eco.coins < state.eco.cost && !(state.eco.freeRolls > 0);
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
    const c = RARITY_COLOR[t.rarity], has = owned.has(t.id), on = t.kind ? (eco.equippedFx || {})[t.kind] === t.id : eco.equipped === t.id;
    return h('button', {
      type: 'button', class: 'tagcard r-' + t.rarity + (t.limited ? ' limited' : '') + (has ? '' : ' locked') + (on ? ' on' : ''), style: `--rc:${c}`,
      title: has ? (on ? 'Click to remove' : 'Click to wear') : 'Not unlocked yet',
      onclick: () => { if (!has) return; attempt(async () => { takeEco(await api('/tags/equip', 'POST', { tag: on ? null : t.id, kind: t.kind || undefined })); if (t.kind) uiSound('pop'); redraw('tags'); }); },
    }, h('span', { class: 'tc-name' }, has ? (t.icon || '') + ' ' + t.name : (t.limited ? '🔒 ' + t.name : '👁 ???')), h('span', { class: 'tc-r' }, (t.limited ? 'LIMITED' : t.rarity) + (t.kind ? ' · ' + ({ ring: 'avatar ring', name: 'name effect', bg: 'profile background' })[t.kind] : '')), on ? h('span', { class: 'tc-on' }, 'Wearing') : null);
  };
  return h('div', { class: 'tags-pane' },
    h('p', { class: 'rw-sub' }, `You have ${owned.size} of ${eco.tags.length} tags. Pick one to show next to your name. ✨ Profile Effects change how your profile looks.`),
    eco.packs.map((p) => {
      const mine = eco.tags.filter((t) => t.pack === p.id);
      const sorted = mine.slice().sort((a, b) => RARITY_ORDER.indexOf(a.rarity) - RARITY_ORDER.indexOf(b.rarity));
      return h('section', { class: 'tg-pack' }, h('h4', {}, `${p.icon} ${p.name}`, h('small', {}, ` ${mine.filter((t) => owned.has(t.id)).length}/${mine.length}`)), p.noShop ? h('p', { class: 'rw-sub' }, 'Earn these by playing in a live show. They are never in the shop.') : null,
        h('div', { class: 'tagrid' }, sorted.map(mk)));
    }));
}

/* ------------------------------------------------------ update log */

state.updates = [];
const logSeen = () => { try { return Number(localStorage.getItem('logSeen')) || 0; } catch { return 0; } };
const markLogSeen = () => { try { localStorage.setItem('logSeen', String(state.updates.reduce((m, x) => Math.max(m, x.seq), 0))); } catch {} renderLogDot(); };
function renderLogDot() {
  const latest = state.updates.reduce((m, x) => Math.max(m, x.seq), 0);
  for (const id of ['railLogDot', 'headLogDot']) $(id).classList.toggle('hidden', !(latest > logSeen()));
}
async function loadUpdates() {
  try { state.updates = await api('/updates'); } catch { return; }
  renderLogDot();
  if (document.getElementById('ulogList')) drawLog();
}
$('railLog').onclick = $('headLog').onclick = openUpdateLog;

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
state.perks = state.perks || { troll: false, community: false };
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
      fr.unread[id] ? h('span', { class: 'dm-unread' }, String(fr.unread[id])) : null,
      h('button', { type: 'button', class: 'mini dm-call' + (inCallWith(id) ? ' live' : ''), 'data-uid': id, title: inCallWith(id) ? 'Hang up' : 'Call ' + userName(id) + ' privately', onclick: (e) => { e.stopPropagation(); callFriend(id); } }, inCallWith(id) ? '📵' : '📞'),
      h('button', { type: 'button', class: 'mini dm-vcall', 'data-uid': id, title: 'Start a private video call with ' + userName(id), onclick: (e) => { e.stopPropagation(); callFriend(id, true); } }, '🎥')), () => openChat(id), sub);
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
      h('button', { type: 'button', class: 'btn small dm-callbtn' + (inCallWith(id) ? ' live' : ''), 'data-uid': id, style: 'margin-left:auto', title: inCallWith(id) ? 'Hang up' : 'Start a private voice call', onclick: () => callFriend(id) }, inCallWith(id) ? '📵 Hang up' : '📞 Call'),
      h('button', { type: 'button', class: 'btn small dm-vcallbtn', 'data-uid': id, title: 'Start a private video call', onclick: () => callFriend(id, true) }, '🎥 Video'),
      h('button', { type: 'button', class: 'mini danger', onclick: async () => {
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
function friendButtons(user, inModal) {
  if (user.id === state.me) return null;
  const st = friendState(user.id), done = () => { hidePopover(); if (inModal) closeOverlay(); };
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

  const inviteOnlyBox = h('input', { type: 'checkbox', checked: data.inviteOnly !== false });
  inviteOnlyBox.addEventListener('change', () => attempt(async () => { await api('/owner/settings', 'PUT', { inviteOnly: inviteOnlyBox.checked }); toast2(inviteOnlyBox.checked ? 'Invite only is on' : 'Anyone can sign up now'); }));
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
  const rushMin = mins(), refMult = sel([[2, 'x2'], [3, 'x3'], [5, 'x5']], 2), refMin = mins();
  const jackAmt = h('input', { type: 'number', value: 1000, min: 100, max: 100000, 'aria-label': 'Jackpot coins' });
  const rainAmt = h('input', { type: 'number', value: 100, min: 1, max: 10000, 'aria-label': 'Coins per person' });
  const evRow = (icon, title, desc, controls, go, label = 'Start') => h('div', { class: 'ev-row' }, h('div', { class: 'ev-info' }, h('b', {}, `${icon} ${title}`), h('small', {}, desc)),
    h('div', { class: 'ev-ctl' }, controls, h('button', { class: 'btn primary small', onclick: go }, label)));
  const eventsSection = h('section', {}, h('h4', {}, '🎉 Events for everyone'),
    activeBox,
    evRow('🍀', 'Lucky Hour', 'Multiplies the chance of rare tags when opening packs', [luckMult, luckMin], () => start({ type: 'luck', mult: Number(luckMult.value), minutes: Number(luckMin.value) })),
    evRow('🎡', 'Double Coins', 'The Daily Wheel pays more', [dblMult, dblMin], () => start({ type: 'double', mult: Number(dblMult.value), minutes: Number(dblMin.value) })),
    evRow('🏷️', 'Pack Sale', 'Tag packs cost less', [salePct, saleMin], () => start({ type: 'sale', percent: Number(salePct.value), minutes: Number(saleMin.value) })),
    evRow('🎁', 'Coin Rain', 'Gives every member coins right now', [rainAmt], () => start({ type: 'gift', amount: Number(rainAmt.value) }), 'Give'),
    evRow('🔄', 'Free Spin For All', 'Everyone can spin the wheel again now', [], () => start({ type: 'freespin' })),
    evRow('⚡', 'Spin Rush', 'The Daily Wheel can be spun once an hour', [rushMin], () => start({ type: 'rush', minutes: Number(rushMin.value) })),
    evRow('♻️', 'Duplicate Bonus', 'Duplicate tags pay back more coins', [refMult, refMin], () => start({ type: 'refund', mult: Number(refMult.value), minutes: Number(refMin.value) })),
    evRow('🍬', 'Trick or Treat', 'Everyone gets a random 25 to 400 coin treat', [], () => start({ type: 'treat' }), 'Give'),
    evRow('📦', 'Free Pack For All', 'Everyone opens a free tag pack right now', [], () => start({ type: 'freepack' }), 'Give'),
    evRow('💎', 'Jackpot Draw', '3 online members each win the jackpot', [jackAmt], () => start({ type: 'jackpot', amount: Number(jackAmt.value) }), 'Draw'));

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
    ...ownerExtras(data, reopen),
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
      st.startedAt ? h('div', { class: 'note' }, 'Site running since ' + new Date(st.startedAt).toLocaleString() + ' (' + ago(st.startedAt) + '). If this is much newer than you expect, the site restarted.') : null,
      h('div', { class: 'note' }, 'Backups hold accounts, roles, chats, coins and tags. Uploaded pictures are not included.')),
    h('section', {}, h('h4', {}, 'Sign-ups & welcome'),
      h('label', { class: 'own-check' }, open, ' Allow new people to register'),
      h('label', { class: 'own-check' }, inviteOnlyBox, ' Invite only (new people need an invite code from you)'),
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
  return; // the welcome splash replaced this old intro
  // eslint-disable-next-line no-unreachable
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

/* ------------------------------------------------------------ v15: rules, panels, pranks, minigame, space access */

const SYSTEM_ROLES = ['owner', 'admin', 'community', 'member'];

/* ---- server rules ---- */
let rulesData = null;
async function loadRules() {
  if (!rulesData) { try { rulesData = await (await fetch('/api/rules')).json(); } catch (e) { return null; } }
  return rulesData;
}
function rulesNode(d) {
  return h('div', { class: 'rules' }, d.sections.map((sec) => h('section', {}, h('h4', {}, sec.title),
    h('ul', {}, sec.items.map(([t, x]) => h('li', {}, h('b', {}, t), h('span', {}, x)))))));
}
function openRules() {
  loadRules().then((d) => {
    if (!d) return toast('Could not load the rules');
    openOverlay(h('div', { class: 'modal rulesmodal' }, h('h2', {}, '📜 ' + d.title), rulesNode(d),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary small', onclick: closeOverlay }, 'Got it'))));
  });
}
$('rulesBtn').onclick = openRules;
$('authAgree').addEventListener('change', () => { $('authBtn').disabled = registerMode && !$('authAgree').checked; });

/* ---- pranks sent from the Troll Panel (people can switch them off in Settings > Appearance) ---- */
const pranksOn = () => pref('pranks') !== 'off';
const calmMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
const FX_NAMES = { jumpscare: 'a jump scare', blackout: 'lights out', spiders: 'a spider swarm', blood: 'blood', crack: 'a cracked screen', glitch: 'a glitch', eyes: 'creepy eyes', haunt: 'a haunting', hacked: 'a fake hack alert', shake: 'an earthquake', flip: 'a flip', zombie: 'zombie hands', confetti: 'confetti', peeker: 'a peeking figure', flicker: 'flickering lights', possessed: 'a possessed screen', whispers: 'whispers', fakeban: 'a fake ban notice', fakeupdate: 'a fake update', fakedelete: 'a fake delete-everything', virus: 'fake virus pop-ups', chaosintro: 'CHAOS' };

/* Scary sounds made with the browser's own audio (no files). Kept at a moderate volume. */
let audioCtx = null;
function scareSound(kind) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    audioCtx = audioCtx || new AC(); const c = audioCtx; if (c.state === 'suspended') c.resume();
    const t0 = c.currentTime, master = c.createGain(); master.gain.value = 0.34; master.connect(c.destination);
    const tone = (type, f0, f1, dur, vol, at = 0) => { const o = c.createOscillator(), g = c.createGain(); o.type = type; o.frequency.setValueAtTime(f0, t0 + at); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + at + dur); g.gain.setValueAtTime(0.0001, t0 + at); g.gain.exponentialRampToValueAtTime(vol, t0 + at + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur); o.connect(g); g.connect(master); o.start(t0 + at); o.stop(t0 + at + dur + 0.05); };
    const hiss = (dur, freq, vol, at = 0) => { const n = Math.max(1, Math.floor(c.sampleRate * dur)), buf = c.createBuffer(1, n, c.sampleRate), d = buf.getChannelData(0); for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1; const src = c.createBufferSource(); src.buffer = buf; const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; const g = c.createGain(); g.gain.setValueAtTime(vol, t0 + at); g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur); src.connect(f); f.connect(g); g.connect(master); src.start(t0 + at); };
    if (kind === 'scream') { tone('sawtooth', 650, 2100, 1.3, 0.55); tone('square', 480, 1700, 1.3, 0.35, 0.03); tone('sawtooth', 300, 1300, 1.2, 0.35, 0.1); tone('sawtooth', 910, 2600, 1.1, 0.3, 0.05); tone('square', 1300, 520, 1.0, 0.25, 0.2); hiss(1.3, 3200, 0.7); hiss(0.9, 1200, 0.5, 0.15); tone('sine', 70, 35, 0.6, 0.9); }
    else if (kind === 'boom') { tone('sine', 55, 22, 1.1, 1); hiss(0.5, 180, 0.9); hiss(0.25, 5000, 0.5); tone('square', 90, 40, 0.6, 0.35); }
    else if (kind === 'thud') tone('sine', 110, 28, 0.35, 1);
    else if (kind === 'heart') { for (let i = 0; i < 6; i++) { tone('sine', 70, 35, 0.18, 0.9, i * 0.9); tone('sine', 62, 32, 0.18, 0.7, i * 0.9 + 0.22); } }
    else if (kind === 'crack') { hiss(0.2, 7000, 0.8); tone('triangle', 2400, 300, 0.25, 0.4); hiss(0.5, 4000, 0.3, 0.1); }
    else if (kind === 'static') hiss(1.4, 2500, 0.7);
    else if (kind === 'creak') { tone('sawtooth', 140, 60, 1.4, 0.18); tone('sawtooth', 150, 70, 1.2, 0.12, 0.2); }
    else if (kind === 'laugh') { for (let i = 0; i < 5; i++) tone('sawtooth', 420 - i * 35, 300 - i * 30, 0.16, 0.35, i * 0.22); tone('sine', 60, 40, 1.2, 0.5); }
    else if (kind === 'whisper') { hiss(1.6, 1800, 0.25); hiss(1.2, 2600, 0.2, 0.6); }
    else if (kind === 'buzz') { tone('square', 100, 96, 0.9, 0.16); tone('sawtooth', 50, 48, 0.9, 0.2); hiss(0.9, 6000, 0.15); }
    else if (kind === 'ding') { tone('sine', 1320, 1320, 0.5, 0.3); tone('sine', 1760, 1760, 0.7, 0.2, 0.12); }
    else if (kind === 'alarm') { for (let i = 0; i < 6; i++) tone('square', i % 2 ? 880 : 660, i % 2 ? 880 : 660, 0.18, 0.25, i * 0.2); }
  } catch (e) { /* no audio available */ }
}

const FX = { layers: new Set(), timers: new Set(), undo: new Set() };
function fxLayer(seconds, blocking) {
  const layer = h('div', { class: 'fx-layer' + (blocking ? ' fx-block' : ''), 'aria-hidden': 'true' });
  document.body.append(layer); FX.layers.add(layer);
  fxLater(() => { layer.classList.add('fx-out'); fxLater(() => { layer.remove(); FX.layers.delete(layer); }, 600); }, seconds * 1000);
  return layer;
}
function fxLater(fn, ms) { const id = setTimeout(() => { FX.timers.delete(id); fn(); }, ms); FX.timers.add(id); return id; }
function fxClass(cls, seconds) { const app = $('app'); app.classList.add(cls); const off = () => app.classList.remove(cls); FX.undo.add(off); fxLater(off, seconds * 1000); }
function fxStopAll() { // Escape or a click on a scare ends every prank at once
  FX.layers.forEach((l) => l.remove()); FX.layers.clear(); FX.timers.forEach(clearTimeout); FX.timers.clear(); FX.undo.forEach((f) => f()); FX.undo.clear();
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && (FX.layers.size || FX.undo.size)) fxStopAll(); });
const frnd = (a, b) => a + Math.random() * (b - a);

const FX_RUN = {
  confetti() {
    const layer = fxLayer(3), colors = ['#ff8a3d', '#f5b83d', '#4ade80', '#3b82f6', '#e879f9', '#ef4444'];
    for (let i = 0; i < 90; i++) layer.append(h('i', { class: 'fx-piece', style: `left:${frnd(0, 100)}%;background:${colors[i % colors.length]};animation-delay:${frnd(0, 0.8)}s;animation-duration:${frnd(2, 3.6)}s;transform:rotate(${frnd(0, 360)}deg)` }));
  },
  jumpscare() {
    // 1) darkness and a heartbeat  2) a pale face far away that slowly gets closer  3) it LUNGES at the screen with a scream
    const layer = fxLayer(5.6, true), NS = 'http://www.w3.org/2000/svg';
    let teeth = '';
    for (let x = 52; x < 148; x += 10) teeth += `<polygon points="${x},176 ${x + 9},176 ${x + 4.5},${196 + (x % 3) * 4}" fill="#e8e2c0"/><polygon points="${x},206 ${x + 9},206 ${x + 4.5},${190 - (x % 3) * 3}" fill="#d9d2ac"/>`;
    const face = h('div', { class: 'fx-sc-face' });
    face.innerHTML = `<svg viewBox="0 0 200 250" xmlns="${NS}"><defs><radialGradient id="scSkin" cx="50%" cy="40%" r="65%"><stop offset="0" stop-color="#e3e5d8"/><stop offset=".7" stop-color="#8d9283"/><stop offset="1" stop-color="#2c2f29"/></radialGradient><radialGradient id="scEye"><stop offset="0" stop-color="#ff3b3b"/><stop offset="1" stop-color="#600"/></radialGradient></defs>
      <path d="M100 10C44 10 24 62 28 120c3 58 28 118 72 118s69-60 72-118c4-58-16-110-72-110z" fill="url(#scSkin)" stroke="#000" stroke-width="3"/>
      <path d="M60 40l14 30M140 36l-10 34M100 14v30M40 120l18 6M164 118l-20 8" stroke="#2a2d28" stroke-width="1.6" fill="none" opacity=".7"/>
      <ellipse cx="66" cy="96" rx="25" ry="34" transform="rotate(-12 66 96)" fill="#000"/><ellipse cx="134" cy="96" rx="25" ry="34" transform="rotate(12 134 96)" fill="#000"/>
      <circle cx="68" cy="102" r="7" fill="url(#scEye)"/><circle cx="132" cy="102" r="7" fill="url(#scEye)"/><circle cx="68" cy="102" r="2" fill="#fff"/><circle cx="132" cy="102" r="2" fill="#fff"/>
      <path d="M93 138q-5 12 2 16M107 138q5 12-2 16" stroke="#000" stroke-width="4" fill="none" stroke-linecap="round"/>
      <path d="M44 168Q100 150 156 168Q150 252 100 252T44 168z" fill="#050000"/>${teeth}
      <path d="M70 218q30 18 60 0" stroke="#7a0000" stroke-width="3" fill="none" opacity=".8"/></svg>`;
    layer.append(h('div', { class: 'fx-sc-dark' }), face, h('div', { class: 'fx-sc-strobe' }), h('div', { class: 'fx-sc-noise' }), h('div', { class: 'fx-sc-vig' }));
    scareSound('heart');
    fxLater(() => scareSound('creak'), 1300);
    fxLater(() => { scareSound('scream'); scareSound('boom'); fxClass('fx-quake', 1.6); }, 2650);
    layer.addEventListener('click', fxStopAll);
  },
  blackout(secs) {
    const layer = fxLayer(secs), dark = h('div', { class: 'fx-dark' }); layer.append(dark);
    for (let i = 0; i < 4; i++) layer.append(h('span', { class: 'fx-eyes-dark', style: `left:${frnd(8, 88)}%;top:${frnd(10, 85)}%;animation-delay:${frnd(0.5, secs * 0.6)}s` }, '👀'));
    const move = (e) => { const t = e.touches ? e.touches[0] : e; dark.style.setProperty('--x', t.clientX + 'px'); dark.style.setProperty('--y', t.clientY + 'px'); };
    dark.style.setProperty('--x', '50vw'); dark.style.setProperty('--y', '50vh');
    document.addEventListener('mousemove', move); document.addEventListener('touchmove', move);
    FX.undo.add(() => { document.removeEventListener('mousemove', move); document.removeEventListener('touchmove', move); });
    fxLater(() => { document.removeEventListener('mousemove', move); document.removeEventListener('touchmove', move); }, secs * 1000 + 700);
    scareSound('creak'); fxLater(() => scareSound('heart'), 1200); fxLater(() => scareSound('laugh'), Math.max(2500, secs * 600));
  },
  spiders(secs) {
    const layer = fxLayer(secs);
    const n = Math.min(40, 14 + secs * 2);
    for (let i = 0; i < n; i++) {
      const side = Math.floor(Math.random() * 4), W = innerWidth, H = innerHeight;
      const [x0, y0] = side === 0 ? [-60, frnd(0, H)] : side === 1 ? [W + 60, frnd(0, H)] : side === 2 ? [frnd(0, W), -60] : [frnd(0, W), H + 60];
      const x1 = frnd(0, W), y1 = frnd(0, H), ang = Math.atan2(y1 - y0, x1 - x0) * 180 / Math.PI + 90;
      const sp = h('span', { class: 'fx-spider', style: `left:${x0}px;top:${y0}px;--dx:${x1 - x0}px;--dy:${y1 - y0}px;--r:${ang}deg;font-size:${frnd(22, 46)}px;animation-delay:${frnd(0, secs * 0.45)}s;animation-duration:${frnd(2.2, 4.5)}s` }, '🕷️');
      sp.addEventListener('click', () => { sp.textContent = '💥'; sp.classList.add('squashed'); scareSound('thud'); });
      layer.append(sp);
    }
    scareSound('whisper'); fxLater(() => scareSound('creak'), 1500);
  },
  blood(secs) {
    const layer = fxLayer(secs); layer.append(h('div', { class: 'fx-bloodmist' }));
    for (let i = 0; i < 22; i++) layer.append(h('i', { class: 'fx-drip', style: `left:${frnd(0, 100)}%;width:${frnd(8, 26)}px;--len:${frnd(20, 75)}vh;animation-delay:${frnd(0, secs * 0.4)}s;animation-duration:${frnd(2.5, 5)}s` }));
    scareSound('heart');
  },
  crack(secs) {
    const layer = fxLayer(secs), NS = 'http://www.w3.org/2000/svg', W = innerWidth, H = innerHeight;
    const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('class', 'fx-crack'); svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const cx = frnd(W * 0.3, W * 0.7), cy = frnd(H * 0.3, H * 0.7), rays = 11;
    for (let r = 0; r < rays; r++) {
      let a = (r / rays) * Math.PI * 2 + frnd(-0.2, 0.2), x = cx, y = cy, d = `M${cx} ${cy}`;
      for (let k = 0; k < 9; k++) { a += frnd(-0.35, 0.35); const l = frnd(40, 130); x += Math.cos(a) * l; y += Math.sin(a) * l; d += ` L${x.toFixed(0)} ${y.toFixed(0)}`; if (x < -50 || x > W + 50 || y < -50 || y > H + 50) break; }
      const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); p.setAttribute('pathLength', '1'); p.style.animationDelay = frnd(0, 0.15) + 's'; svg.append(p);
    }
    for (let k = 1; k <= 3; k++) { const p = document.createElementNS(NS, 'circle'); p.setAttribute('cx', cx); p.setAttribute('cy', cy); p.setAttribute('r', k * 55 + frnd(-8, 8)); p.setAttribute('class', 'ring'); svg.append(p); }
    layer.append(svg, h('div', { class: 'fx-flash' })); scareSound('crack'); fxClass('fx-shake', 0.5);
  },
  glitch(secs) {
    fxClass('fx-glitch', 2.8); scareSound('static');
    fxLater(() => {
      const layer = fxLayer(Math.max(3, secs - 2), true);
      layer.append(h('div', { class: 'fx-crash' }, h('div', { class: 'fx-crash-ico' }, '⚠️'), h('b', {}, 'Warms has stopped working'), h('small', {}, 'Windows is collecting more information about the problem…'), h('div', { class: 'fx-bar' }, h('i', {}))));
      scareSound('alarm');
      layer.addEventListener('click', fxStopAll);
    }, 2800);
  },
  eyes(secs) {
    const layer = fxLayer(secs), pairs = [];
    for (let i = 0; i < 12; i++) {
      const eye = () => h('span', { class: 'fx-eye' }, h('i', {}));
      const pr = h('span', { class: 'fx-eyepair', style: `left:${frnd(3, 90)}%;top:${frnd(5, 88)}%;animation-delay:${frnd(0, secs * 0.5)}s;transform:scale(${frnd(0.7, 1.8)})` }, eye(), eye());
      pairs.push(pr); layer.append(pr);
    }
    const move = (e) => { const t = e.touches ? e.touches[0] : e; for (const pr of pairs) { const r = pr.getBoundingClientRect(), a = Math.atan2(t.clientY - (r.top + r.height / 2), t.clientX - (r.left + r.width / 2)); pr.style.setProperty('--px', Math.cos(a) * 5 + 'px'); pr.style.setProperty('--py', Math.sin(a) * 5 + 'px'); } };
    document.addEventListener('mousemove', move); FX.undo.add(() => document.removeEventListener('mousemove', move)); fxLater(() => document.removeEventListener('mousemove', move), secs * 1000 + 700);
    scareSound('whisper'); fxLater(() => scareSound('creak'), 1800);
  },
  haunt(secs) {
    const layer = fxLayer(secs); layer.append(h('div', { class: 'fx-cold' }));
    for (let i = 0; i < 5; i++) layer.append(h('span', { class: 'fx-ghost', style: `top:${frnd(5, 75)}%;font-size:${frnd(60, 150)}px;animation-delay:${i * (secs / 7)}s;animation-duration:${frnd(3, 5)}s` }, '👻'));
    scareSound('laugh'); fxLater(() => scareSound('whisper'), 1800);
  },
  hacked(secs) {
    const layer = fxLayer(Math.max(8, secs), true);
    const log = h('pre', { class: 'fx-term' }), count = h('div', { class: 'fx-count' }, '');
    layer.append(h('div', { class: 'fx-hack' }, h('b', { class: 'fx-hack-title' }, '☠ ACCOUNT COMPROMISED ☠'), log, count)); scareSound('alarm');
    const lines = ['> connecting to warms-server…', '> bypassing firewall… OK', '> reading messages… 100%', '> copying your coins… 🪙', '> uploading to evil-lair.exe…', '> ERASING EVERYTHING IN'];
    lines.forEach((l, i) => fxLater(() => { log.textContent += l + '\n'; }, 600 + i * 700));
    let n = 3; fxLater(() => { const tick = () => { count.textContent = n; if (n-- > 0) { scareSound('thud'); fxLater(tick, 900); } else { layer.querySelector('.fx-hack').replaceChildren(h('div', { class: 'fx-jk' }, '😈 JUST KIDDING!'), h('small', {}, 'Nothing happened. Your account is safe. Click anywhere to close.')); scareSound('laugh'); } }; tick(); }, 4800);
    layer.addEventListener('click', fxStopAll);
  },
  peeker(secs) {
    const layer = fxLayer(secs), NS = 'http://www.w3.org/2000/svg';
    const f = h('div', { class: 'fx-peek', style: `left:${frnd(25, 65)}%;--t:${secs}s` });
    f.innerHTML = `<svg viewBox="0 0 160 200" xmlns="${NS}"><ellipse cx="80" cy="110" rx="62" ry="86" fill="#d9ddd0" stroke="#000" stroke-width="3"/><ellipse cx="54" cy="92" rx="17" ry="24" fill="#000"/><ellipse cx="106" cy="92" rx="17" ry="24" fill="#000"/><circle cx="54" cy="96" r="4" fill="#fff"/><circle cx="106" cy="96" r="4" fill="#fff"/><path d="M48 150Q80 178 112 150" stroke="#000" stroke-width="3.5" fill="none" stroke-linecap="round"/><path d="M60 40Q80 20 100 40" stroke="#555" stroke-width="3" fill="none"/></svg>`;
    layer.append(h('div', { class: 'fx-cold' }), f);
    scareSound('creak'); fxLater(() => scareSound('whisper'), 1600); fxLater(() => scareSound('heart'), 2600);
  },
  flicker(secs) {
    const layer = fxLayer(secs, false), dark = h('div', { class: 'fx-flick' });
    layer.append(dark, h('div', { class: 'fx-iseeyou' }, 'I SEE YOU'));
    scareSound('buzz'); fxLater(() => scareSound('buzz'), 1800); fxLater(() => scareSound('heart'), 3000);
  },
  possessed(secs) {
    fxClass('fx-possessed', secs);
    const layer = fxLayer(secs), words = ['HELP ME', 'LET ME OUT', 'IT HURTS', 'BEHIND YOU', 'DON’T LOOK'];
    for (let i = 0; i < 7; i++) layer.append(h('span', { class: 'fx-curse', style: `left:${frnd(3, 80)}%;top:${frnd(5, 88)}%;animation-delay:${frnd(0, secs * 0.6)}s;font-size:${frnd(20, 54)}px` }, words[i % words.length]));
    scareSound('heart'); scareSound('static'); fxLater(() => scareSound('laugh'), 2200);
  },
  whispers(secs) {
    const layer = fxLayer(secs), phrases = ['behind you', 'don’t turn around', 'I’m in the walls', 'we can see you', 'why are you still here?', 'it’s getting closer', 'look up'];
    phrases.forEach((t, i) => layer.append(h('span', { class: 'fx-whisper', style: `left:${frnd(4, 70)}%;top:${frnd(8, 85)}%;animation-delay:${i * (secs / 9)}s` }, t)));
    layer.append(h('div', { class: 'fx-cold' })); scareSound('whisper'); fxLater(() => scareSound('whisper'), 2000); fxLater(() => scareSound('creak'), 3500);
  },
  fakeban(secs) {
    const layer = fxLayer(Math.max(secs, 7), true), sub = h('small', {}, 'Appeals take 4 to 6 business years.'), btn = h('button', { type: 'button', class: 'fx-fbtn' }, 'Appeal');
    layer.append(h('div', { class: 'fx-fakeban' }, h('div', { class: 'fx-fico' }, '🔨'), h('b', {}, 'You have been banned from Warms'), h('p', {}, 'Reason: being a little too awesome.'), sub, btn)); scareSound('thud'); fxLater(() => scareSound('alarm'), 300);
    btn.onclick = (e) => { e.stopPropagation(); btn.disabled = true; btn.textContent = 'Appeal denied ❌'; sub.textContent = '…'; fxLater(() => { layer.querySelector('.fx-fakeban').replaceChildren(h('div', { class: 'fx-jk' }, '😈 JUST KIDDING!'), h('small', {}, 'You are not banned. Click anywhere to close.')); scareSound('laugh'); }, 1600); };
    layer.addEventListener('click', (e) => { if (!layer.querySelector('.fx-fbtn')) fxStopAll(); });
  },
  fakeupdate(secs) {
    const layer = fxLayer(Math.max(secs, 9), true), pct = h('div', { class: 'fx-upct' }, '0%'), bar = h('i', {});
    layer.append(h('div', { class: 'fx-update' }, h('div', { class: 'fx-spin' }), h('b', {}, 'Installing update 37 of 37'), pct, h('div', { class: 'fx-bar big' }, bar), h('small', {}, 'Please do not close this tab. Your computer will restart several times.')));
    let p = 0; const tick = () => { p += p < 70 ? 6 : p < 90 ? 2 : 0.4; if (p >= 99) { p = 99; pct.textContent = '99%'; bar.style.width = '99%'; fxLater(() => { layer.querySelector('.fx-update').replaceChildren(h('div', { class: 'fx-jk' }, '😈 JUST KIDDING!'), h('small', {}, 'Nothing was installed. Click anywhere to close.')); scareSound('laugh'); }, 2600); return; } pct.textContent = Math.floor(p) + '%'; bar.style.width = p + '%'; fxLater(tick, 330); };
    tick(); layer.addEventListener('click', (e) => { if (!layer.querySelector('.fx-update')) fxStopAll(); });
  },
  fakedelete(secs) {
    const layer = fxLayer(Math.max(secs, 8), true), num = h('b', { class: 'fx-bignum' }, '0'), what = h('div', { class: 'fx-del-what' }, 'Deleting all messages…');
    layer.append(h('div', { class: 'fx-fakedel' }, h('div', { class: 'fx-fico' }, '🗑️'), what, num, h('small', {}, 'messages permanently removed')));
    scareSound('alarm'); let n = 0; const tick = () => { n += Math.floor(frnd(800, 4200)); num.textContent = n.toLocaleString('en-US'); if (n < 52000) fxLater(tick, 180); else { what.textContent = 'Deleting friends…'; scareSound('thud'); fxLater(() => { layer.querySelector('.fx-fakedel').replaceChildren(h('div', { class: 'fx-jk' }, '😈 JUST KIDDING!'), h('small', {}, 'Nothing was deleted. Click anywhere to close.')); scareSound('laugh'); }, 1500); } };
    tick(); layer.addEventListener('click', (e) => { if (layer.querySelector('.fx-jk')) fxStopAll(); });
  },
  virus(secs) {
    const layer = fxLayer(Math.max(secs, 9)), msgs = ['⚠ Your Warms has 37 viruses!', '🦠 A virus is eating your messages!', '⚠ Your coins are in danger!', '🔥 System overheating!', '☠ Click OK to remove all viruses', '👀 Someone is watching your screen'];
    scareSound('alarm');
    msgs.forEach((t, i) => fxLater(() => {
      const w = h('div', { class: 'fx-win', style: `left:${frnd(4, 60)}%;top:${frnd(6, 66)}%` }, h('div', { class: 'fx-wbar' }, 'Warning!', h('span', {}, '✕')), h('div', { class: 'fx-wbody' }, t, h('div', {}, h('button', { type: 'button' }, 'OK'), h('button', { type: 'button' }, 'Remove virus'))));
      w.addEventListener('click', (e) => { if (e.target.closest('button') || e.target.closest('.fx-wbar span')) { w.remove(); scareSound('ding'); } });
      layer.append(w); scareSound('ding');
    }, i * 700));
  },
  chaosintro() { scareSound('alarm'); fxClass('fx-quake', 1.2); const layer = fxLayer(2.4); layer.append(h('div', { class: 'fx-chaos' }, '💀 CHAOS 💀')); },
  shake(secs) { fxClass('fx-quake', secs); scareSound('thud'); fxLater(() => scareSound('thud'), 600); },
  flip(secs) { fxClass('fx-flip', secs); },
  zombie(secs) {
    const layer = fxLayer(secs);
    for (let i = 0; i < 9; i++) layer.append(h('span', { class: 'fx-hand', style: `left:${frnd(2, 92)}%;font-size:${frnd(50, 110)}px;animation-delay:${frnd(0, secs * 0.5)}s` }, '🧟‍♂️'));
    layer.append(h('div', { class: 'fx-fogbottom' })); scareSound('whisper'); fxLater(() => scareSound('thud'), 900);
  },
};
function runTroll(m) {
  if (!pranksOn()) return;
  const secs = Math.min(20, Math.max(3, Number(m.seconds) || 8));
  if (m.by && m.effect !== 'confetti') toast2(`🎭 ${m.by} sent ${FX_NAMES[m.effect] || 'a prank'}. Press Esc to stop it`);
  if (calmMotion() && m.effect !== 'confetti') return; // motion sensitivity: skip the animation, keep the message
  const run = FX_RUN[m.effect]; if (run) run(secs);
}

function openTrollPanel() {
  if (!state.perks.troll) return;
  const target = h('select', { 'aria-label': 'Who gets it' }, h('option', { value: 'all' }, '👥 Everyone'),
    state.users.filter((u) => u.id !== state.me).map((u) => h('option', { value: u.id }, u.username)));
  const secs = h('select', { 'aria-label': 'How long' }, [[5, '5 seconds'], [8, '8 seconds'], [12, '12 seconds'], [20, '20 seconds']].map(([v, l]) => h('option', { value: v, selected: v === 8 }, l)));
  const GROUPS = [
    ['😱 Scary', [['jumpscare', '👹', 'Jump scare'], ['blackout', '🔦', 'Lights out'], ['spiders', '🕷️', 'Spider swarm'], ['blood', '🩸', 'Blood drip'], ['eyes', '👁️', 'Creepy eyes'], ['haunt', '👻', 'Haunting'], ['zombie', '🧟', 'Zombie hands'], ['peeker', '🫥', 'Peeking figure'], ['flicker', '💡', 'Flickering lights'], ['possessed', '😈', 'Possessed screen'], ['whispers', '🗣️', 'Whispers']]],
    ['💻 Fake system screens', [['glitch', '📺', 'Glitch and crash'], ['hacked', '💻', 'Fake hack alert'], ['fakeban', '🔨', 'Fake ban notice'], ['fakeupdate', '⬇️', 'Fake update'], ['fakedelete', '🗑️', 'Fake delete-everything'], ['virus', '🦠', 'Fake virus pop-ups']]],
    ['🌀 Shake it up', [['crack', '💥', 'Cracked screen'], ['shake', '🌋', 'Earthquake'], ['flip', '🙃', 'Flip upside down']]],
  ];
  const fx = GROUPS.flatMap((g) => g[1]);
  const go = (id) => attempt(async () => {
    await api('/troll', 'POST', { effect: id, target: target.value, seconds: Number(secs.value) });
    toast2('🎭 Sent!');
  });
  openOverlay(h('div', { class: 'ownerp panel-troll' },
    h('button', { class: 'close', title: 'Close', onclick: closeOverlay }, '✕'),
    h('div', { class: 'own-crown' }, '🎭'),
    h('h2', {}, 'Troll Panel'),
    h('p', { class: 'own-sub' }, 'Spooky pranks with sound. They only show on screen and never change anyone’s data. People can press Esc to stop one, or turn pranks off in their settings.'),
    h('div', { class: 'tr-row tr-sticky' }, h('label', {}, 'Who'), target, h('label', {}, 'For'), secs),
    h('div', { class: 'tr-top' },
      h('button', { type: 'button', class: 'btn small tr-chaos', onclick: () => go('chaos') }, '💀 CHAOS: four random pranks in a row'),
      h('button', { type: 'button', class: 'btn small tr-rand', onclick: () => go(fx[Math.floor(Math.random() * fx.length)][0]) }, '🎲 Random')),
    GROUPS.map(([title, list]) => h('section', { class: 'tr-group' }, h('h4', {}, title),
      h('div', { class: 'tr-grid' }, list.map(([id, ic, name]) => h('button', { type: 'button', class: 'tr-btn', onclick: () => go(id) }, h('span', { class: 'tr-ic' }, ic), name))))),
    h('div', { class: 'note' }, isOwner() ? 'As Owner you have no cooldowns.' : 'Trolling Everyone has a cooldown (45 seconds, 90 for CHAOS) so it stays fun.'),
    h('div', { class: 'note' }, 'Be kind: the server rules still apply to pranks too. Sound only plays if their browser allows it.')));
}
$('trollBtn').onclick = openTrollPanel;

/* ---- the minigame: Number Rush ---- */
state.mg = { active: false };
let mgOffset = 0;
function renderMgBtn() {
  const b = $('railGame');
  const live = state.mg && state.mg.active && !state.mg.won && state.mg.endsAt - (Date.now() + mgOffset) > 0;
  b.classList.toggle('hidden', !live);
}
async function loadMinigame() {
  try { state.mg = await api('/minigame'); mgOffset = state.mg.now ? state.mg.now - Date.now() : 0; } catch (e) { return; }
  renderMgBtn();
}
setInterval(() => { if (state.mg && state.mg.active) renderMgBtn(); }, 5000);
$('railGame').onclick = () => openMinigame();

function openMinigame() {
  const g = state.mg;
  if (!g || !g.active) return toast2('No minigame is running right now');
  const box = h('div', { class: 'modal mg' });
  let timerId = null, run = null;
  const stop = () => { if (timerId) clearInterval(timerId); timerId = null; };
  const close = () => { stop(); closeOverlay(); };
  const left = () => Math.max(0, Math.round((g.endsAt - (Date.now() + mgOffset)) / 1000));
  const fmtLeft = () => { const s = left(); return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`; };

  function intro(msg) {
    stop();
    box.replaceChildren(
      h('h2', {}, '🎮 Number Rush'),
      h('p', {}, `Tap the numbers 1 to 16 in order. Finish in `, h('b', {}, `${g.limit} seconds`), ' or less to win ', h('b', {}, g.reward.label), '!'),
      msg ? h('div', { class: 'mg-msg' }, msg) : null,
      h('div', { class: 'note' }, `Ends in ${fmtLeft()} · ${g.wins} winner${g.wins === 1 ? '' : 's'}${g.maxWinners ? ` of ${g.maxWinners}` : ''} so far. You can try as many times as you like.`),
      h('div', { class: 'actions' }, h('button', { class: 'btn ghost small', onclick: close }, 'Close'), h('button', { class: 'btn primary small', onclick: begin }, msg ? 'Try again' : 'Start')));
  }
  async function begin() {
    let r;
    try { r = await api('/minigame/start', 'POST'); } catch (e) { toast(e.message); await loadMinigame(); return close(); }
    run = { layout: r.layout, next: 1, startedAt: performance.now(), limit: r.limit, id: r.id };
    const timeEl = h('span', { class: 'mg-time' }, '0.0s'), nextEl = h('span', { class: 'mg-next' }, 'Find 1');
    const grid = h('div', { class: 'mg-grid' }, run.layout.map((n) => h('button', { type: 'button', class: 'mg-cell', 'data-n': n, onclick: (e) => tap(n, e.currentTarget) }, String(n))));
    box.replaceChildren(h('div', { class: 'mg-bar' }, nextEl, timeEl, h('span', { class: 'mg-lim' }, `/ ${run.limit}s`)), grid);
    stop();
    timerId = setInterval(() => {
      const t = (performance.now() - run.startedAt) / 1000;
      timeEl.textContent = t.toFixed(1) + 's';
      timeEl.classList.toggle('late', t > run.limit);
      if (t > run.limit + 0.3) { stop(); intro(`Time's up! You needed ${run.limit} seconds or less.`); }
    }, 100);
    function tap(n, el) {
      if (n !== run.next) { el.classList.add('bad'); setTimeout(() => el.classList.remove('bad'), 250); return; }
      el.classList.add('done'); el.disabled = true; run.next++;
      nextEl.textContent = run.next > 16 ? 'Done!' : 'Find ' + run.next;
      if (run.next > 16) finish();
    }
    async function finish() {
      stop();
      let res;
      try { res = await api('/minigame/finish', 'POST', { id: run.id }); } catch (e) { toast(e.message); await loadMinigame(); return close(); }
      if (res.won) {
        takeEco(res); renderCoins();
        if (!calmMotion()) runTroll({ effect: 'confetti', seconds: 3 });
        state.mg.won = true; renderMgBtn();
        box.replaceChildren(h('h2', {}, '🏆 You did it!'), h('p', {}, `${res.time.toFixed(1)} seconds.`), h('div', { class: 'mg-msg win' }, res.prize),
          h('div', { class: 'actions' }, h('button', { class: 'btn primary small', onclick: close }, 'Nice')));
      } else intro(res.reason);
    }
  }
  intro();
  openOverlay(box);
}


/* ---- Admin Panel: a panel of its own for Admins (and the Owner) ---- */
function openAdminPanel() {
  if (!isAdmin()) return;
  const body = h('div', {});
  const panel = h('div', { class: 'ownerp panel-admin' },
    h('button', { class: 'close', title: 'Close', onclick: closeOverlay }, '✕'),
    h('div', { class: 'own-crown' }, '🛠️'),
    h('h2', {}, 'Admin Panel'),
    h('p', { class: 'own-sub' }, 'Members, reports, AutoMod and what staff did lately. ' + state.serverName),
    body);
  openOverlay(panel);
  if (showData && showData.canRun) panel.append(showMaker());
  let search = '';
  const load = async () => {
    let d;
    try { d = await api('/admin/panel'); } catch (e) { return toast(e.message); }
    const top = panel.scrollTop;
    const say = h('textarea', { rows: 2, maxlength: 300, placeholder: 'Announcement for #general…', 'aria-label': 'Announcement' });
    const find = h('input', { type: 'text', placeholder: 'Find a member…', value: search, 'aria-label': 'Find a member', autocomplete: 'off' });
    const list = h('div', { class: 'adm-members' });
    const roleName = (id) => (d.roles.find((r) => r.id === id) || { name: id === 'owner' ? 'Owner' : id }).name;
    const act = (fn, msg) => attempt(async () => { await fn(); await refresh(); if (msg) toast2(msg); load(); });
    const drawMembers = () => {
      const q = find.value.trim().toLowerCase(); search = find.value;
      const rows = d.members.filter((m) => !q || m.username.toLowerCase().includes(q)).slice(0, 60);
      list.replaceChildren(...(rows.length ? rows.map((m) => {
        const roleSel = h('select', { 'aria-label': 'Role of ' + m.username, onchange: () => act(() => api(`/users/${m.id}/role`, 'PUT', { roleId: roleSel.value }), m.username + ' is now ' + roleName(roleSel.value)) },
          d.roles.map((r) => h('option', { value: r.id, selected: r.id === m.roleId }, r.name)), m.roleId === 'owner' ? h('option', { value: 'owner', selected: true }, 'Owner') : null);
        const muteSel = h('select', { 'aria-label': 'Mute ' + m.username, onchange: () => { const v = Number(muteSel.value); if (v >= 0) act(() => api(`/users/${m.id}/mute`, 'PUT', { minutes: v }), v ? m.username + ' was muted' : m.username + ' was unmuted'); } },
          h('option', { value: -1 }, m.muted ? `Muted · ${m.muted}m left` : 'Mute…'), [[10, '10 minutes'], [60, '1 hour'], [1440, '1 day'], [10080, '1 week']].map(([v, l]) => h('option', { value: v }, l)), m.muted ? h('option', { value: 0 }, 'Unmute now') : null);
        return h('div', { class: 'adm-row' },
          h('div', { class: 'adm-who' }, h('i', { class: 'adm-dot' + (m.online ? ' on' : '') }), h('b', {}, m.username), m.id === d.me ? h('small', {}, ' (you)') : null, h('small', { class: 'adm-role' }, roleName(m.roleId))),
          m.canManage ? h('div', { class: 'adm-ctl' }, roleSel, muteSel,
            h('button', { type: 'button', class: 'btn small danger', onclick: async () => { if (await confirmBox('Remove ' + m.username + '?', 'Their account is deleted for good. They can sign up again later.', 'Remove')) act(() => api('/users/' + m.id, 'DELETE'), m.username + ' was removed'); } }, 'Remove'))
            : h('small', { class: 'adm-lock' }, m.id === d.me ? '' : 'Same rank or higher'));
      }) : [h('div', { class: 'note' }, 'Nobody matches.')]));
    };
    find.addEventListener('input', drawMembers); drawMembers();
    const open = d.reports.filter((r) => !r.resolved);
    const amWords = h('textarea', { rows: 2, placeholder: 'blocked words, separated by spaces or commas', 'aria-label': 'Blocked words' }); amWords.value = (d.automod.words || []).join(', ');
    const amOn = h('input', { type: 'checkbox', checked: !!d.automod.enabled });
    body.replaceChildren(
      h('div', { class: 'own-stats' }, h('div', {}, h('b', {}, d.members.length), h('span', {}, 'members')), h('div', {}, h('b', {}, d.members.filter((m) => m.online).length), h('span', {}, 'online')), h('div', {}, h('b', {}, d.members.filter((m) => m.muted).length), h('span', {}, 'muted')), h('div', {}, h('b', {}, open.length), h('span', {}, 'open reports'))),
      h('section', {}, h('h4', {}, '⚡ Command Center'), h('div', { class: 'note' }, 'Live stats, the admin console with commands, and the broadcast tool.'),
        h('button', { class: 'btn primary small', style: 'margin-top:8px', onclick: () => { closeOverlay(); openCommandCenter(); } }, '⚡ Open Command Center')),
      h('section', {}, h('h4', {}, '📣 Announce in #general'), say,
        h('button', { class: 'btn primary small', style: 'margin-top:8px', onclick: () => attempt(async () => { await api('/community/announce', 'POST', { text: say.value }); say.value = ''; toast2('Posted in #general'); load(); }) }, 'Post announcement')),
      h('section', {}, h('h4', {}, '👥 Members'), find, list, h('div', { class: 'note' }, 'You can change the role of, mute or remove people ranked below you. Role changes take effect right away.')),
      h('section', {}, h('h4', {}, `🚩 Reports (${open.length} open)`),
        d.reports.length ? d.reports.slice(0, 12).map((r) => h('div', { class: 'own-report' + (r.resolved ? ' done' : '') },
          h('div', { class: 'rr-head' }, h('b', {}, r.username), h('span', { class: 'rr-kind' }, (REPORT_KINDS.find((k) => k[0] === r.kind) || [0, 'Other'])[1]), h('span', { class: 'time' }, fmtStamp(r.ts))),
          h('div', { class: 'rr-msg' }, r.message),
          h('div', { class: 'adm-ctl' }, h('button', { type: 'button', class: 'btn small', onclick: () => act(() => api(`/admin/reports/${r.id}/resolve`, 'POST'), r.resolved ? 'Reopened' : 'Marked as done') }, r.resolved ? 'Reopen' : '✓ Done'),
            h('button', { type: 'button', class: 'btn small ghost', onclick: () => act(() => api('/admin/reports/' + r.id, 'DELETE'), 'Report deleted') }, 'Delete'))))
          : h('div', { class: 'note' }, 'No reports.')),
      h('section', {}, h('h4', {}, '🛡️ AutoMod'),
        h('label', { class: 'own-check' }, amOn, ' Block the words below in chat (the sender gets a warning, then a timeout)'), amWords,
        h('button', { class: 'btn small', style: 'margin-top:8px', onclick: () => act(() => api('/admin/automod', 'PUT', { enabled: amOn.checked, words: amWords.value.split(/[\s,]+/).filter(Boolean) }), 'AutoMod saved') }, 'Save AutoMod'),
        d.automod.muted.length ? h('div', { class: 'note' }, 'Muted by AutoMod: ' + d.automod.muted.map((m) => `${m.username} (${m.minutes}m)`).join(', ')) : null),
      h('section', {}, h('h4', {}, '📜 Recent staff actions'),
        d.audit.length ? d.audit.map((a) => h('div', { class: 'own-row' }, h('span', { class: 'own-name' }, `${a.by}: ${a.text}`), h('span', { class: 'time' }, ago(a.ts)))) : h('div', { class: 'note' }, 'Nothing yet.')));
    panel.scrollTop = top;
  };
  load();
}
$('adminPanelBtn').onclick = openAdminPanel;

/* ---- Community Panel ---- */
function openCommunityPanel() {
  if (!state.perks.community) return;
  const body = h('div', {});
  const panel = h('div', { class: 'ownerp panel-comm' },
    h('button', { class: 'close', title: 'Close', onclick: closeOverlay }, '✕'),
    h('div', { class: 'own-crown' }, '🌟'),
    h('h2', {}, 'Community Panel'),
    h('p', { class: 'own-sub' }, 'Announcements and a look after the community. ' + state.serverName),
    body);
  openOverlay(panel);
  const load = async () => {
    let d;
    try { d = await api('/community/overview'); } catch (e) { return toast(e.message); }
    state.mg = d.minigame || state.mg; mgOffset = d.now - Date.now(); renderMgBtn();
    const say = h('textarea', { rows: 2, maxlength: 300, placeholder: 'Announcement for #general…', 'aria-label': 'Announcement' });
    body.replaceChildren(
      h('div', { class: 'own-stats three' }, h('div', {}, h('b', {}, d.members), h('span', {}, 'members')), h('div', {}, h('b', {}, d.online), h('span', {}, 'online')), h('div', {}, h('b', {}, d.muted.length), h('span', {}, 'muted'))),
      h('section', {}, h('h4', {}, '📣 Announce in #general'), say,
        h('button', { class: 'btn primary small', style: 'margin-top:8px', onclick: () => attempt(async () => { await api('/community/announce', 'POST', { text: say.value }); say.value = ''; toast2('Posted in #general'); }) }, 'Post announcement'),
        h('div', { class: 'note' }, 'It shows up in #general only, with a pop-up for people reading it.')),
      h('section', {}, h('h4', {}, '🎉 Events'), d.events.length ? d.events.map((e) => h('div', { class: 'note' }, `${e.icon} ${e.name} is running until ${new Date(e.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`)) : h('div', { class: 'note' }, 'No event is running.'), h('div', { class: 'note' }, 'Only the Owner starts events.')),
      h('section', {}, h('h4', {}, '🎮 Minigame'), d.minigame && d.minigame.active
        ? h('div', { class: 'note' }, `Number Rush is live: ${d.minigame.limit}s for ${d.minigame.reward.label}. ${d.minigame.wins} winner(s) so far.`)
        : h('div', { class: 'note' }, 'No minigame is running. The Owner starts them from the Owner Panel.')),
      h('section', {}, h('h4', {}, '🆕 Newest members'),
        d.newest.map((u) => h('div', { class: 'own-row' }, h('span', { class: 'own-name' }, u.username + (u.online ? ' · online' : '')), h('span', { class: 'time' }, fmtStamp(u.createdAt))))),
      h('section', {}, h('h4', {}, '🔇 Muted right now'),
        d.muted.length ? d.muted.map((m) => h('div', { class: 'own-row' }, h('span', { class: 'own-name' }, `${m.username} · ${m.minutes}m left`),
          h('button', { class: 'btn small', onclick: () => attempt(async () => { await api(`/users/${m.id}/mute`, 'PUT', { minutes: 0 }); await refresh(); toast2(m.username + ' was unmuted'); load(); }) }, 'Unmute')))
          : h('div', { class: 'note' }, 'Nobody is muted.')),
      h('section', {}, h('h4', {}, '🚩 Open reports'),
        d.reports.length ? d.reports.map((r) => h('div', { class: 'own-report' }, h('div', { class: 'rr-head' }, h('b', {}, r.username), h('span', { class: 'rr-kind' }, (REPORT_KINDS.find((k) => k[0] === r.kind) || [0, 'Other'])[1]), h('span', { class: 'time' }, fmtStamp(r.ts))), h('div', { class: 'rr-msg' }, r.message)))
          : h('div', { class: 'note' }, 'No open reports.')));
  };
  load();
}
$('commBtn').onclick = openCommunityPanel;

/* ---- Owner Panel extras: surprise event, minigame, troll access ---- */
function ownerExtras(data, reopen) {
  const surprise = h('section', {}, h('h4', {}, '🎲 Surprise event'),
    h('div', { class: 'note' }, 'One press starts a random cool event for everyone, with confetti.'),
    h('button', { class: 'btn primary small', style: 'margin-top:8px', onclick: () => attempt(async () => { const r = await api('/owner/surprise', 'POST'); takeEco(await api('/economy')); toast2('🎲 ' + r.text); }) }, '🎲 Surprise everyone!'));

  const rank = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4, croma: 5 };


  const voiceBox = h('div', { class: 'note' }, 'Checking…');
  api('/ice').then((r) => { voiceBox.className = 'note ' + (r.relay ? 'store-ok' : 'store-bad'); voiceBox.textContent = r.relay ? '✔ A relay server is set up. Voice and calls work even on phones and strict networks.' : '⚠ No relay server. Voice only works when both people’s networks allow direct connections, so some friends (phones, school or work Wi-Fi) may not hear each other.'; }).catch(() => { voiceBox.textContent = 'Could not check.'; });
  const voiceSection = h('section', {}, h('h4', {}, '🎙️ Voice'), voiceBox,
    h('div', { class: 'note' }, 'To add a relay: make a free account at metered.ca (it gives you an app name and an API key), then add two settings on Render under Environment: METERED_APP (your app name) and METERED_API_KEY. Redeploy and this turns green. You can also use your own TURN server with TURN_URLS, TURN_USERNAME and TURN_CREDENTIAL.'));

  const invBox = h('div', {});
  const invUses = h('select', { 'aria-label': 'People who can use it' }, [[1, '1 person'], [3, '3 people'], [5, '5 people'], [10, '10 people'], [50, '50 people']].map(([v, l]) => h('option', { value: v }, l)));
  const invExp = h('select', { 'aria-label': 'Ends' }, [[0, 'Never ends'], [60, 'In 1 hour'], [1440, 'In 1 day'], [10080, 'In 7 days']].map(([v, l]) => h('option', { value: v }, l)));
  const invNote = h('input', { type: 'text', maxlength: 40, placeholder: 'Who is it for? (optional)', 'aria-label': 'Note' });
  const invLink = (code) => location.origin + location.pathname.replace(/index\.html$/, '') + '?invite=' + code;
  const copy = (text, what) => { try { navigator.clipboard.writeText(text).then(() => toast2(what + ' copied')).catch(() => toast(text)); } catch (e) { toast(text); } };
  const drawInv = (list) => invBox.replaceChildren(...(list.length ? list.map((i) => {
    const dead = (i.expiresAt && i.expiresAt <= Date.now()) || i.uses >= i.maxUses;
    return h('div', { class: 'code-item' },
      h('div', {}, h('b', {}, i.code), h('small', {}, `${i.note ? i.note + ' · ' : ''}${i.uses}/${i.maxUses} used${i.usedBy.length ? ' (' + i.usedBy.join(', ') + ')' : ''}${dead ? ' · finished' : i.expiresAt ? ' · ends ' + new Date(i.expiresAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''}`)),
      h('span', {}, h('button', { type: 'button', class: 'btn small', onclick: () => copy(invLink(i.code), 'Invite link') }, 'Copy link'), ' ',
        h('button', { type: 'button', class: 'btn small ghost', onclick: () => attempt(async () => { drawInv((await api('/owner/invites/' + encodeURIComponent(i.code), 'DELETE')).invites); }) }, 'Delete')));
  }) : [h('div', { class: 'note' }, 'No invites yet. Make one and send the link to your friend.')]));
  api('/owner/invites').then((r) => drawInv(r.invites)).catch(() => {});
  const invSection = h('section', {}, h('h4', {}, '✉️ Invites'),
    h('div', { class: 'note' }, 'The site is invite only: new people need an invite to sign up. Make an invite, copy the link and send it to your friend. People who already have an account are not affected.'),
    h('div', { class: 'code-form' }, h('label', {}, 'Can be used by', invUses), h('label', {}, 'Ends', invExp), h('label', { class: 'wide' }, 'Note', invNote)),
    h('button', { type: 'button', class: 'btn primary small', style: 'margin-top:8px', onclick: () => attempt(async () => {
      const r = await api('/owner/invites', 'POST', { maxUses: Number(invUses.value), expiresIn: Number(invExp.value), note: invNote.value }); invNote.value = ''; drawInv(r.invites); copy(invLink(r.code), 'Invite link');
    }) }, 'Make invite'),
    invBox);

  const ipBox = h('div', {});
  const ipSel = h('select', { 'aria-label': 'Member to IP ban' }, h('option', { value: '' }, 'Choose a member…'), state.users.filter((u) => u.id !== state.me).map((u) => h('option', { value: u.id }, u.username)));
  const ipDel = h('input', { type: 'checkbox' });
  const drawBans = (list) => ipBox.replaceChildren(...(list.length ? list.map((b) => h('div', { class: 'code-item' },
    h('div', {}, h('b', {}, b.username), h('small', {}, `${b.ip} · ${fmtStamp(b.ts)}`)),
    h('button', { type: 'button', class: 'btn small', onclick: () => attempt(async () => { drawBans((await api('/owner/ipbans/' + encodeURIComponent(b.id), 'DELETE')).bans); toast2('Ban lifted'); }) }, 'Unban'))) : [h('div', { class: 'note' }, 'Nobody is IP banned.')]));
  api('/owner/ipbans').then((r) => drawBans(r.bans)).catch(() => {});
  const ipSection = h('section', {}, h('h4', {}, '🚫 IP ban'),
    h('div', { class: 'note' }, 'Bans the internet address(es) a person has used. When they open the site they only see "This site has been deleted." They are signed out right away. Careful: people on the same Wi-Fi or network share an address, and a VPN or new network gets around it.'),
    h('div', { class: 'own-add' }, ipSel, h('button', { type: 'button', class: 'btn primary small', onclick: async () => {
      if (!ipSel.value) return toast('Choose a member first');
      const name = userName(ipSel.value);
      if (!(await confirmBox('IP ban ' + name + '?', `${name} will be signed out and their address will only see "This site has been deleted."${ipDel.checked ? ' Their account will also be deleted.' : ''}`, 'IP ban'))) return;
      attempt(async () => { const r = await api('/owner/ipban', 'POST', { userId: ipSel.value, deleteAccount: ipDel.checked }); drawBans(r.bans); toast2(name + ' is IP banned'); await refresh(); reopen(); });
    } }, 'IP ban')),
    h('label', { class: 'own-check' }, ipDel, ' Also delete their account'),
    ipBox);

  const codesBox = h('div', {});
  const cCode = h('input', { type: 'text', maxlength: 24, placeholder: 'Leave empty for a random one', 'aria-label': 'Code' });
  const cCoins = h('input', { type: 'number', min: 0, max: 1000000, value: 100, 'aria-label': 'Coins' });
  const cTag = h('select', { 'aria-label': 'Tag reward' }, h('option', { value: '' }, 'No tag'),
    ((state.eco && state.eco.tags) || []).slice().sort((a, b) => rank[b.rarity] - rank[a.rarity]).map((t) => h('option', { value: t.id }, `${t.icon} ${t.name} (${t.rarity})`)));
  const cUses = h('input', { type: 'number', min: 0, max: 100000, value: 0, 'aria-label': 'Uses' });
  const cExp = h('select', { 'aria-label': 'Expires' }, [[0, 'Never'], [60, 'In 1 hour'], [1440, 'In 1 day'], [10080, 'In 7 days'], [43200, 'In 30 days']].map(([v, l]) => h('option', { value: v }, l)));
  const drawCodes = (list) => codesBox.replaceChildren(...(list.length ? list.map((c) => h('div', { class: 'code-item' },
    h('div', {}, h('b', {}, c.code), h('small', {}, [c.coins ? c.coins.toLocaleString('en-US') + ' coins' : '', c.tag ? (tagDef(c.tag) ? tagDef(c.tag).icon + ' ' + tagDef(c.tag).name : 'a tag') : ''].filter(Boolean).join(' + ') + ` · used ${c.uses}${c.maxUses ? '/' + c.maxUses : ''}` + (c.expiresAt ? (c.expiresAt <= Date.now() ? ' · expired' : ' · ends ' + new Date(c.expiresAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })) : ''))),
    h('span', {}, h('button', { type: 'button', class: 'btn small', onclick: () => { try { navigator.clipboard.writeText(c.code); toast2('Copied ' + c.code); } catch (e) { toast(c.code); } } }, 'Copy'), ' ',
      h('button', { type: 'button', class: 'btn small ghost', onclick: () => attempt(async () => { drawCodes((await api('/owner/codes/' + encodeURIComponent(c.code), 'DELETE')).codes); }) }, 'Delete')))) : [h('div', { class: 'note' }, 'No codes yet.')]));
  api('/owner/codes').then((r) => drawCodes(r.codes)).catch(() => {});
  const codes = h('section', {}, h('h4', {}, '🎟️ Redeem codes'),
    h('div', { class: 'note' }, 'Make a code and tell people. When they type it in the Shop (Codes tab) they get the reward you pick. Each person can use a code once.'),
    h('div', { class: 'code-form' },
      h('label', { class: 'wide' }, 'Code', cCode), h('label', {}, '🪙 Coins', cCoins), h('label', {}, '🏷️ Tag', cTag), h('label', {}, 'Max uses (0 = no limit)', cUses), h('label', {}, 'Ends', cExp)),
    h('button', { type: 'button', class: 'btn primary small', style: 'margin-top:8px', onclick: () => attempt(async () => {
      const r = await api('/owner/codes', 'POST', { code: cCode.value, coins: Number(cCoins.value) || 0, tag: cTag.value || null, maxUses: Number(cUses.value) || 0, expiresIn: Number(cExp.value) || 0 });
      cCode.value = ''; drawCodes(r.codes); toast2('Code ' + r.code.code + ' created');
    }) }, 'Create code'),
    codesBox);

  const rtype = h('select', { 'aria-label': 'Prize' }, h('option', { value: 'coins' }, '🪙 Coins'), h('option', { value: 'tag' }, '🏷️ A tag'));
  const amount = h('input', { type: 'number', value: 200, min: 1, max: 100000, 'aria-label': 'Coins' });
  const tagSel = h('select', { 'aria-label': 'Tag prize' }, ((state.eco && state.eco.tags) || []).slice().sort((a, b) => rank[b.rarity] - rank[a.rarity]).map((t) => h('option', { value: t.id }, `${t.icon} ${t.name} (${t.rarity})`)));
  const limit = h('input', { type: 'number', value: 25, min: 8, max: 120, 'aria-label': 'Seconds to beat' });
  const minutes = h('input', { type: 'number', value: 10, min: 1, max: 120, 'aria-label': 'Minutes it stays open' });
  const maxW = h('input', { type: 'number', value: 0, min: 0, max: 1000, 'aria-label': 'Winner limit' });
  const sync = () => { amount.style.display = rtype.value === 'coins' ? '' : 'none'; tagSel.style.display = rtype.value === 'tag' ? '' : 'none'; };
  rtype.addEventListener('change', sync); sync();
  const status = h('div', { class: 'mg-status' });
  const paint = () => {
    const g = state.mg;
    if (!g || !g.id) { status.replaceChildren(h('div', { class: 'note' }, 'No minigame has been played yet.')); return; }
    status.replaceChildren(
      h('div', { class: 'note ' + (g.active ? 'store-ok' : '') }, `${g.active ? '● LIVE' : 'Last game (ended)'}: beat ${g.limit}s for ${g.reward.label} · ${g.wins} winner${g.wins === 1 ? '' : 's'}`),
      ...(g.winners || []).slice(0, 12).map((w) => h('div', { class: 'own-row' }, h('span', { class: 'own-name' }, '🏆 ' + w.username), h('span', { class: 'time' }, w.time.toFixed(1) + 's'))),
      g.active ? h('button', { class: 'btn danger small', style: 'margin-top:6px', onclick: () => attempt(async () => { state.mg = await api('/owner/minigame', 'DELETE'); renderMgBtn(); paint(); toast2('Minigame ended'); }) }, 'End it now') : null);
  };
  api('/minigame').then((g) => { state.mg = g; mgOffset = g.now ? g.now - Date.now() : 0; paint(); renderMgBtn(); }).catch(() => paint());
  const mg = h('section', {}, h('h4', {}, '🎮 Minigame (Number Rush)'),
    h('div', { class: 'note' }, 'Everyone gets a 🎮 button. Whoever taps 1 to 16 fast enough wins the prize. The server times it.'),
    h('div', { class: 'mg-form' },
      h('label', {}, 'Beat it in (seconds)', limit), h('label', {}, 'Prize', rtype), h('label', { class: 'amt' }, 'Amount', amount, tagSel),
      h('label', {}, 'Stays open (minutes)', minutes), h('label', {}, 'Max winners (0 = anyone)', maxW)),
    h('button', { class: 'btn primary small', style: 'margin-top:8px', onclick: () => attempt(async () => {
      state.mg = await api('/owner/minigame', 'POST', { limit: Number(limit.value), rewardType: rtype.value, amount: Number(amount.value), tag: tagSel.value, minutes: Number(minutes.value), maxWinners: Number(maxW.value) });
      mgOffset = state.mg.now - Date.now(); renderMgBtn(); paint(); toast2('Minigame started. Everyone was told');
    }) }, '🎮 Start minigame'), status);

  const trollSet = new Set(data.troll || []);
  const trollRows = state.users.filter((u) => u.id !== state.me).map((u) => {
    const btn = h('button', { class: 'btn small' + (trollSet.has(u.id) ? ' primary' : ''), onclick: () => attempt(async () => {
      const want = !trollSet.has(u.id);
      await api('/owner/troll-access', 'PUT', { userId: u.id, allowed: want });
      if (want) trollSet.add(u.id); else trollSet.delete(u.id);
      btn.textContent = want ? 'Has it · take back' : 'Give'; btn.classList.toggle('primary', want);
    }) }, trollSet.has(u.id) ? 'Has it · take back' : 'Give');
    return h('div', { class: 'own-row' }, avatar(u, true), h('span', { class: 'own-name' }, u.username), btn);
  });
  const troll = h('section', {}, h('h4', {}, '🎭 Troll Panel'),
    h('div', { class: 'note' }, 'You always have it. Give it to people you trust, and take it back any time.'),
    h('button', { class: 'btn primary small', style: 'margin:8px 0', onclick: () => { closeOverlay(); openTrollPanel(); } }, '🎭 Open Troll Panel'),
    h('button', { class: 'btn small', style: 'margin:8px 0 8px 8px', onclick: () => { closeOverlay(); openCommunityPanel(); } }, '🌟 Open Community Panel'),
    trollRows.length ? trollRows : h('div', { class: 'note' }, 'Nobody else is here yet.'));
  return [invSection, surprise, codes, mg, showMaker(), pollMaker(), countdownMaker(), webGamesMaker(), troll, voiceSection, ipSection];
}

/* ---- new space: the Owner can limit it to some roles ---- */
function roleChecklist(selected) {
  const boxes = state.roles.filter((r) => r.id !== 'owner').map((r) => {
    const cb = h('input', { type: 'checkbox', value: r.id, checked: selected.includes(r.id) });
    return h('label', { class: 'own-check' }, cb, h('span', { class: 'dot', style: `background:${r.color};display:inline-block;width:10px;height:10px;border-radius:50%;margin:0 6px` }), r.name);
  });
  return { node: h('div', { class: 'role-checks' }, boxes), value: () => boxes.map((b) => b.querySelector('input')).filter((i) => i.checked).map((i) => i.value) };
}

function accessEditor(sp, reopen) {
  const cur = Array.isArray(sp.roles) ? sp.roles : [];
  const list = roleChecklist(cur);
  return h('div', { class: 'field', style: 'margin-top:18px' }, h('label', {}, 'WHO CAN SEE THIS SPACE (OWNER ONLY)'),
    h('div', { class: 'note' }, sp.system ? 'The Staff Hub is only for the roles ticked below (you can always get in).' : 'Tick roles to make this space private to them. Tick nothing to open it to everyone. You can always get in.'),
    list.node,
    h('button', { class: 'btn primary small', style: 'margin-top:8px', onclick: () => attempt(async () => { await api(`/spaces/${sp.id}/access`, 'PUT', { roles: list.value() }); await refresh(); toast2('Access saved'); reopen(); }) }, 'Save access'));
}

async function newSpace() {
  if (!isAdmin()) return toast('Only the Owner and Admins can create spaces');
  const name = h('input', { type: 'text', maxlength: 32, placeholder: 'Space name', 'aria-label': 'Space name' });
  const list = isOwner() ? roleChecklist([]) : null;
  const create = () => {
    if (!name.value.trim()) return toast('Give the space a name');
    attempt(async () => {
      const r = await api('/spaces', 'POST', Object.assign({ name: name.value.trim() }, list && list.value().length ? { roles: list.value() } : {}));
      closeOverlay(); await refresh(); state.spaceId = r.space.id; await switchChannel(r.channel.id); toast2('Created ' + r.space.name);
    });
  };
  openOverlay(h('form', { class: 'modal', onsubmit: (e) => { e.preventDefault(); create(); } },
    h('h2', {}, 'New space'), name,
    list ? h('div', { class: 'field', style: 'margin-top:14px' }, h('label', {}, 'WHO CAN SEE IT (OWNER ONLY)'),
      h('div', { class: 'note' }, 'Tick roles to make it private to them. Tick nothing and everyone can see it. You can change this later in the space settings.'), list.node) : null,
    h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn ghost small', onclick: closeOverlay }, 'Cancel'), h('button', { type: 'submit', class: 'btn primary small' }, 'Create'))));
  name.focus();
}

/* ------------------------------------------------------------ voice chat
   Audio goes straight between browsers (WebRTC). The server only passes the handshake along. */

const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] };
const V = { room: null, local: null, peers: new Map(), muted: false, deaf: false, ctx: null, pending: false, screen: null, sharer: null, watching: null, sharePending: false, cam: null };
const wsSend = (o) => { if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(o)); };


/* ---- private calls between friends ---- */
const callRoom = (id) => 'dm:' + [state.me, id].sort().join(':');
const callPeer = (room) => (room && room.startsWith('dm:') ? room.split(':').slice(1).find((x) => x !== state.me) : null);
const inCallWith = (id) => V.room === callRoom(id);
function callFriend(id, video) {
  if (!state.fr || !state.fr.friends.includes(id)) return toast('You can only call your friends');
  if (inCallWith(id)) return leaveVoice();
  joinVoice(callRoom(id), { video: !!video });
}
let ringTimer = null, ringAudio = null;
function ringTone(on) {
  clearInterval(ringAudio); ringAudio = null;
  if (!on) return;
  const beep = () => { try { const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return; audioCtx = audioCtx || new AC(); const c = audioCtx; if (c.state === 'suspended') c.resume(); const t0 = c.currentTime; [0, 0.28].forEach((d) => { const o = c.createOscillator(), g = c.createGain(); o.type = 'sine'; o.frequency.value = d ? 880 : 660; g.gain.setValueAtTime(0.0001, t0 + d); g.gain.exponentialRampToValueAtTime(0.18, t0 + d + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, t0 + d + 0.25); o.connect(g); g.connect(c.destination); o.start(t0 + d); o.stop(t0 + d + 0.3); }); } catch (e) { /* no sound */ } };
  beep(); ringAudio = setInterval(beep, 1600);
}
function hideRing(room) { const el = $('callRing'); if (el && (!room || el.dataset.room === room)) { el.remove(); ringTone(false); clearTimeout(ringTimer); } }
function showRing(m) {
  hideRing();
  const u = userById(m.from);
  const el = h('div', { id: 'callRing', class: 'callring', 'data-room': m.room, role: 'alertdialog', 'aria-label': 'Incoming call' },
    u ? avatar(u, true) : null,
    h('div', { class: 'cr-text' }, h('b', {}, (u ? u.username : m.name) + ' is calling you'), h('small', {}, m.video ? 'Private video call 🎥' : 'Private voice call')),
    h('button', { type: 'button', class: 'cr-btn yes', title: 'Answer', onclick: () => { hideRing(); joinVoice(m.room, { video: !!m.video }); } }, m.video ? '🎥 Answer' : '📞 Answer'),
    h('button', { type: 'button', class: 'cr-btn no', title: 'Decline', onclick: () => { hideRing(); wsSend({ t: 'call-decline', room: m.room }); } }, '✕ Decline'));
  document.body.append(el); ringTone(true);
  ringTimer = setTimeout(() => hideRing(m.room), 46000);
}

async function joinVoice(room, opts) {
  if (V.pending) return;
  if (V.room === room) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return toast('Voice needs a secure (https) connection and a browser with microphone support');
  V.pending = true;
  try {
    leaveVoice();
    try {
      V.local = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    } catch (e) { return toast('Could not use your microphone. Allow microphone access for this site and try again.'); }
    V.cam = null;
    if (opts && opts.video && room.startsWith('dm:')) {
      try { V.cam = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 } }, audio: false }); }
      catch (e) { toast('Could not use your camera, so this is a voice call. Allow camera access for this site to use video.'); }
    }
    try { const r = await api('/ice'); V.ice = { iceServers: r.iceServers }; V.relay = !!r.relay; } catch (e) { V.ice = ICE; V.relay = false; }
    V.room = room; V.muted = false; V.deaf = false; V.blocked = false;
    watchLevel('me', V.local);
    wsSend({ t: 'voice-join', room, video: !!V.cam });
    renderVoice(); syncCams();
  } finally { V.pending = false; }
}

function leaveVoice(silent) {
  if (V.room && !silent) wsSend({ t: 'voice-leave' });
  cleanupVoice();
}

function cleanupVoice() {
  if (V.cam) { V.cam.getTracks().forEach((t) => { t.onended = null; t.stop(); }); V.cam = null; }
  if (V.screen) { V.screen.getTracks().forEach((t) => { t.onended = null; t.stop(); }); V.screen = null; }
  for (const id of [...V.peers.keys()]) dropPeer(id);
  V.sharer = null; V.watching = null;
  if (V.local) V.local.getTracks().forEach((t) => t.stop());
  V.local = null; V.room = null; V.muted = false; V.deaf = false;
  levels.clear();
  renderVoice(); syncCams();
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
  const pc = new RTCPeerConnection(V.ice || ICE);
  const peer = { state: 'connecting', pc, audio: null, video: null, queue: [], polite: String(state.me) < String(id), makingOffer: false, ignoreOffer: false, screenSender: null, camSender: null, tags: {}, cam: null };
  V.peers.set(id, peer);
  V.local.getTracks().forEach((t) => pc.addTrack(t, V.local));
  if (V.screen) addScreenTrack(peer);
  if (V.cam) addCamTrack(peer);
  pc.onicecandidate = (e) => { if (e.candidate) wsSend({ t: 'voice-signal', to: id, data: { candidate: e.candidate } }); };
  pc.ontrack = (e) => {
    if (e.track.kind === 'video' && peer.tags[(e.streams[0] || {}).id] === 'cam') {
      peer.cam = e.streams[0];
      e.track.onended = () => { peer.cam = null; syncCams(); };
      syncCams();
      return;
    }
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
    peer.audio.play().catch(() => { V.blocked = true; renderVoice(); });
    watchLevel(id, e.streams[0]);
  };
  const peerName = () => (userById(id) || {}).username || 'someone';
  pc.onconnectionstatechange = () => {
    const st = pc.connectionState; peer.state = st;
    if (st === 'connected') { clearTimeout(peer.timer); peer.warned = false; }
    if (st === 'disconnected') setTimeout(() => { if (V.peers.get(id) === peer && pc.connectionState === 'disconnected') { try { pc.restartIce(); } catch (e) { /* closed */ } } }, 3000);
    if (st === 'failed') {
      try { pc.restartIce(); } catch (e) { /* closed */ }
      if (!peer.warned) { peer.warned = true; toast(`Cannot connect your voice to ${peerName()}. One of your networks blocks direct voice.` + (V.relay ? '' : ' The Owner can fix this by adding a relay server (Owner Panel > Voice).')); }
    }
    renderVoice();
  };
  peer.timer = setTimeout(() => { if (V.peers.get(id) === peer && pc.connectionState !== 'connected' && !peer.warned) { peer.warned = true; peer.state = 'failed'; toast(`Still cannot connect to ${peerName()}…` + (V.relay ? ' Try leaving and joining again.' : ' Their network may block direct voice. The Owner can add a relay server (Owner Panel > Voice).')); renderVoice(); } }, 15000);
  pc.onnegotiationneeded = async () => {
    try {
      peer.makingOffer = true;
      await setLocal(pc);
      wsSend({ t: 'voice-signal', to: id, data: { sdp: pc.localDescription } });
    } catch (e) { /* peer left */ }
    finally { peer.makingOffer = false; }
  };
  renderVoice();
  return peer;
}

async function onVoiceSignal(from, data) {
  if (!V.room || !V.local || !data) return;
  const peer = makePeer(from);
  const pc = peer.pc;
  if (data.cam) { peer.tags[data.cam] = 'cam'; return; }
  if (data.camOff) { peer.cam = null; syncCams(); return; }
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
  V.peers.delete(id); clearTimeout(p.timer);
  p.pc.onicecandidate = p.pc.ontrack = p.pc.onconnectionstatechange = p.pc.onnegotiationneeded = null;
  try { p.pc.close(); } catch (e) { /* already closed */ }
  if (p.audio) { p.audio.srcObject = null; p.audio.remove(); }
  p.video = null; p.cam = null; syncCams();
  levels.delete(id);
  syncScreen();
}

/* ---- camera (private video calls): own stream, tagged so the other side can tell it from a shared screen ---- */

function addCamTrack(peer) {
  const track = V.cam && V.cam.getVideoTracks()[0];
  if (!track || peer.camSender) return;
  try {
    wsSend({ t: 'voice-signal', to: [...V.peers].find(([, x]) => x === peer)[0], data: { cam: V.cam.id } });
    peer.camSender = peer.pc.addTrack(track, V.cam);
  } catch (e) { /* peer is closing */ }
}

async function startCam() {
  if (!V.room || V.cam || V.camPending) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return toast('Video needs a secure (https) connection and a camera');
  V.camPending = true;
  try {
    V.cam = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 } }, audio: false });
  } catch (e) { V.camPending = false; return toast('Could not use your camera. Allow camera access for this site and try again.'); }
  V.camPending = false;
  if (!V.room) { V.cam.getTracks().forEach((t) => t.stop()); V.cam = null; return; }
  V.cam.getVideoTracks()[0].onended = () => stopCam();
  V.peers.forEach(addCamTrack);
  renderVoice(); syncCams();
}

function stopCam() {
  const s = V.cam;
  if (!s) return;
  V.cam = null;
  V.peers.forEach((p, id) => {
    if (p.camSender) { try { p.pc.removeTrack(p.camSender); } catch (e) { /* closed */ } p.camSender = null; }
    wsSend({ t: 'voice-signal', to: id, data: { camOff: true } });
  });
  s.getTracks().forEach((t) => { t.onended = null; t.stop(); });
  renderVoice(); syncCams();
}

// The little video wall of a private video call (their camera big, yours small).
function syncCams() {
  let box = $('camWall');
  const remote = V.room ? [...V.peers].filter(([, p]) => p.cam) : [];
  if (!V.room || (!remote.length && !V.cam)) { if (box) box.remove(); return; }
  if (!box) {
    box = h('div', { id: 'camWall', class: 'camwall' });
    document.body.append(box);
  }
  const want = new Map(remote.map(([id, p]) => ['u' + id, [p.cam, userName(id), false]]));
  if (V.cam) want.set('me', [V.cam, 'You', true]);
  [...box.children].forEach((c) => { if (!want.has(c.dataset.k) || c.querySelector('video').srcObject !== want.get(c.dataset.k)[0]) c.remove(); });
  want.forEach(([stream, name, me], k) => {
    if (box.querySelector('[data-k="' + k + '"]')) return;
    const video = h('video', { autoplay: true, playsinline: true });
    video.muted = true; video.srcObject = stream;
    video.play().catch(() => {});
    box.append(h('div', { class: 'camtile' + (me ? ' me' : ''), 'data-k': k }, video, h('span', { class: 'camname' }, name)));
  });
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

// Browsers (Safari especially) can block call audio until the page is touched. Any tap or key press turns it on.
function unlockAudio() {
  if (!V.room) return;
  let any = false;
  V.peers.forEach((p) => { if (p.audio && p.audio.srcObject && p.audio.paused) { any = true; p.audio.play().then(() => {}).catch(() => {}); } });
  for (const c of [V.ctx, audioCtx]) if (c && c.state === 'suspended') c.resume().catch(() => {});
  if (V.blocked && (any || !V.peers.size || [...V.peers.values()].every((p) => !p.audio || !p.audio.paused))) { V.blocked = false; renderVoice(); }
}
['click', 'touchstart', 'keydown'].forEach((ev) => document.addEventListener(ev, unlockAudio, { passive: true }));

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
  document.querySelectorAll('.dm-call, .dm-callbtn').forEach((b) => { const on = inCallWith(b.dataset.uid), big = b.classList.contains('dm-callbtn'); b.classList.toggle('live', on); b.textContent = on ? (big ? '📵 Hang up' : '📵') : (big ? '📞 Call' : '📞'); });
  document.querySelectorAll('.dm-vcall, .dm-vcallbtn').forEach((b) => { b.hidden = inCallWith(b.dataset.uid); });
  syncScreen();
  if (V.room) {
    const dmWith = callPeer(V.room), c = dmWith ? { name: 'Call with ' + userName(dmWith) } : state.voiceChannels.find((x) => x.id === V.room);
    const alone = dmWith && !(((state.voice || {})[V.room]) || []).some((p) => p.userId !== state.me);
    const peers = [...V.peers.values()], linking = peers.length && !peers.some((p) => p.state === 'connected'), broken = peers.length && peers.every((p) => p.state === 'failed');
    const vb = (cls, icon, label, title, fn) => h('button', { class: 'vbtn ' + cls, title, onclick: fn }, h('span', { class: 'vb-ico' }, icon), h('span', { class: 'vb-lbl' }, label));
    bar.replaceChildren(
      h('div', { class: 'vb-info' }, h('div', { class: 'vb-state' }, h('i', { class: 'pulse' }), alone ? 'Calling…' : broken ? '⚠ Cannot connect' : linking ? 'Connecting…' : dmWith ? 'In a call' : 'Voice connected'), h('div', { class: 'vb-room' }, c ? (dmWith ? '📞 ' : '🔊 ') + c.name : '')),
      h('div', { class: 'vb-btns' },
        vb(V.muted ? 'off' : '', V.muted ? '🔇' : '🎤', V.muted ? 'Unmute' : 'Mute', V.muted ? 'You are muted. Click to turn your microphone back on' : 'Turn your microphone off', () => setVoiceState(!V.muted, V.deaf && V.muted ? false : V.deaf)),
        vb(V.deaf ? 'off' : '', V.deaf ? '🙉' : '🎧', V.deaf ? 'Hear' : 'Deafen', V.deaf ? 'You cannot hear anyone. Click to hear again' : 'Stop hearing everyone (also mutes you)', () => setVoiceState(!V.deaf, !V.deaf)),
        dmWith ? vb(V.cam ? 'live' : '', V.cam ? '📷' : '🎥', V.cam ? 'Cam off' : 'Camera', V.cam ? 'Turn your camera off' : 'Turn your camera on for this call', () => (V.cam ? stopCam() : startCam())) : null,
        canShare() ? vb(V.screen ? 'live' : '', '🖥', V.screen ? 'Stop' : 'Share', V.screen ? 'You are sharing your screen. Click to stop' : 'Share your screen with everyone in this channel', () => (V.screen ? stopShare() : startShare())) : null,
        V.blocked ? vb('live', '🔊', 'Tap to hear', 'Your browser is blocking sound. Tap to turn it on', () => unlockAudio()) : null,
        vb('leave', '📞', dmWith ? 'Hang up' : 'Leave', dmWith ? 'End the call' : 'Disconnect from this voice channel', () => leaveVoice())));
  }
}
window.addEventListener('beforeunload', () => { if (V.room) wsSend({ t: 'voice-leave' }); });


/* ------------------------------------------------- playful touches: sounds, bursts, bouncy motion */
const soundsOn = () => pref('sounds') !== 'off';
const bouncyOn = () => pref('bouncy') !== 'off' && !calmMotion();
function applyBouncy() { document.body.classList.toggle('bouncy', bouncyOn()); }
applyBouncy();
let lastTick = 0;
function uiSound(kind) {
  if (!soundsOn()) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    if (kind === 'tick') { const n = performance.now(); if (n - lastTick < 60) return; lastTick = n; }
    audioCtx = audioCtx || new AC(); const c = audioCtx;
    if (c.state === 'suspended') { c.resume().catch(() => {}); if (c.state === 'suspended') return; }
    const t0 = c.currentTime, master = c.createGain(); master.gain.value = 0.5; master.connect(c.destination);
    const note = (f0, f1, dur, vol, at = 0, type = 'sine') => { const o = c.createOscillator(), g = c.createGain(); o.type = type; o.frequency.setValueAtTime(f0, t0 + at); o.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t0 + at + dur); g.gain.setValueAtTime(0.0001, t0 + at); g.gain.exponentialRampToValueAtTime(vol, t0 + at + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur); o.connect(g); g.connect(master); o.start(t0 + at); o.stop(t0 + at + dur + 0.03); };
    if (kind === 'tick') note(1000, 640, 0.05, 0.05, 0, 'triangle');
    else if (kind === 'pop') note(480, 1000, 0.09, 0.12);
    else if (kind === 'send') { note(420, 820, 0.11, 0.09); note(820, 1100, 0.08, 0.05, 0.07); }
    else if (kind === 'recv') { note(700, 900, 0.1, 0.07); note(1050, 1050, 0.14, 0.05, 0.08); }
    else if (kind === 'coin') { note(1250, 1650, 0.08, 0.09, 0, 'square'); note(1650, 1650, 0.2, 0.08, 0.07, 'square'); }
    else if (kind === 'win') [523, 659, 784, 1046].forEach((f, i) => note(f, f, 0.22, 0.1, i * 0.09, 'triangle'));
    else if (kind === 'lose') { note(330, 160, 0.4, 0.09, 0, 'sawtooth'); }
    else if (kind === 'flip') note(280, 1400, 0.28, 0.06, 0, 'triangle');
    else if (kind === 'whack') { note(220, 70, 0.14, 0.18); note(900, 400, 0.06, 0.08); }
    else if (kind === 'spin') note(500 + Math.random() * 300, 300, 0.05, 0.04, 0, 'square');
  } catch (e) { /* no audio available */ }
}
document.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('button, .channel, .skin, .ar-card')) uiSound('tick'); }, true);

// A little shower of emoji from an element (reactions, sent party messages...).
function burstAt(el, emoji, n = 8) {
  if (!bouncyOn() || !el || !el.getBoundingClientRect) return;
  const r = el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + Math.random() * 0.6, d = 36 + Math.random() * 46;
    const sp = h('span', { class: 'burst', style: `left:${cx}px;top:${cy}px;--dx:${Math.cos(a) * d}px;--dy:${Math.sin(a) * d - 18}px;--rot:${(Math.random() - 0.5) * 120}deg;font-size:${14 + Math.random() * 10}px` }, emoji);
    document.body.append(sp); setTimeout(() => sp.remove(), 900);
  }
}
function popConfetti() { if (bouncyOn()) { const run = FX_RUN.confetti; if (run) run(); } }

/* ------------------------------------------------------------------ v20: profile pages */
const ROLE_ICON = { owner: '♛', admin: '🔧', community: '🌟', manager: '🛡️', moderator: '🔨' };
// Floating things on a profile: petals, embers, confetti, sparkles... one kind per background.
function particleLayer(type) {
  const cfg = { default: [14, ['•']], dusk: [16, ['🌸', '🌺', '✿']], aurora: [22, ['✦', '✧', '✨']], stars: [30, ['✦', '·', '•']], lava: [22, ['●']], prism: [30, ['■']], slash: [34, ['']], overdrive: [34, ['']], bloodmoon: [11, ['🦇', '🦇', '🦇', '🕷️']] }[type] || [14, ['•']];
  const rnd = (a, b) => a + Math.random() * (b - a), colors = ['#ff3b6b', '#ffb300', '#43e97b', '#38bdf8', '#a855f7'];
  const layer = h('div', { class: 'pc-fx t-' + type }), kids = [];
  for (let i = 0; i < cfg[0]; i++) {
    const sp = h('span', { style: `--w:${rnd(90, 230).toFixed(0)}px;--a:${rnd(-70, 70).toFixed(0)}deg;--x:${rnd(0, 96).toFixed(1)}%;--y:${rnd(2, 96).toFixed(1)}%;--d:${(-rnd(0, 9)).toFixed(2)}s;--t:${rnd(type === 'lava' ? 3 : 5, type === 'lava' ? 6 : 11).toFixed(2)}s;--s:${type === 'lava' ? rnd(4, 9).toFixed(0) : rnd(9, 20).toFixed(0)}px;--dx:${rnd(-60, 60).toFixed(0)}px;--r:${rnd(-540, 540).toFixed(0)}deg;--c:${colors[i % colors.length]};color:rgba(255,255,255,.75)` }, type === 'prism' || type === 'lava' || type === 'slash' || type === 'overdrive' ? '' : cfg[1][i % cfg[1].length]);
    kids.push(sp);
  }
  if (type === 'stars') for (let i = 0; i < 3; i++) kids.push(h('span', { class: 'shoot', style: `--x:${rnd(5, 60).toFixed(0)}%;--d:${(-rnd(0, 8)).toFixed(1)}s;--t:${rnd(6, 10).toFixed(1)}s` }));
  layer.append(...kids); return layer;
}
async function openProfile(user) {
  user = state.users.find((x) => x.id === user.id) || user;
  const role = roleById(user.roleId), fx = user.fx || {}, isMe = user.id === state.me;
  let info = { acct: 0, joined: user.createdAt, views: 0, messages: 0 };
  const stats = h('div', { class: 'pc-stats' });
  const paintStats = () => stats.replaceChildren(
    h('span', {}, '✦ account #' + (info.acct || '—')), h('span', {}, '🕐 joined ' + new Date(info.joined).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })),
    h('span', {}, '👁 ' + info.views.toLocaleString('en-US') + ' views'), h('span', {}, '💬 ' + info.messages.toLocaleString('en-US') + ' messages'));
  paintStats();
  const staff = ['owner', 'admin'].includes(user.roleId);
  const nameEl = h('span', { class: 'pc-name' + (fx.name ? ' fx-' + fx.name : ''), 'data-text': user.username, style: fx.name ? '' : `color:${role.color}` }, user.username);
  const tag = userTag(user);
  const pills = h('div', { class: 'pc-pills' }, h('span', { class: 'pc-pill', style: `--c:${role.color}` }, h('i', {}), role.name), user.online ? h('span', { class: 'pc-pill', style: '--c:#43b581' }, h('i', {}), 'online') : h('span', { class: 'pc-pill', style: '--c:#8b8f99' }, h('i', {}), 'offline'));
  const av = avatar(user, false); av.classList.add('pc-av');
  const bgType = fx.bg ? fx.bg.replace('bg-', '') : 'default';
  const card = h('div', { class: 'modal profilecard' + (bgType === 'slash' ? ' croma-glow' : '') + (bgType === 'overdrive' || bgType === 'bloodmoon' ? ' ev-' + bgType : ''), style: `--role:${role.color}` },
    h('div', { class: 'pc-banner' + (fx.bg ? ' fx-' + fx.bg : '') }), particleLayer(bgType),
    h('button', { type: 'button', class: 'rw-x', title: 'Close', onclick: closeOverlay }, '✕'),
    av,
    h('div', { class: 'pc-title' }, nameEl, staff ? h('span', { class: 'pc-verified', title: role.name }, '✓') : null, tag,
      user.roleId !== 'member' ? h('span', { class: 'pc-badge', style: `background:${role.color}` }, (ROLE_ICON[user.roleId] || '') + ' ' + role.name.toUpperCase()) : null),
    h('div', { class: 'pc-handle' }, '@' + user.username),
    stats, pills,
    user.status ? h('div', { class: 'pc-status' }, '“' + user.status + '”') : null,
    h('div', { class: 'pc-actions' },
      isMe ? h('button', { type: 'button', class: 'btn primary pc-main', onclick: () => { closeOverlay(); openRewards('tags'); } }, '✨ Change my effects') : friendButtons(user, true)));
  openOverlay(card);
  try { info = await api('/users/' + user.id + '/profile'); paintStats(); } catch (e) { /* stats stay empty */ }
}

/* ------------------------------------------------------------------ v19: quests, sidebar box, poll pop-up, countdown, tour, web games */
async function refreshEco() { try { const d = await api('/bootstrap'); if (d.economy) { takeEco(d.economy); renderCoins(); } } catch (e) { /* later */ } }

/* ---- daily quests ---- */
state.quests = null;
const qLeft = (ms) => { const m = Math.max(1, Math.ceil(ms / 60000)); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; };
async function loadQuests() {
  const q = await api('/quests'); q.at = Date.now(); state.quests = q;
  const pending = q.quests.some((x) => !x.done);
  for (const id of ['railQuestDot', 'headQuestDot']) $(id).classList.toggle('hidden', !pending);
  renderSideBox();
  if (document.getElementById('questList')) drawQuests();
}
function questRow(x) {
  const pct = Math.round((x.progress / x.goal) * 100);
  return h('div', { class: 'quest' + (x.done ? ' done' : '') },
    h('div', { class: 'q-top' }, h('span', { class: 'q-t' }, (x.done ? '✅ ' : '') + x.text), h('span', { class: 'q-r' }, `+${x.reward} 🪙`)),
    h('div', { class: 'q-bar' }, h('i', { style: `width:${pct}%` })),
    h('div', { class: 'q-n' }, `${x.progress} / ${x.goal}`));
}
function drawQuests() {
  const box = document.getElementById('questList'); if (!box || !state.quests) return;
  const q = state.quests, doneN = q.quests.filter((x) => x.done).length;
  box.replaceChildren(
    h('div', { class: 'q-head' }, h('b', {}, `${doneN} / ${q.quests.length} done`), h('span', {}, `New quests in ${qLeft(q.resetsIn - (Date.now() - q.at))}`)),
    ...q.quests.map(questRow),
    h('div', { class: 'quest bonus' + (q.bonus.done ? ' done' : '') }, h('div', { class: 'q-top' }, h('span', { class: 'q-t' }, (q.bonus.done ? '🎉 ' : '🎁 ') + 'Finish all five'), h('span', { class: 'q-r' }, `+${q.bonus.reward} 🪙 bonus`))));
}
function openQuests() {
  const box = h('div', { class: 'modal quests' },
    h('button', { type: 'button', class: 'rw-x', title: 'Close', onclick: closeOverlay }, '✕'),
    h('h2', {}, '📋 Daily quests'),
    h('p', { class: 'rw-sub' }, 'Chat, play and have fun. Coins are paid the moment you finish a quest. New quests every day.'),
    h('div', { id: 'questList', class: 'quest-list' }));
  openOverlay(box); drawQuests(); attempt(loadQuests);
}
$('railQuests').onclick = $('headQuests').onclick = openQuests;

/* ---- the little box in the sidebar: the open poll and your quests ---- */
function renderSideBox() {
  const box = $('sideBox'); if (!box) return;
  const kids = [];
  const p = (state.polls || []).find((x) => x.open);
  if (p) {
    const showRes = !!p.mine;
    kids.push(h('div', { class: 'sb-poll' },
      h('div', { class: 'sb-title' }, '📊 ' + p.question),
      ...p.options.map((o) => {
        const pct = p.total ? Math.round((o.count / p.total) * 100) : 0;
        return h('button', { type: 'button', class: 'sb-opt' + (p.mine === o.id ? ' mine' : ''), onclick: () => attempt(async () => { uiSound('pop'); await api(`/polls/${p.id}/vote`, 'POST', { option: o.id }); await loadPolls(); }) },
          showRes ? h('i', { style: `width:${pct}%` }) : null, h('span', {}, (p.mine === o.id ? '✓ ' : '') + o.text), showRes ? h('small', {}, pct + '%') : null);
      })));
  }
  const q = state.quests;
  if (q) {
    const doneN = q.quests.filter((x) => x.done).length;
    kids.push(h('button', { type: 'button', class: 'sb-quests', onclick: openQuests }, h('span', {}, '📋 Daily quests'), h('b', {}, `${doneN}/${q.quests.length}`), h('i', { class: 'sb-qbar' }, h('u', { style: `width:${(doneN / q.quests.length) * 100}%` }))));
  }
  box.classList.toggle('hidden', !kids.length);
  box.replaceChildren(...kids);
}

/* ---- the poll pop-up: shows for one minute like an announcement, for people who miss the 📊 button ---- */
let pollPopTimer = null;
function pollPopup(id) {
  const old = document.getElementById('pollPop'); if (old) old.remove(); clearInterval(pollPopTimer);
  const p = state.polls.find((x) => x.id === id); if (!p || !p.open || p.mine) return;
  const END = Date.now() + 60000, bar = h('i', { class: 'pp-bar' }), sec = h('span', { class: 'pp-sec' }, '60s');
  const pop = h('div', { id: 'pollPop', class: 'pollpop' }, h('div', { class: 'pp-head' }, h('b', {}, '📊 NEW POLL'), sec, h('button', { type: 'button', class: 'icon-btn', title: 'Dismiss', onclick: () => { clearInterval(pollPopTimer); pop.remove(); } }, '✕')),
    h('div', { class: 'pp-q' }, p.question), h('div', { class: 'pp-opts' }), bar);
  const paint = () => {
    const cur = state.polls.find((x) => x.id === id) || p, voted = !!cur.mine;
    pop.querySelector('.pp-opts').replaceChildren(...cur.options.map((o) => {
      const pct = cur.total ? Math.round((o.count / cur.total) * 100) : 0;
      return h('button', { type: 'button', class: 'sb-opt' + (cur.mine === o.id ? ' mine' : ''), disabled: !cur.open || null, onclick: () => attempt(async () => { uiSound('pop'); await api(`/polls/${id}/vote`, 'POST', { option: o.id }); await loadPolls(); paint(); }) },
        voted ? h('i', { style: `width:${pct}%` }) : null, h('span', {}, (cur.mine === o.id ? '✓ ' : '') + o.text), voted ? h('small', {}, pct + '%') : null);
    }));
  };
  paint(); document.body.append(pop); uiSound('pop');
  pollPopTimer = setInterval(() => { const left = END - Date.now(); if (left <= 0) { clearInterval(pollPopTimer); pop.remove(); return; } sec.textContent = Math.ceil(left / 1000) + 's'; bar.style.width = (left / 600) + '%'; }, 250);
}

/* ---- Owner countdown bar ("Next update in 2d 3h...") ---- */
state.countdown = null; let cdTimer = null;
function setCountdown(c) { state.countdown = c ? { label: c.label, endsAt: c.endsAt, skew: (c.now || Date.now()) - Date.now() } : null; tickCountdown(); clearInterval(cdTimer); if (state.countdown) cdTimer = setInterval(tickCountdown, 1000); }
function tickCountdown() {
  const bar = $('cdBar'), c = state.countdown; if (!bar) return;
  if (!c) { bar.classList.add('hidden'); return; }
  const left = c.endsAt - (Date.now() + c.skew);
  if (left < -10 * 60000) { state.countdown = null; clearInterval(cdTimer); bar.classList.add('hidden'); return; }
  const s = Math.max(0, Math.floor(left / 1000)), d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60, p2 = (n) => String(n).padStart(2, '0');
  const t = left <= 0 ? 'NOW!' : d ? `${d}d ${hh}h ${p2(mm)}m` : hh ? `${hh}h ${p2(mm)}m ${p2(ss)}s` : `${p2(mm)}m ${p2(ss)}s`;
  bar.classList.remove('hidden'); bar.classList.toggle('soon', left < 5 * 60000);
  bar.replaceChildren(h('span', { class: 'cd-l' }, '⏳ ' + c.label), h('b', { class: 'cd-t' }, t));
}
function countdownMaker() {
  const label = h('input', { type: 'text', maxlength: 60, value: 'Next update', placeholder: 'What is coming?' });
  const presets = ['Next update', 'Admin abuse', 'Event', 'Giveaway'].map((t) => h('button', { type: 'button', class: 'btn small chip', onclick: () => { label.value = t; } }, t));
  const when = h('input', { type: 'datetime-local' });
  const setIn = (mins) => { const d = new Date(Date.now() + mins * 60000 - new Date().getTimezoneOffset() * 60000); when.value = d.toISOString().slice(0, 16); };
  const quick = [['30 min', 30], ['1 hour', 60], ['6 hours', 360], ['1 day', 1440], ['3 days', 4320], ['1 week', 10080]].map(([t, m]) => h('button', { type: 'button', class: 'btn small chip', onclick: () => setIn(m) }, t));
  const cur = h('div', { class: 'note' }, state.countdown ? 'Running now: ' + state.countdown.label : 'No countdown is running.');
  return h('section', {}, h('h4', {}, '⏳ Countdown'),
    h('div', { class: 'note' }, 'Shows a countdown bar above the chat for everyone, like "Next update in 2d 3h". It stays for 10 minutes after it hits zero.'),
    h('label', {}, 'What is coming', label), h('div', { class: 'ar-chips' }, presets),
    h('label', {}, 'When', when), h('div', { class: 'ar-chips' }, quick),
    h('div', { style: 'margin:8px 0' },
      h('button', { type: 'button', class: 'btn primary small', onclick: () => attempt(async () => {
        if (!when.value) throw new Error('Pick when it happens (or tap a quick button)');
        const r = await api('/owner/countdown', 'PUT', { label: label.value, endsAt: new Date(when.value).getTime() }); setCountdown(r.countdown); cur.textContent = 'Running now: ' + label.value; toast2('Countdown started');
      }) }, '⏳ Start countdown'),
      h('button', { type: 'button', class: 'btn small', style: 'margin-left:8px', onclick: () => attempt(async () => { await api('/owner/countdown', 'DELETE'); setCountdown(null); cur.textContent = 'No countdown is running.'; toast2('Countdown cleared'); }) }, 'Clear')), cur);
}

/* ---- web games (the Owner adds links; everyone plays them here) ---- */
state.webgames = [];
async function loadWebGames() { state.webgames = (await api('/webgames')).games; if (document.getElementById('wgList')) drawWebGames(); }
function playWebGame(g) {
  const frame = h('iframe', { class: 'wg-frame', src: g.url, allow: 'fullscreen; gamepad; autoplay; clipboard-write', allowfullscreen: '', referrerpolicy: 'no-referrer', sandbox: 'allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-popups' });
  const box = h('div', { class: 'modal wgplay' },
    h('div', { class: 'wg-bar' }, h('b', {}, `${g.icon} ${g.name}`), h('span', { class: 'wg-hint' }, 'Blank or blocked? Some sites do not allow playing inside other pages.'),
      h('a', { class: 'btn small', href: g.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open in new tab'),
      h('button', { type: 'button', class: 'btn small', onclick: () => { try { frame.requestFullscreen(); } catch (e) { /* no */ } } }, '⛶'),
      h('button', { type: 'button', class: 'rw-x', title: 'Close', onclick: () => { frame.src = 'about:blank'; closeOverlay(); } }, '✕')), frame);
  openOverlay(box);
}
function drawWebGames() {
  const box = document.getElementById('wgList'); if (!box) return;
  box.replaceChildren(...(state.webgames.length ? state.webgames.map((g) => h('div', { class: 'wg-card' },
    h('button', { type: 'button', class: 'wg-play', onclick: () => playWebGame(g) }, h('span', { class: 'wg-ic' }, g.icon), h('span', { class: 'wg-n' }, g.name)),
    isOwner() ? h('button', { type: 'button', class: 'icon-btn', title: 'Remove', onclick: () => attempt(async () => { if (!(await confirmBox('Remove ' + g.name + '?', 'It disappears for everyone.', 'Remove'))) return; await api('/owner/webgames/' + g.id, 'DELETE'); await loadWebGames(); }) }, '✕') : null))
    : [h('div', { class: 'note' }, isOwner() ? 'No games yet. Add links in the Owner Panel under Web games.' : 'No web games yet. The Owner can add some!')]));
}
function openWebGames() {
  openOverlay(h('div', { class: 'modal wglib' }, h('button', { type: 'button', class: 'rw-x', title: 'Close', onclick: closeOverlay }, '✕'), h('h2', {}, '🌐 Web games'),
    h('p', { class: 'rw-sub' }, 'Games from around the web that run right here. Tap one to play.'), h('div', { id: 'wgList', class: 'wg-list' })));
  drawWebGames(); attempt(loadWebGames);
}
$('railGames').onclick = $('headGames').onclick = openWebGames;
function webGamesMaker() {
  const name = h('input', { type: 'text', maxlength: 40, placeholder: 'Game name' }), icon = h('input', { type: 'text', maxlength: 2, value: '🎮', style: 'width:60px' }), url = h('input', { type: 'url', placeholder: 'https://… (link to the game)' });
  const list = h('div', {});
  const paint = () => list.replaceChildren(...state.webgames.map((g) => h('div', { class: 'own-row' }, h('span', {}, g.icon), h('span', { class: 'own-name' }, g.name), h('button', { type: 'button', class: 'btn danger small', onclick: () => attempt(async () => { await api('/owner/webgames/' + g.id, 'DELETE'); await loadWebGames(); paint(); }) }, 'Remove'))));
  loadWebGames().then(paint).catch(() => {});
  return h('section', {}, h('h4', {}, '🌐 Web games'),
    h('div', { class: 'note' }, 'Add a link to a game that runs in a web page and everyone can play it from the 🌐 button. Some sites refuse to open inside other pages; those still work with "Open in new tab".'),
    h('label', {}, 'Name', name), h('label', {}, 'Icon (an emoji)', icon), h('label', {}, 'Link', url),
    h('button', { type: 'button', class: 'btn primary small', style: 'margin:8px 0', onclick: () => attempt(async () => { await api('/owner/webgames', 'POST', { name: name.value, icon: icon.value, url: url.value }); name.value = ''; url.value = ''; await loadWebGames(); paint(); toast2('Game added'); }) }, '＋ Add game'), list);
}

/* ---- welcome tour ---- */
const TOUR = [
  ['👋', 'Welcome to Warms World!', 'This is a hangout for friends: chat, games, coins and fun. Here is a quick look at what you can do. It takes 30 seconds.'],
  ['💬', 'Chat and spaces', 'Talk in channels, reply, react with emoji and send pictures. Spaces are the round buttons on the far left bar. Add friends in 💬 Messages to chat privately or call them.'],
  ['🪙', 'Coins and the shop', 'Coins are play money. Spin the wheel once a day, then spend coins in the shop on chat tags, Mystery Machine rolls and seasonal packs. Tap your coin count to open it.'],
  ['🕹️', 'The Arcade', 'Reflex games like Whack-a-Mole earn coins. Coin games like Blackjack, Roulette, Slots and Higher or Lower let you bet them, up to everything you have. Careful, you can lose!'],
  ['📋', 'Daily quests', 'Every day there are five quests, like sending messages or playing games. Finish them for coins, and all five gives a bonus. They are in the 📋 button and the little box in the sidebar.'],
  ['📊', 'Polls, events and more', 'The Owner runs polls (they pop up for a minute), countdowns, minigames and surprise events. Check 📜 Update log for what is new, and 🌐 for web games.'],
  ['🎉', 'You are all set!', 'Be kind, follow the Server rules, and have fun. Enjoy!'],
];
function openTour(first) {
  let i = 0;
  const body = h('div', { class: 'tour-body' }), dots = h('div', { class: 'tour-dots' }), next = h('button', { type: 'button', class: 'btn primary' }, 'Next'), back = h('button', { type: 'button', class: 'btn' }, 'Back'), skip = h('button', { type: 'button', class: 'btn small tour-skip' }, 'Skip');
  const done = () => { closeOverlay(); if (first || state.tour) { state.tour = false; api('/tour-done', 'POST', {}).catch(() => {}); } };
  const paint = () => {
    const [ic, t, tx] = TOUR[i];
    body.replaceChildren(h('div', { class: 'tour-ic' }, ic), h('h2', {}, t), h('p', {}, tx));
    body.classList.remove('flip'); void body.offsetWidth; body.classList.add('flip');
    dots.replaceChildren(...TOUR.map((_, k) => h('i', { class: k === i ? 'on' : '' })));
    next.textContent = i === TOUR.length - 1 ? "Let's go!" : 'Next'; back.style.visibility = i ? 'visible' : 'hidden'; skip.style.visibility = i === TOUR.length - 1 ? 'hidden' : 'visible';
    uiSound('pop');
  };
  next.onclick = () => { if (i >= TOUR.length - 1) { popConfetti(); done(); } else { i++; paint(); } };
  back.onclick = () => { if (i) { i--; paint(); } }; skip.onclick = done;
  openOverlay(h('div', { class: 'modal tour' }, body, dots, h('div', { class: 'tour-nav' }, back, skip, next)));
  paint();
}

/* ------------------------------------------------------------------ Polls */
state.polls = []; state.unvoted = 0;
function renderPollDot() { for (const id of ['railPollDot', 'headPollDot']) $(id).classList.toggle('hidden', !state.unvoted); }
async function loadPolls() {
  const r = await api('/polls');
  state.polls = r.polls; state.unvoted = r.unvoted; renderPollDot(); renderSideBox();
  if (document.getElementById('pollList')) drawPolls();
}
$('railPolls').onclick = $('headPolls').onclick = () => openPolls();
function pollLeft(p) {
  if (!p.open) return 'Closed';
  if (!p.endsAt) return 'Open';
  const m = Math.max(0, Math.ceil((p.endsAt - Date.now()) / 60000));
  return m >= 120 ? `${Math.round(m / 60)}h left` : `${m} min left`;
}
function pollCard(p) {
  const showRes = !p.open || p.mine || isOwner();
  const top = Math.max(1, ...p.options.map((o) => o.count));
  const rows = p.options.map((o) => {
    const pct = p.total ? Math.round((o.count / p.total) * 100) : 0;
    const mine = p.mine === o.id;
    const b = h('button', { type: 'button', class: 'poll-opt' + (mine ? ' mine' : '') + (showRes && o.count === top && p.total ? ' lead' : ''), disabled: !p.open || null,
      onclick: () => attempt(async () => { uiSound('pop'); await api(`/polls/${p.id}/vote`, 'POST', { option: o.id }); toast2('Vote saved'); await loadPolls(); }) },
      showRes ? h('i', { class: 'poll-bar', style: `width:${pct}%` }) : null,
      h('span', { class: 'poll-t' }, (mine ? '✓ ' : '') + o.text),
      showRes ? h('span', { class: 'poll-n' }, `${o.count} · ${pct}%`) : null);
    const voters = isOwner() && o.voters && o.voters.length ? h('div', { class: 'poll-voters' }, o.voters.join(', ')) : null;
    return h('div', {}, b, voters);
  });
  const ownerBtns = isOwner() ? h('div', { class: 'poll-actions' },
    p.open ? h('button', { type: 'button', class: 'btn small', onclick: () => attempt(async () => { await api(`/owner/polls/${p.id}/close`, 'POST'); await loadPolls(); }) }, 'Close poll') : null,
    h('button', { type: 'button', class: 'btn danger small', onclick: () => attempt(async () => { if (!(await confirmBox('Delete this poll?', 'Its votes are lost.'))) return; await api(`/owner/polls/${p.id}`, 'DELETE'); await loadPolls(); }) }, 'Delete')) : null;
  return h('article', { class: 'poll' + (p.open ? '' : ' closed') },
    h('div', { class: 'poll-q' }, p.question),
    h('div', { class: 'poll-meta' }, `${pollLeft(p)} · ${p.total} vote${p.total === 1 ? '' : 's'} · by ${p.by}${p.open && !p.mine ? ' · tap to vote' : p.open ? ' · tap another to change' : ''}`),
    h('div', { class: 'poll-opts' }, rows), ownerBtns);
}
function drawPolls() {
  const list = document.getElementById('pollList'); if (!list) return;
  list.replaceChildren(...(state.polls.length ? state.polls.map(pollCard) : [h('div', { class: 'note' }, isOwner() ? 'No polls yet. Make one in the Owner Panel.' : 'No polls yet.')]));
}
function openPolls() {
  const box = h('div', { class: 'modal polls' },
    h('button', { type: 'button', class: 'rw-x', title: 'Close', onclick: closeOverlay }, '✕'),
    h('h2', {}, '📊 Polls'),
    h('p', { class: 'rw-sub' }, 'Vote on what the Owner asks. You can change your vote while a poll is open.'),
    isOwner() ? h('button', { type: 'button', class: 'btn primary small', style: 'margin-bottom:10px', onclick: () => { closeOverlay(); openOwnerPanel(); } }, '＋ New poll in Owner Panel') : null,
    h('div', { id: 'pollList', class: 'poll-list' }));
  openOverlay(box); drawPolls(); attempt(loadPolls);
}
function pollMaker() {
  const q = h('input', { type: 'text', maxlength: 150, placeholder: 'Ask a question' });
  const opts = h('textarea', { rows: 4, placeholder: 'One choice per line (2 to 8)' });
  const mins = h('select', {}, ...[[0, 'No time limit'], [60, '1 hour'], [1440, '1 day'], [4320, '3 days'], [10080, '1 week']].map(([v, t]) => h('option', { value: v }, t)));
  const box = h('section', {}, h('h4', {}, '📊 Polls'),
    h('div', { class: 'note' }, 'Everyone gets a 📊 button and a dot until they vote. You see who voted for what.'),
    h('label', {}, 'Question', q), h('label', {}, 'Choices', opts), h('label', {}, 'Closes after', mins),
    h('button', { type: 'button', class: 'btn primary small', style: 'margin:8px 0', onclick: () => attempt(async () => {
      await api('/owner/polls', 'POST', { question: q.value, options: opts.value.split('\n'), minutes: Number(mins.value) });
      q.value = ''; opts.value = ''; toast2('Poll started. Everyone was told'); await loadPolls(); closeOverlay(); openPolls();
    }) }, '📊 Start poll'),
    h('button', { type: 'button', class: 'btn small', style: 'margin-left:8px', onclick: () => { closeOverlay(); openPolls(); } }, 'See results'));
  return box;
}

/* ------------------------------------------------------------------ Arcade */
$('railArcade').onclick = $('headArcade').onclick = () => openArcade();
function openArcade() {
  const box = h('div', { class: 'modal arcade' });
  let stopFn = null;
  const stop = () => { if (stopFn) { try { stopFn(); } catch (e) { /* done */ } stopFn = null; } };
  const close = () => { stop(); closeOverlay(); };
  const bal = () => '🪙 ' + (state.eco ? state.eco.coins : 0);
  const back = h('button', { type: 'button', class: 'btn ghost small ar-back', onclick: () => home() }, '← Arcade');
  const shell = (title, ...kids) => box.replaceChildren(h('div', { class: 'ar-top' }, back, h('b', { class: 'ar-bal', id: 'arBal' }, bal()), h('button', { class: 'close', title: 'Close', onclick: close }, '✕')), h('h2', {}, title), ...kids);
  const setBal = () => { const e = document.getElementById('arBal'); if (e) { e.textContent = bal(); if (!calmMotion()) { e.classList.remove('bump'); void e.offsetWidth; e.classList.add('bump'); } } };
  const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function home() {
    stop();
    let st = null; try { st = await api('/arcade'); takeEco(st); renderCoins(); } catch (e) { /* offline */ }
    const card = (ic, name, desc, fn, cls) => h('button', { type: 'button', class: 'ar-card ' + (cls || ''), onclick: fn }, h('span', { class: 'ar-ic' }, ic), h('b', {}, name), h('small', {}, desc));
    box.replaceChildren(
      h('div', { class: 'ar-top' }, h('span', {}), h('b', { class: 'ar-bal', id: 'arBal' }, bal()), h('button', { class: 'close', title: 'Close', onclick: close }, '✕')),
      h('h2', {}, '🕹️ Arcade'),
      h('h4', {}, 'Reflex games · earn coins'),
      h('div', { class: 'ar-grid' }, card('🐹', 'Whack-a-Mole', '25 seconds. Hit them all!', whack), card('🧠', 'Memory Match', 'Find all 8 pairs', memory), card('⚡', 'Reaction Test', 'Tap the moment it turns green', reaction)),
      st ? h('div', { class: 'note' }, `You can earn up to ${st.cap} coins a day from reflex games. ${st.left} left today.`) : null,
      h('h4', {}, 'Coin games · bet your coins'),
      h('div', { class: 'ar-grid' }, card('🃏', 'Blackjack', 'Beat the dealer to 21. Pays 3 to 2', blackjack, 'gold'), card('🎡', 'Roulette', 'Red, black or a number: up to 36x', roulette, 'gold'), card('🔼', 'Higher or Lower', 'Chain guesses, cash out any time', hilo, 'gold'), card('🪙', 'Coin Flip', 'Heads or tails: win 1.9x', coinflip, 'gold'), card('🎲', 'Lucky Dice', 'Pick a number: win 5.5x', dice, 'gold'), card('🎰', 'Slots', 'Match three to win big', slots, 'gold')),
      h('div', { class: 'note' }, 'Play money only. Coins cannot be bought or cashed out. Bet as much as you like, up to the coins you have.'));
  }

  async function finish(game, run, score, extra, title, detail) {
    let r; try { r = await api('/arcade/finish', 'POST', { game, id: run.id, score, extra }); } catch (e) { toast(e.message); return home(); }
    takeEco(r); renderCoins();
    const win = r.earned > 0;
    if (win) { uiSound('win'); if (r.earned >= 25) popConfetti(); }
    shell(title, h('div', { class: 'ar-result' }, h('div', { class: 'ar-big' }, win ? '+' + r.earned + ' 🪙' : '0 🪙'), h('div', {}, detail), r.note ? h('div', { class: 'note' }, r.note) : null, r.capped ? h('div', { class: 'note' }, 'You hit today’s reflex-game coin limit. Come back tomorrow!') : null),
      h('div', { class: 'actions' }, h('button', { class: 'btn ghost small', onclick: home }, 'Menu'), h('button', { class: 'btn primary small', onclick: () => ({ whack, memory, reaction })[game]() }, 'Play again')));
    setBal();
  }

  async function whack() {
    stop(); let run; try { run = await api('/arcade/start', 'POST', { game: 'whack' }); } catch (e) { return toast(e.message); }
    let score = 0, left = 25, active = -1, golden = false, over = false;
    const holes = Array.from({ length: 9 }, (_, i) => h('button', { type: 'button', class: 'ar-hole', 'aria-label': 'hole ' + (i + 1), onclick: () => hit(i) }, h('span', { class: 'ar-mole' })));
    const scoreEl = h('b', {}, '0'), timeEl = h('b', {}, '25');
    shell('🐹 Whack-a-Mole', h('div', { class: 'ar-stats' }, h('span', {}, 'Score ', scoreEl), h('span', {}, 'Time ', timeEl)), h('div', { class: 'ar-holes' }, holes), h('div', { class: 'note' }, 'Moles are quick. 🌟 gold moles count 3!'));
    let popT = 0, hideT = 0;
    const hide = () => { if (active >= 0) { holes[active].classList.remove('up', 'gold'); holes[active].firstChild.textContent = ''; } active = -1; };
    const pop = () => {
      if (over) return; hide();
      let i; do { i = rand(0, 8); } while (i === active);
      active = i; golden = Math.random() < 0.12; holes[i].classList.add('up'); if (golden) holes[i].classList.add('gold'); holes[i].firstChild.textContent = golden ? '🌟' : '🐹';
      const stay = Math.max(450, 900 - score * 12);
      hideT = setTimeout(() => { hide(); popT = setTimeout(pop, rand(120, 380)); }, stay);
    };
    function hit(i) {
      if (over || i !== active) return;
      score += golden ? 3 : 1; scoreEl.textContent = score; uiSound('whack'); burstAt(holes[i], golden ? '⭐' : '💥', 6);
      clearTimeout(hideT); hide(); popT = setTimeout(pop, rand(100, 300));
    }
    const tick = setInterval(() => { left--; timeEl.textContent = left; timeEl.classList.toggle('late', left <= 5); if (left <= 0) { over = true; clearInterval(tick); clearTimeout(popT); clearTimeout(hideT); stopFn = null; finish('whack', run, score, 0, '🐹 Whack-a-Mole', `You whacked ${score} point${score === 1 ? '' : 's'}!`); } }, 1000);
    stopFn = () => { over = true; clearInterval(tick); clearTimeout(popT); clearTimeout(hideT); };
    popT = setTimeout(pop, 600);
  }

  async function memory() {
    stop(); let run; try { run = await api('/arcade/start', 'POST', { game: 'memory' }); } catch (e) { return toast(e.message); }
    const faces = ['🍎', '🚀', '🐙', '🎸', '🌈', '🍩', '👾', '🦄'], deck = [...faces, ...faces].sort(() => Math.random() - 0.5);
    let first = null, lock = false, moves = 0, found = 0; const movesEl = h('b', {}, '0');
    const cards = deck.map((f, i) => h('button', { type: 'button', class: 'ar-mem', 'aria-label': 'card ' + (i + 1), onclick: () => flip(i) }, h('span', { class: 'mem-in' }, h('i', { class: 'mem-back' }, '?'), h('i', { class: 'mem-front' }, f))));
    shell('🧠 Memory Match', h('div', { class: 'ar-stats' }, h('span', {}, 'Moves ', movesEl), h('span', {}, 'Pairs ', h('b', { id: 'memPairs' }, '0 / 8'))), h('div', { class: 'ar-memgrid' }, cards), h('div', { class: 'note' }, 'Fewer moves means more coins.'));
    async function flip(i) {
      const c = cards[i]; if (lock || c.classList.contains('open') || c.classList.contains('done')) return;
      c.classList.add('open'); uiSound('flip');
      if (first === null) { first = i; return; }
      moves++; movesEl.textContent = moves; const a = first; first = null;
      if (deck[a] === deck[i]) {
        cards[a].classList.add('done'); c.classList.add('done'); found++; document.getElementById('memPairs').textContent = found + ' / 8'; uiSound('pop'); burstAt(c, '✨', 6);
        if (found === 8) { await sleep(500); finish('memory', run, 0, moves, '🧠 Memory Match', `All pairs in ${moves} moves!`); }
      } else { lock = true; await sleep(750); cards[a].classList.remove('open'); c.classList.remove('open'); lock = false; }
    }
  }

  async function reaction() {
    stop(); let run; try { run = await api('/arcade/start', 'POST', { game: 'reaction' }); } catch (e) { return toast(e.message); }
    const times = []; let phase = 'idle', t0 = 0, timer = 0, dead = false;
    const pad = h('button', { type: 'button', class: 'ar-react wait', onclick: press }, 'Tap to begin');
    const roundEl = h('b', {}, '0 / 5');
    shell('⚡ Reaction Test', h('div', { class: 'ar-stats' }, h('span', {}, 'Round ', roundEl), h('span', {}, 'Best ', h('b', { id: 'rxBest' }, '-'))), pad, h('div', { class: 'note' }, 'Wait for green, then tap as fast as you can. Tapping early restarts the round.'));
    stopFn = () => { dead = true; clearTimeout(timer); };
    function arm() { phase = 'wait'; pad.className = 'ar-react wait'; pad.textContent = 'Wait for green…'; timer = setTimeout(() => { if (dead) return; phase = 'go'; t0 = performance.now(); pad.className = 'ar-react go'; pad.textContent = 'TAP!'; }, rand(1300, 3400)); }
    async function press() {
      if (dead) return;
      if (phase === 'idle') return arm();
      if (phase === 'wait') { clearTimeout(timer); pad.className = 'ar-react early'; pad.textContent = 'Too soon! Tap to try again'; phase = 'idle'; uiSound('lose'); return; }
      if (phase === 'go') {
        const ms = Math.round(performance.now() - t0); times.push(ms); roundEl.textContent = times.length + ' / 5'; document.getElementById('rxBest').textContent = Math.min(...times) + ' ms'; uiSound('pop');
        if (times.length >= 5) { phase = 'done'; dead = true; const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length); return finish('reaction', run, 0, avg, '⚡ Reaction Test', `Your average was ${avg} ms (${times.join(', ')}).`); }
        phase = 'idle'; pad.className = 'ar-react wait'; pad.textContent = ms + ' ms. Tap for the next round';
      }
    }
  }

  // ---- coin games: the server decides every result ----
  function betControls() {
    const have = () => (state.eco ? state.eco.coins : 0);
    const input = h('input', { type: 'number', min: 1, step: 1, value: Math.min(10, Math.max(1, have())), inputmode: 'numeric', 'aria-label': 'Bet' });
    const set = (n) => { input.value = Math.max(1, Math.min(Math.max(1, have()), Math.floor(n))); };
    const chips = [10, 100, 1000].map((n) => h('button', { type: 'button', class: 'btn small chip', onclick: () => set(n) }, n.toLocaleString('en-US')));
    chips.push(h('button', { type: 'button', class: 'btn small chip', onclick: () => set(have() / 2) }, 'Half'), h('button', { type: 'button', class: 'btn small chip', onclick: () => set(have()) }, 'All in'));
    return { el: h('div', { class: 'ar-bet' }, h('label', {}, 'Bet 🪙 (as much as you like, up to what you have)'), input, h('div', { class: 'ar-chips' }, chips)), get: () => Math.trunc(Number(input.value)) };
  }
  const settle = (r, msgEl, winText) => {
    takeEco(r); renderCoins(); setBal();
    msgEl.className = 'ar-msg ' + (r.won ? 'win' : 'lose');
    msgEl.textContent = r.won ? winText + ` +${r.net} 🪙` : `No luck. -${r.bet} 🪙`;
    uiSound(r.won ? 'win' : 'lose'); if (r.won && r.net >= r.bet * 4) popConfetti(); else if (r.won) burstAt(msgEl, '🪙', 8);
  };


  // ---- Blackjack ----
  const pcard = (c, i) => { const hid = c === '??'; return h('div', { class: 'pcard' + (hid ? ' back' : '') + (/[♥♦]/.test(c) ? ' red' : ''), style: `--i:${i}` }, hid ? '' : [h('b', {}, c.slice(0, -1)), h('i', {}, c.slice(-1))]); };
  async function blackjack() {
    stop(); let busy = false, cur = null;
    const dealerEl = h('div', { class: 'bj-hand' }), playerEl = h('div', { class: 'bj-hand' }), dT = h('b', {}, ''), pT = h('b', {}, '');
    const msg = h('div', { class: 'ar-msg' }, 'Place your bet and deal!'), bet = betControls();
    const dealBox = h('div', {}, bet.el), playBox = h('div', { class: 'ar-sides hidden' });
    const dealBtn = h('button', { type: 'button', class: 'btn primary', onclick: () => act('deal', { bet: bet.get() }) }, 'Deal');
    dealBox.append(dealBtn);
    const hitB = h('button', { type: 'button', class: 'btn', onclick: () => act('hit') }, '➕ Hit'), standB = h('button', { type: 'button', class: 'btn', onclick: () => act('stand') }, '✋ Stand'), dblB = h('button', { type: 'button', class: 'btn', onclick: () => act('double') }, '✖2 Double');
    playBox.append(hitB, standB, dblB);
    const draw = (v) => { dealerEl.replaceChildren(...v.dealer.map(pcard)); playerEl.replaceChildren(...v.player.map(pcard)); dT.textContent = v.state === 'done' ? v.dealerTotal : '?'; pT.textContent = v.playerTotal; };
    const mode = (playing) => { dealBox.classList.toggle('hidden', playing); playBox.classList.toggle('hidden', !playing); if (playing) dblB.classList.toggle('hidden', !cur.canDouble); };
    async function act(what, body) {
      if (busy) return; busy = true;
      let v; try { v = await api('/arcade/blackjack/' + what, 'POST', body || {}); } catch (e) { toast(e.message); busy = false; if (what === 'deal') { try { const r = await api('/arcade/blackjack'); if (r.active) { cur = r; draw(r); mode(true); } } catch (x) { /* none */ } } return; }
      cur = v; draw(v); uiSound(what === 'deal' ? 'flip' : 'pop'); if (v.coins != null) { takeEco(v); renderCoins(); setBal(); }
      if (v.state === 'done') {
        mode(false); const bust = v.result === 'lose' && v.playerTotal > 21;
        const text = { blackjack: `Blackjack! +${v.net.toLocaleString('en-US')} 🪙`, win: `You win! +${v.net.toLocaleString('en-US')} 🪙`, push: 'Push. Your bet comes back.', lose: bust ? `Bust! -${v.bet.toLocaleString('en-US')} 🪙` : `Dealer wins. -${v.bet.toLocaleString('en-US')} 🪙` }[v.result];
        msg.className = 'ar-msg ' + (v.won ? 'win' : v.result === 'push' ? '' : 'lose'); msg.textContent = text;
        uiSound(v.won ? 'win' : v.result === 'push' ? 'pop' : 'lose'); if (v.result === 'blackjack') popConfetti(); else if (v.won) burstAt(msg, '🪙', 8);
      } else { mode(true); msg.className = 'ar-msg'; msg.textContent = `Bet ${v.bet.toLocaleString('en-US')} 🪙. Hit, stand or double?`; }
      busy = false;
    }
    shell('🃏 Blackjack', h('div', { class: 'bj-table' }, h('div', { class: 'bj-row' }, h('span', {}, 'Dealer ', dT), dealerEl), h('div', { class: 'bj-row' }, h('span', {}, 'You ', pT), playerEl)), msg, dealBox, playBox, h('div', { class: 'note' }, 'Dealer stands on 17. Blackjack pays 3 to 2. You can double on your first two cards.'));
    try { const r = await api('/arcade/blackjack'); if (r.active) { cur = r; draw(r); mode(true); msg.textContent = `You have a hand open (bet ${r.bet.toLocaleString('en-US')} 🪙). Hit, stand or double?`; } } catch (e) { /* none */ }
  }

  // ---- Roulette ----
  const RL_RED = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];
  const rlColor = (n) => (n === 0 ? 'green' : RL_RED.includes(n) ? 'red' : 'black');
  function roulette() {
    stop(); let pick = 'red', busy = false;
    const ball = h('div', { class: 'rl-ball green' }, '🎡');
    const msg = h('div', { class: 'ar-msg' }, 'Pick a bet, place your coins, spin!'), bet = betControls();
    const bets = [['red', '🔴 Red', 'x2'], ['black', '⚫ Black', 'x2'], ['even', 'Even', 'x2'], ['odd', 'Odd', 'x2'], ['low', '1 to 18', 'x2'], ['high', '19 to 36', 'x2'], ['d1', '1st 12', 'x3'], ['d2', '2nd 12', 'x3'], ['d3', '3rd 12', 'x3']];
    const btns = bets.map(([id, label, pay]) => h('button', { type: 'button', class: 'btn side' + (id === pick ? ' on' : ''), onclick: (e) => choose(id, e.currentTarget) }, label, h('small', {}, ' ' + pay)));
    const num = h('input', { type: 'number', min: 0, max: 36, value: 17, 'aria-label': 'Number' });
    const numBtn = h('button', { type: 'button', class: 'btn side', onclick: (e) => choose('n' + Math.max(0, Math.min(36, Math.floor(Number(num.value) || 0))), e.currentTarget) }, 'Number', h('small', {}, ' x36'));
    function choose(id, el) { pick = id; btns.concat(numBtn).forEach((b) => b.classList.remove('on')); el.classList.add('on'); }
    const go = h('button', { type: 'button', class: 'btn primary', onclick: async () => {
      if (busy) return; busy = true; go.disabled = true; msg.className = 'ar-msg'; msg.textContent = 'No more bets…';
      let r; try { r = await api('/arcade/roulette', 'POST', { bet: bet.get(), pick }); } catch (e) { toast(e.message); busy = false; go.disabled = false; msg.textContent = ''; return; }
      ball.classList.add('spinning'); const t = setInterval(() => { const n = rand(0, 36); ball.textContent = n; ball.className = 'rl-ball spinning ' + rlColor(n); uiSound('spin'); }, 90);
      await sleep(calmMotion() ? 100 : 1700); clearInterval(t); ball.className = 'rl-ball ' + r.color; ball.textContent = r.result; uiSound('pop');
      settle(r, msg, `${r.result} ${r.color}! x${r.mult}`); busy = false; go.disabled = false;
    } }, 'Spin!');
    shell('🎡 Roulette', ball, h('div', { class: 'ar-sides' }, btns, h('span', { class: 'rl-num' }, num, numBtn)), bet.el, go, msg, h('div', { class: 'note' }, 'One zero. Even-money bets pay 2x your bet back, dozens 3x and a single number 36x. Zero beats every bet except a number.'));
  }

  // ---- Higher or Lower ----
  async function hilo() {
    stop(); let busy = false, cur = null;
    const cardEl = h('div', { class: 'pcard big' }), info = h('div', { class: 'hl-info' }), msg = h('div', { class: 'ar-msg' }, 'Place a bet to draw the first card.'), bet = betControls();
    const dealBox = h('div', {}, bet.el), playBox = h('div', { class: 'hidden' });
    const dealBtn = h('button', { type: 'button', class: 'btn primary', onclick: () => act('deal', { bet: bet.get() }) }, 'Draw a card'); dealBox.append(dealBtn);
    const hiB = h('button', { type: 'button', class: 'btn', onclick: () => act('guess', { dir: 'higher' }) }, '🔼 Higher'), loB = h('button', { type: 'button', class: 'btn', onclick: () => act('guess', { dir: 'lower' }) }, '🔽 Lower'), outB = h('button', { type: 'button', class: 'btn primary small', onclick: () => act('cashout') }, 'Cash out');
    playBox.append(h('div', { class: 'ar-sides' }, hiB, loB), outB);
    const show = (label) => { cardEl.replaceChildren(h('b', {}, label.slice(0, -1)), h('i', {}, label.slice(-1))); cardEl.classList.toggle('red', /[♥♦]/.test(label)); cardEl.classList.remove('flipin'); void cardEl.offsetWidth; cardEl.classList.add('flipin'); };
    const mode = (playing) => { dealBox.classList.toggle('hidden', playing); playBox.classList.toggle('hidden', !playing); };
    const paint = (v) => { show(v.card); hiB.disabled = !v.options.higher; loB.disabled = !v.options.lower; hiB.textContent = '🔼 Higher' + (v.options.higher ? ` x${v.options.higher}` : ''); loB.textContent = '🔽 Lower' + (v.options.lower ? ` x${v.options.lower}` : ''); outB.disabled = v.streak < 1; outB.textContent = `Cash out ${v.payout.toLocaleString('en-US')} 🪙`; info.textContent = `Bet ${v.bet.toLocaleString('en-US')} 🪙 · streak ${v.streak} · now x${v.mult}`; };
    async function act(what, body) {
      if (busy) return; busy = true;
      let v; try { v = await api('/arcade/hilo/' + what, 'POST', body || {}); } catch (e) { toast(e.message); busy = false; return; }
      if (v.coins != null) { takeEco(v); renderCoins(); setBal(); }
      if (v.active) { cur = v; paint(v); mode(true); uiSound(what === 'deal' ? 'flip' : 'win'); msg.className = 'ar-msg' + (v.correct ? ' win' : ''); msg.textContent = v.correct ? `Right! It was ${v.prev}. Keep going or cash out.` : 'Higher or lower?'; }
      else {
        mode(false); info.textContent = ''; if (v.card) show(v.card);
        if (v.lost) { msg.className = 'ar-msg lose'; msg.textContent = `Wrong, it was ${v.card}. -${v.bet.toLocaleString('en-US')} 🪙`; uiSound('lose'); }
        else { msg.className = 'ar-msg win'; msg.textContent = `Cashed out +${v.net.toLocaleString('en-US')} 🪙`; uiSound('win'); if (v.net >= v.bet * 3) popConfetti(); else burstAt(msg, '🪙', 8); }
      }
      busy = false;
    }
    shell('🔼 Higher or Lower', cardEl, info, msg, dealBox, playBox, h('div', { class: 'note' }, 'Guess if the next card is higher or lower (a tie loses). Each right guess multiplies your payout. Aces are low, kings are high.'));
    try { const r = await api('/arcade/hilo'); if (r.active) { cur = r; paint(r); mode(true); msg.textContent = 'You have a round open. Higher or lower?'; } } catch (e) { /* none */ }
  }

  function coinflip() {
    stop(); let pick = 'heads', busy = false;
    const coin = h('div', { class: 'ar-coin' }, h('div', { class: 'ar-coin-in' }, h('i', { class: 'cf-h' }, '👑'), h('i', { class: 'cf-t' }, '🦅')));
    const msg = h('div', { class: 'ar-msg' }, 'Pick a side, place your bet, flip!'), bet = betControls();
    const sides = ['heads', 'tails'].map((sd) => h('button', { type: 'button', class: 'btn small side' + (sd === pick ? ' on' : ''), onclick: (e) => { pick = sd; sides.forEach((b) => b.classList.remove('on')); e.currentTarget.classList.add('on'); } }, sd === 'heads' ? '👑 Heads' : '🦅 Tails'));
    const go = h('button', { type: 'button', class: 'btn primary', onclick: async () => {
      if (busy) return; busy = true; go.disabled = true; msg.className = 'ar-msg'; msg.textContent = 'Flipping…';
      let r; try { r = await api('/arcade/coinflip', 'POST', { bet: bet.get(), pick }); } catch (e) { toast(e.message); busy = false; go.disabled = false; msg.textContent = ''; return; }
      uiSound('flip'); coin.firstChild.style.setProperty('--end', r.result === 'heads' ? '1800deg' : '1980deg'); coin.classList.remove('spin'); void coin.offsetWidth; coin.classList.add('spin');
      await sleep(calmMotion() ? 100 : 1250); settle(r, msg, `It's ${r.result}!`); busy = false; go.disabled = false;
    } }, 'Flip!');
    shell('🪙 Coin Flip', coin, h('div', { class: 'ar-sides' }, sides), bet.el, go, msg, h('div', { class: 'note' }, 'Win and you get 1.9 times your bet.'));
  }

  function dice() {
    stop(); let pick = 3, busy = false;
    const die = h('div', { class: 'ar-die' }, '🎲'), faces = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
    const msg = h('div', { class: 'ar-msg' }, 'Pick your lucky number and roll!'), bet = betControls();
    const nums = [1, 2, 3, 4, 5, 6].map((n) => h('button', { type: 'button', class: 'btn side' + (n === pick ? ' on' : ''), onclick: (e) => { pick = n; nums.forEach((b) => b.classList.remove('on')); e.currentTarget.classList.add('on'); } }, faces[n - 1]));
    const go = h('button', { type: 'button', class: 'btn primary', onclick: async () => {
      if (busy) return; busy = true; go.disabled = true; msg.className = 'ar-msg'; msg.textContent = 'Rolling…';
      let r; try { r = await api('/arcade/dice', 'POST', { bet: bet.get(), pick }); } catch (e) { toast(e.message); busy = false; go.disabled = false; msg.textContent = ''; return; }
      die.classList.add('rolling'); const spin = setInterval(() => { die.textContent = faces[rand(0, 5)]; uiSound('spin'); }, 90);
      await sleep(calmMotion() ? 100 : 1000); clearInterval(spin); die.classList.remove('rolling'); die.textContent = faces[r.result - 1];
      settle(r, msg, `It's a ${r.result}!`); busy = false; go.disabled = false;
    } }, 'Roll!');
    shell('🎲 Lucky Dice', die, h('div', { class: 'ar-sides' }, nums), bet.el, go, msg, h('div', { class: 'note' }, 'Guess the number and you get 5.5 times your bet.'));
  }

  function slots() {
    stop(); let busy = false; const syms = ['🍒', '🍋', '🔔', '⭐', '💎'];
    const reels = [0, 1, 2].map(() => h('div', { class: 'ar-reel' }, '🎰'));
    const msg = h('div', { class: 'ar-msg' }, 'Spin to win!'), bet = betControls();
    const go = h('button', { type: 'button', class: 'btn primary', onclick: async () => {
      if (busy) return; busy = true; go.disabled = true; msg.className = 'ar-msg'; msg.textContent = 'Spinning…';
      let r; try { r = await api('/arcade/slots', 'POST', { bet: bet.get() }); } catch (e) { toast(e.message); busy = false; go.disabled = false; msg.textContent = ''; return; }
      reels.forEach((el) => el.classList.add('spinning'));
      const spin = setInterval(() => { reels.forEach((el) => { if (el.classList.contains('spinning')) el.textContent = syms[rand(0, 4)]; }); uiSound('spin'); }, 80);
      for (let i = 0; i < 3; i++) { await sleep(calmMotion() ? 60 : 550 + i * 450); reels[i].classList.remove('spinning'); reels[i].textContent = r.reels[i]; uiSound('pop'); }
      clearInterval(spin);
      settle(r, msg, r.mult >= 5 ? `JACKPOT! x${r.mult}` : `Two cherries! x${r.mult}`); busy = false; go.disabled = false;
    } }, 'Spin!');
    shell('🎰 Slots', h('div', { class: 'ar-reels' }, reels), bet.el, go, msg,
      h('div', { class: 'note' }, 'Three in a row pays: 🍒 5x · 🍋 7x · 🔔 14x · ⭐ 35x · 💎 120x. Any two 🍒 pays 1.5x.'));
  }

  home();
  openOverlay(box);
}

/* ------------------------------------------------------------------ v22: live show */
const SHOW_DEMO = {}; // reserved
let showData = null, showOffset = 0, stageEl = null, stageTimer = null, stagePoll = null, stageLastIdx = -2, stageLastRef = 0;
const showNow = () => Date.now() + showOffset;
const fmtClock = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/* ---- music and sound effects (all made in the browser, nothing to download) ---- */
const SM = { timer: null, track: null, step: 0, next: 0, master: null, el: null, awardSfx: null };
const showMuted = () => pref('showmute') === '1';
function smCtx() {
  const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null;
  audioCtx = audioCtx || new AC();
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx.state === 'suspended' ? null : audioCtx;
}
const mfreq = (m) => 440 * Math.pow(2, (m - 69) / 12);
function smTone(c, dest, f, t, dur, type, vol, glide) {
  const o = c.createOscillator(), g = c.createGain();
  o.type = type; o.frequency.setValueAtTime(f, t); if (glide) o.frequency.exponentialRampToValueAtTime(glide, t + dur);
  g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(vol, t + Math.min(0.02, dur / 3)); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(dest); o.start(t); o.stop(t + dur + 0.05);
}
function smNoise(c, dest, t, dur, vol, hp) {
  const n = Math.max(1, Math.floor(c.sampleRate * dur)), buf = c.createBuffer(1, n, c.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  const s = c.createBufferSource(), g = c.createGain(), f = c.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hp || 4000;
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.buffer = buf; s.connect(f); f.connect(g); g.connect(dest); s.start(t);
}
function smKick(c, dest, t, vol) { smTone(c, dest, 150, t, 0.22, 'sine', vol, 40); smTone(c, dest, 55, t, 0.38, 'sine', vol * 0.7, 38); }
function smSnare(c, dest, t, vol) { smNoise(c, dest, t, 0.16, vol, 1800); smTone(c, dest, 220, t, 0.1, 'triangle', vol * 0.5, 120); }

// Songs: chords are root note + intervals, one chord per bar of 16 steps.
const TRACKS = {
  lobby: { bpm: 96, chords: [[48, 0, 4, 7], [45, 0, 3, 7], [41, 0, 4, 7], [43, 0, 4, 7]], lead: [0, null, 1, null, 2, null, 1, null, 3, null, 2, null, 1, null, 2, null], kick: 'x.......x.......', snare: '', hat: 'x.x.x.x.x.x.x.x.', bass: 'x.......x.......', pad: true, leadWave: 'triangle' },
  trivia: { gritty: true, bpm: 104, chords: [[50, 0, 4, 7], [55, 0, 4, 7], [47, 0, 3, 7], [52, 0, 3, 7]], lead: [2, null, 1, 2, null, 3, null, 2, 1, null, 2, null, 3, 2, null, 1], kick: 'x.....x...x.....', snare: '........x.......', hat: 'x.x.x.x.x.x.x.xx', bass: 'x..x..x.x..x..x.', pad: false, leadWave: 'square' },
  tense: { gritty: true, bpm: 142, chords: [[45, 0, 3, 7], [45, 0, 3, 7], [41, 0, 4, 7], [40, 0, 4, 7]], lead: [0, null, 2, null, 0, null, 3, 2, 0, null, 2, null, 1, 2, 3, null], kick: 'x..xx..xx..xx..x', snare: '....x.......x...', hat: 'xxxxxxxxxxxxxxxx', bass: 'xxxxxxxxxxxxxxxx', pad: false, leadWave: 'sawtooth' },
  party: { gritty: true, bpm: 128, chords: [[45, 0, 3, 7], [41, 0, 4, 7], [48, 0, 4, 7], [43, 0, 4, 7]], lead: [3, null, 2, 3, null, 2, 1, null, 3, null, 2, 3, null, 1, 2, null], kick: 'x...x...x...x...', snare: '....x.......x...', hat: '..x...x...x...x.', bass: '.x.x.x.x.x.x.x.x', pad: true, leadWave: 'sawtooth' },
  'h-lobby': { bpm: 84, chords: [[45, 0, 3, 7], [41, 0, 4, 7], [38, 0, 3, 7], [40, 0, 4, 7]], lead: [0, null, null, 2, null, null, 1, null, 3, null, null, 2, null, 1, null, null], kick: 'x.......x.......', snare: '', hat: '..x...x...x...x.', bass: 'x.......x.......', pad: true, leadWave: 'sine' },
  'h-trivia': { gritty: true, bpm: 108, chords: [[45, 0, 3, 7], [43, 0, 4, 7], [41, 0, 4, 7], [40, 0, 4, 7]], lead: [0, null, 2, null, 1, 2, null, 3, 2, null, 1, null, 0, 1, null, null], kick: 'x...x...x...x...', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.', bass: 'x..x..x.x..x..x.', pad: true, leadWave: 'triangle' },
  'h-tense': { gritty: true, bpm: 138, chords: [[45, 0, 3, 6], [45, 0, 3, 6], [41, 0, 3, 6], [40, 0, 4, 7]], lead: [0, 0, null, 2, 0, null, 3, null, 0, 0, null, 2, 1, null, 3, 2], kick: 'x..xx..xx..xx.xx', snare: '....x.......x...', hat: 'xxxxxxxxxxxxxxxx', bass: 'xxxxxxxxxxxxxxxx', pad: false, leadWave: 'sawtooth' },
  'h-party': { gritty: true, bpm: 120, chords: [[45, 0, 3, 7], [43, 0, 4, 7], [41, 0, 4, 7], [40, 0, 4, 7]], lead: [3, null, 2, 3, null, 2, 1, null, 3, null, 2, 3, null, 1, 0, null], kick: 'x...x...x...x...', snare: '....x.......x...', hat: '..x...x...x...x.', bass: 'x.xx.xx.x.xx.xx.', pad: true, leadWave: 'sawtooth' },
  'h-finale': { bpm: 100, chords: [[45, 0, 3, 7], [41, 0, 4, 7], [43, 0, 4, 7], [45, 0, 4, 7]], lead: [3, null, 2, 3, 3, null, 2, null, 3, null, 2, 3, 1, null, 2, null], kick: 'x...x...x...x...', snare: '....x.......x.xx', hat: 'x.x.x.x.x.x.x.x.', bass: 'x..x..x.x..x..x.', pad: true, leadWave: 'square' },
  finale: { bpm: 112, chords: [[48, 0, 4, 7], [53, 0, 4, 7], [55, 0, 4, 7], [48, 0, 4, 7]], lead: [3, null, 2, 3, 3, null, 2, null, 3, null, 2, 3, 1, null, 2, null], kick: 'x...x...x...x...', snare: '....x.......x.xx', hat: 'x.x.x.x.x.x.x.x.', bass: 'x..x..x.x..x..x.', pad: true, leadWave: 'square' },
};
function smStepAt(tr, step, t, c, dest) {
  const bar = Math.floor(step / 16) % 4, s = step % 16, ch = tr.chords[bar];
  if (tr.kick[s] === 'x') smKick(c, dest, t, 0.55);
  if (tr.snare && tr.snare[s] === 'x') smSnare(c, dest, t, 0.25);
  if (tr.hat[s] === 'x') smNoise(c, dest, t, 0.04, 0.07, 6500);
  if (tr.bass[s] === 'x') smTone(c, dest, mfreq(ch[0] - 12 + (s % 4 === 3 ? 12 : 0)), t, 0.2, tr.gritty ? 'sawtooth' : 'triangle', tr.gritty ? 0.2 : 0.4);
  if (tr.pad && s === 0) for (let i = 1; i < ch.length; i++) smTone(c, dest, mfreq(ch[0] + 12 + ch[i]), t, 60 / tr.bpm * 3.6, 'sine', 0.07);
  const li = tr.lead[s]; if (li !== null && li !== undefined) { const note = ch[0] + 24 + (li === 3 ? 12 : ch[Math.min(li, ch.length - 1)]); smTone(c, dest, mfreq(note), t, 0.16, tr.leadWave, 0.07); }
}
function musicStop() {
  if (SM.timer) { clearInterval(SM.timer); SM.timer = null; }
  SM.track = null;
  if (SM.master) { try { SM.master.gain.value = 0; SM.master.disconnect(); } catch (e) { /* ok */ } SM.master = null; }
  if (SM.el) { try { SM.el.pause(); } catch (e) { /* ok */ } SM.el = null; }
}
function musicPlay(name, url) {
  if (showMuted()) return;
  if (url) { if (SM.el && SM.el.dataset.src === url) return; musicStop(); try { const a = new Audio(url); a.loop = true; a.volume = 0.5; a.dataset.src = url; a.play().catch(() => {}); SM.el = a; } catch (e) { /* ok */ } return; }
  if (SM.track === name && SM.timer) return;
  const c = smCtx(); if (!c) return;
  musicStop();
  const tr = TRACKS[name] || TRACKS.party; SM.track = name; SM.step = 0;
  SM.master = c.createGain(); SM.master.gain.value = 0.55; SM.master.connect(c.destination);
  SM.next = c.currentTime + 0.1;
  const spb = 60 / tr.bpm / 4;
  SM.timer = setInterval(() => {
    if (!SM.master) return;
    while (SM.next < c.currentTime + 0.25) { smStepAt(tr, SM.step, SM.next, c, SM.master); SM.next += spb; SM.step++; }
  }, 60);
}
let showTheme = 'party';
const HW = () => showTheme === 'halloween';
const TXT = (k) => ({
  ico: HW() ? '💀' : '⚡', lobby: HW() ? 'The night starts soon.' : 'Lock in. The show starts soon.', welcome: HW() ? 'THE NIGHT STARTS NOW' : 'WELCOME TO WARMS LIVE',
  goI: HW() ? '👁️' : '⚡', waitI: HW() ? '🕯️' : '✋', go: 'NOW! CLICK!', rlh: HW() ? 'Run while the lantern is green. Freeze on red!' : 'Run on green. Freeze on red!', rxh: HW() ? 'Wait for the scare. Then click.' : 'Wait for the signal. Then click.',
  dropI: HW() ? '🩸' : '💎', dropW: HW() ? '🕸️' : '📦', hypeI: HW() ? '😱' : '🔥', hypeB: HW() ? 'SCREAM! SCREAM!' : 'TAP! TAP! TAP!', hypeH: HW() ? 'Fill the scream meter together' : 'Fill the surge meter together',
  dance: HW() ? 'MIDNIGHT RAVE' : 'THE DROP', win: HW() ? '💀 Who made it out alive…' : '🏆 Final standings',
})[k];
function sfx(name) {
  if (showMuted()) return;
  const c = smCtx(); if (!c) return;
  if (showTheme === 'halloween') { const m = { round: 'thunder', airhorn: 'laugh', fanfare: 'spookfan', go: 'boo' }[name]; if (m) name = m; }
  const t = c.currentTime, d = c.destination, T = (f, o, dur, type, vol, gl) => smTone(c, d, f, t + o, dur, type, vol || 0.2, gl);
  if (name === 'tick') T(900, 0, 0.05, 'square', 0.08);
  else if (name === 'count') T(660, 0, 0.14, 'square', 0.18);
  else if (name === 'go') { T(880, 0, 0.12, 'square', 0.22); T(1320, 0.1, 0.3, 'square', 0.22); }
  else if (name === 'correct') { T(660, 0, 0.12, 'triangle', 0.25); T(880, 0.1, 0.12, 'triangle', 0.25); T(1320, 0.2, 0.3, 'triangle', 0.25); }
  else if (name === 'wrong') { T(220, 0, 0.3, 'sawtooth', 0.2, 110); }
  else if (name === 'early') { T(180, 0, 0.35, 'square', 0.2, 80); }
  else if (name === 'whoosh') { smNoise(c, d, t, 0.5, 0.2, 800); T(200, 0, 0.5, 'sine', 0.1, 900); }
  else if (name === 'round') { [523, 659, 784, 1047].forEach((f, i) => T(f, i * 0.09, 0.3, 'square', 0.15)); }
  else if (name === 'prize') { [784, 988, 1175, 1568, 1976].forEach((f, i) => T(f, i * 0.07, 0.25, 'triangle', 0.25)); smNoise(c, d, t, 0.3, 0.1, 7000); }
  else if (name === 'miss') { T(300, 0, 0.25, 'triangle', 0.18, 150); }
  else if (name === 'airhorn') { for (let i = 0; i < 3; i++) { T(466, i * 0.28, 0.24, 'sawtooth', 0.22); T(622, i * 0.28, 0.24, 'sawtooth', 0.18); } }
  else if (name === 'applause') { for (let i = 0; i < 14; i++) smNoise(c, d, t + i * 0.12, 0.18, 0.09, 1200 + (i % 3) * 800); }
  else if (name === 'fanfare') { [523, 523, 523, 659, 784, 659, 784, 1047].forEach((f, i) => T(f, i * 0.13, 0.28, 'square', 0.16)); }
  else if (name === 'thunder') { smNoise(c, d, t, 1.1, 0.35, 120); T(70, 0, 0.9, 'sawtooth', 0.18, 35); T(300, 0.1, 0.4, 'sine', 0.05, 90); }
  else if (name === 'laugh') { [440, 392, 349, 330, 294, 262].forEach((f, i) => T(f, i * 0.14, 0.12, 'sawtooth', 0.14, f * 0.9)); }
  else if (name === 'boo') { T(220, 0, 0.5, 'sawtooth', 0.2, 880); T(330, 0.02, 0.5, 'sine', 0.2, 1320); }
  else if (name === 'spookfan') { [440, 440, 440, 523, 622, 523, 622, 880].forEach((f, i) => T(f, i * 0.15, 0.3, 'sawtooth', 0.12)); }
  else if (name === 'hype') { T(300 + Math.random() * 300, 0, 0.06, 'square', 0.07); }
}

/* ---- loading and the little bar/button ---- */
async function loadShow() {
  try { showData = await api('/show'); showOffset = showData.now - Date.now(); } catch (e) { return; }
  renderShowChrome();
  if (stageEl) stageRender();
}
function renderShowChrome() {
  const d = showData, live = !!(d && d.show), bar = $('showBar');
  if (!bar) return;
  if (!live || stageEl) { bar.classList.add('hidden'); return; }
  const v = d.show;
  bar.classList.remove('hidden');
  const left = v.startedAt - showNow();
  bar.replaceChildren(h('span', { class: 'sb-live' }, v.opts.theme === 'halloween' ? '💀 HALLOWEEN SHOW' : '⚡ LIVE SHOW'), h('span', {}, left > 0 ? ` starts in ${fmtClock(left)}` : ' is on right now!'),
    h('button', { type: 'button', class: 'btn primary sb-join', onclick: () => openStage() }, v.joined ? 'Back to the show' : 'Join the show'));
}
setInterval(() => { if (showData && showData.show && !stageEl) renderShowChrome(); }, 1000);

// The Owner (and Admins, if allowed) run shows from their panel. Everyone else joins from the LIVE bar.
function showMaker() {
  const d = showData, live = d && d.show;
  const sec = h('section', { class: 'showmaker' }, h('h4', {}, '🎉 Live Show'),
    h('p', { class: 'note' }, live ? `A show is running right now (${live.players} playing).` : 'Run a hosted event with music, sound effects, trivia, reflex games, prize drops and a finale. Pick the neon show or the Halloween one.'),
    h('div', { class: 'row-end' },
      live ? h('button', { type: 'button', class: 'btn', onclick: () => { closeOverlay(); openStage(); } }, 'Watch / play') : null,
      h('button', { type: 'button', class: 'btn primary', onclick: () => openShowControl() }, live ? 'Show controls' : 'Set up a show')));
  return sec;
}


/* ---- the stage ---- */
async function openStage() {
  if (stageEl) return;
  await attempt(loadShow);
  const v = showData && showData.show; if (!v) return toast('The show is not on right now');
  stageEl = h('div', { class: 'stage' });
  document.body.append(stageEl);
  document.body.classList.add('staging');
  stageLastIdx = -2;
  if (!v.joined) { const r = await attempt(() => api('/show/join', 'POST', {})); if (!r) { closeStage(); return; } await loadShow(); }
  stageEl.addEventListener('pointerdown', () => smCtx(), { once: true });
  stageTimer = setInterval(stageTick, 250);
  stagePoll = setInterval(() => { attempt(loadShow); }, 3000);
  stageRender();
}
// Host announcements: a banner for everyone, and a draggable typing panel for the host.
function showAnnounce(by, text) {
  sfx('airhorn');
  const box = h('div', { class: 'st-announce' + (stageEl ? '' : ' outside') }, h('small', {}, '📣 ' + by), h('b', {}, text));
  (stageEl || document.body).append(box);
  setTimeout(() => box.remove(), 9000);
}
function announcePanel() {
  const box = h('div', { class: 'st-annpanel', id: 'stAnnPanel' });
  const input = h('input', { type: 'text', maxlength: '200', placeholder: 'Type an announcement…' });
  const send = async () => {
    const text = input.value.trim(); if (!text) return;
    const r = await attempt(() => api('/show/announce', 'POST', { text }));
    if (r) input.value = '';
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  const grip = h('div', { class: 'ap-grip', title: 'Drag me anywhere' }, '📣 Announce ', h('span', {}, '⠿'));
  box.append(grip, h('div', { class: 'ap-row' }, input, h('button', { type: 'button', class: 'st-btn', onclick: send }, 'Send')));
  try { const p = JSON.parse(localStorage.getItem('annPos') || 'null'); if (p) { box.style.left = p.x + 'px'; box.style.top = p.y + 'px'; box.style.right = 'auto'; box.style.bottom = 'auto'; } } catch (e) { /* default spot */ }
  let drag = null;
  grip.addEventListener('pointerdown', (e) => { const r = box.getBoundingClientRect(); drag = { dx: e.clientX - r.left, dy: e.clientY - r.top }; grip.setPointerCapture(e.pointerId); e.preventDefault(); });
  grip.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const x = Math.max(0, Math.min(window.innerWidth - box.offsetWidth, e.clientX - drag.dx)), y = Math.max(0, Math.min(window.innerHeight - box.offsetHeight, e.clientY - drag.dy));
    box.style.left = x + 'px'; box.style.top = y + 'px'; box.style.right = 'auto'; box.style.bottom = 'auto';
  });
  const end = () => { if (!drag) return; drag = null; try { localStorage.setItem('annPos', JSON.stringify({ x: parseInt(box.style.left, 10) || 0, y: parseInt(box.style.top, 10) || 0 })); } catch (e) { /* not saved */ } };
  grip.addEventListener('pointerup', end); grip.addEventListener('pointercancel', end);
  return box;
}
function closeStage() {
  if (!stageEl) return;
  clearInterval(stageTimer); clearInterval(stagePoll); stageTimer = stagePoll = null;
  musicStop(); stageEl.remove(); stageEl = null; document.body.classList.remove('staging');
  renderShowChrome();
}
function stageToggleMute() { pref('showmute', showMuted() ? null : '1'); if (showMuted()) musicStop(); else stageLastIdx = -2, stageRender(); }

// Builds the frame once, then the middle part changes with each step.
function stageFrame(v) {
  if (stageEl.dataset.frame === v.id) return;
  stageEl.dataset.frame = v.id;
  stageEl.replaceChildren(
    h('div', { class: 'st-lights' }), h('div', { class: 'st-fog' }, ['🦇', '💀', '🕸️', '🦇', '👁️', '💀', '🦇', '🕸️'].map((e, i) => h('span', { style: `--x:${(i * 13 + 5) % 95}%;--d:${(i * 1.7) % 9}s;--t:${9 + (i % 4) * 3}s` }, e))), h('div', { class: 'st-bolt' }),
    h('div', { class: 'st-top' },
      h('div', { class: 'st-round', id: 'stRound' }),
      h('div', { class: 'st-time' }, h('i', { id: 'stBar' })),
      h('div', { class: 'st-score', id: 'stScore' }),
      h('button', { type: 'button', class: 'st-btn', id: 'stMute', title: 'Sound on or off', onclick: () => { stageToggleMute(); $('stMute').textContent = showMuted() ? '🔇' : '🔊'; } }, showMuted() ? '🔇' : '🔊'),
      h('button', { type: 'button', class: 'st-btn', title: 'Leave the stage (the show keeps going)', onclick: closeStage }, '✕')),
    h('div', { class: 'st-body', id: 'stBody' }),
    h('div', { class: 'st-board', id: 'stBoard' }));
  if (showData && showData.canRun) stageEl.append(announcePanel());
}

function boardStrip(v) {
  const meId = state.me;
  const rows = v.board.slice(0, 5).map((r) => h('span', { class: 'sb-row' + (r.id === meId ? ' me' : '') }, `${['🥇', '🥈', '🥉'][r.rank - 1] || r.rank + '.'} ${r.name} `, h('b', {}, String(r.score))));
  const mine = v.rank > 5 ? [h('span', { class: 'sb-row me' }, `#${v.rank} You `, h('b', {}, String(v.score)))] : [];
  return [h('span', { class: 'sb-title' }, `${v.players} playing`), ...rows, ...mine];
}

function stageRender() {
  const d = showData; if (!stageEl) return;
  const v = d && d.show;
  if (!v) { // the show ended
    const last = d && d.last;
    closeStage();
    if (last && last.results && last.results.length) toast2('The show is over. Thanks for playing!');
    return;
  }
  showTheme = (v.opts && v.opts.theme) || 'party';
  stageFrame(v);
  stageEl.classList.toggle('th-halloween', showTheme === 'halloween');
  $('stBoard').replaceChildren(...boardStrip(v));
  $('stScore').replaceChildren(h('b', {}, String(v.score)), h('small', {}, v.rank ? ` pts · #${v.rank}` : ' pts'));
  const st = v.step, idx = v.index, key = idx + ':' + (st ? st.reveal : '') + ':' + (st && st.full) + ':' + (st && st.winners ? st.winners.length : 0) + ':' + (st && st.mine && !['rlgl', 'bridge', 'tug', 'simon'].includes(st.kind) ? JSON.stringify(st.mine) : '') + (idx === -1 ? 'l' : '');
  // music follows the step
  if (v.opts.musicUrl) musicPlay(null, v.opts.musicUrl); else musicPlay(st ? st.music : 'lobby');
  if (stageEl.dataset.key === key && !(st && (st.kind === 'hype' || st.kind === 'finale'))) return;
  const newStep = stageLastIdx !== idx; stageLastIdx = idx;
  stageEl.dataset.key = key;
  const body = $('stBody'); body.className = 'st-body k-' + (st ? st.kind : 'lobby');
  $('stRound').textContent = st && st.kind !== 'intro' ? stageTitle(st) : 'Warms Live';
  const nodes = stageBuild(v, newStep);
  if (st && st.kind === 'hype') { const keep = body.querySelector('.hy-btn'); if (keep && nodes.keepBtn) { updateHype(v); return; } }
  body.replaceChildren(...nodes.list);
}
const stageTitle = (st) => ({ trivia: `Trivia ${st.n}/${st.of}`, reaction: `Reflexes ${st.n}/${st.of}`, rlgl: `Red Light Green Light ${st.n}/${st.of}`, math: `Math ${st.n}/${st.of}`, drop: `Prize Drop ${st.n}`, hype: `Hype Meter ${st.n}`, simon: `Simon Says ${st.n}/${st.of}`, bridge: `Glass Bridge ${st.n}/${st.of}`, tug: `Tug of War ${st.n}/${st.of}`, dance: 'Dance break', round: st.title || '', finale: 'The Finale' }[st.kind] || 'Warms Live');

function stageTick() {
  const d = showData; if (!stageEl || !d || !d.show) return;
  const v = d.show, st = v.step, now = showNow();
  const bar = $('stBar');
  if (bar && st) { const left = st.at + st.dur - now; bar.style.width = Math.max(0, Math.min(100, (left / st.dur) * 100)) + '%'; bar.classList.toggle('low', left < 4000); }
  else if (bar) { bar.style.width = '100%'; }
  const lobbyClock = stageEl.querySelector('.lb-clock'); if (lobbyClock) lobbyClock.textContent = fmtClock(v.startedAt - now);
  const cnt = stageEl.querySelector('.tr-count'); if (cnt && st && st.answerMs) { const l = st.at + st.answerMs - now; cnt.textContent = l > 0 ? String(Math.ceil(l / 1000)) : '0'; if (l > 0 && l < 5000 && cnt.dataset.s !== String(Math.ceil(l / 1000))) { cnt.dataset.s = String(Math.ceil(l / 1000)); sfx('tick'); } }
  if (st && (st.kind === 'reaction' || st.kind === 'drop')) {
    const go = now >= st.goAt, el = stageEl.querySelector('.go-pad');
    if (el && el.dataset.go !== (go ? '1' : '0') && !st.mine && !st.reveal) { el.dataset.go = go ? '1' : '0'; paintGo(el, go, st); if (go) sfx(st.kind === 'drop' ? 'prize' : 'go'); }
  }
  if (st && (st.kind === 'rlgl' || st.kind === 'bridge') && !st.reveal && Date.now() - stageLastRef > 900) { stageLastRef = Date.now(); attempt(loadShow); }
  // time to move on? ask the server for the new step
  const end = st ? st.at + st.dur : v.startedAt, wantReveal = st && st.answerMs && !st.reveal && now >= st.at + st.answerMs;
  if ((now >= end + 150 || wantReveal) && Date.now() - stageLastRef > 700) { stageLastRef = Date.now(); attempt(loadShow); }
  if (v.index === -1 && now >= v.startedAt && Date.now() - stageLastRef > 700) { stageLastRef = Date.now(); attempt(loadShow); }
}


// A shared arena: every player's picture is a little token you can watch move.
const hashN = (str) => { let x = 0; for (const c of String(str)) x = (x * 31 + c.charCodeAt(0)) >>> 0; return x; };
function crowdLayer() {
  const layer = h('div', { class: 'crowd' }), toks = new Map();
  return { layer, set(list, place) {
    const seen = new Set();
    for (const c of list) {
      seen.add(c.id);
      let t = toks.get(c.id);
      if (!t) {
        const u = userById(c.id) || { username: c.name || '?' };
        t = h('div', { class: 'tok' + (c.id === state.me ? ' me' : ''), title: c.name }, avatar(u, false), h('span', { class: 'tok-n' }, c.id === state.me ? 'You' : (c.name || '').slice(0, 10)));
        toks.set(c.id, t); layer.append(t);
      }
      const q = place(c); t.style.left = q.x + '%'; t.style.top = q.y + '%';
      t.classList.toggle('hit', !!c.hit); t.classList.toggle('fin', !!c.fin);
    }
    for (const [id, t] of toks) if (!seen.has(id)) { t.remove(); toks.delete(id); }
  } };
}
const liveStep = (i) => { const d = showData && showData.show; return d && d.step && d.step.i === i ? d.step : null; };

// Simon Says: watch the pattern flash, then repeat it.
function simonGame(st) {
  const COL = HW() ? ['#c1121f', '#7c3aed', '#d4a017', '#2a9d8f'] : ['#ff2d95', '#19c3ff', '#ffd23f', '#19ff7a'];
  const pads = COL.map((c, i) => h('button', { type: 'button', class: 'sm-pad', style: `--c:${c}`, disabled: true, 'data-i': i, onclick: () => press(i) }));
  const msg = h('div', { class: 'tr-msg' }, 'Watch carefully…');
  const dots = h('div', { class: 'sm-dots' });
  const root = h('div', { class: 'sm' }, h('h2', {}, HW() ? 'Repeat the candle pattern' : 'Repeat the pattern'), h('div', { class: 'sm-grid' }, ...pads), dots, msg);
  const mine0 = st.mine;
  let entered = [], sent = !!mine0, shown = -1;
  const flash = (i) => { pads[i].classList.add('lit'); sfx('tick'); setTimeout(() => pads[i].classList.remove('lit'), 420); };
  const press = async (i) => {
    if (sent || showNow() < st.at + st.showMs || showNow() > st.at + st.answerMs) return;
    entered.push(i); flash(i); dots.textContent = '●'.repeat(entered.length) + '○'.repeat(st.L - entered.length);
    if (entered.length < st.L) return;
    sent = true; pads.forEach((b) => { b.disabled = true; });
    const r = await attempt(() => api('/show/simon', 'POST', { step: st.i, seq: entered }));
    if (r) { msg.textContent = r.correct ? `✅ Perfect! +${r.pts} points` : `❌ Not quite (${r.prefix}/${st.L} right) +${r.pts}`; sfx(r.correct ? 'correct' : 'wrong'); }
  };
  const loop = setInterval(() => {
    if (!root.isConnected) return clearInterval(loop);
    const off = showNow() - st.at;
    if (off < st.showMs) {
      const k = Math.floor((off - 1200) / 800);
      if (k >= 0 && k < st.L && k !== shown && (off - 1200) % 800 < 600) { shown = k; flash(st.seq[k]); }
      msg.textContent = 'Watch carefully…';
    } else if (!sent && off <= st.answerMs) {
      pads.forEach((b) => { b.disabled = false; });
      if (!entered.length) { msg.textContent = 'Your turn! Repeat it'; dots.textContent = '○'.repeat(st.L); }
    } else if (!sent) { pads.forEach((b) => { b.disabled = true; }); msg.textContent = '⏰ Time ran out'; }
    if (st.reveal && !sent) { sent = true; }
  }, 80);
  if (mine0) msg.textContent = mine0.correct ? `✅ Perfect! +${mine0.pts} points` : `❌ ${mine0.prefix}/${st.L} right +${mine0.pts}`;
  return root;
}

// Glass Bridge: pick a panel each row. Broken panels found by anyone are shown to everyone.
function bridgeGame(st) {
  const rows = [], crowd = crowdLayer();
  const grid = h('div', { class: 'gb' });
  const msg = h('div', { class: 'tr-msg' }, 'Pick a panel. Watch what others break!');
  let row = (st.mine && st.mine.row) || 0, lock = 0, done = !!(st.mine && st.mine.finished), busy = false;
  for (let r = st.rows - 1; r >= 0; r--) {
    const cells = [0, 1].map((side) => h('button', { type: 'button', class: 'gb-cell', 'data-r': r, 'data-s': side, onclick: () => step(r, side) }));
    rows[r] = cells; grid.append(h('div', { class: 'gb-row' }, h('span', { class: 'gb-n' }, String(r + 1)), ...cells));
  }
  const paint = () => {
    const cur = liveStep(st.i) || st, found = cur.found || {}, safe = cur.safe;
    rows.forEach((cells, r) => cells.forEach((c, side) => {
      const known = found[r] !== undefined ? found[r] : (safe ? safe[r] : undefined);
      c.className = 'gb-cell' + (r < row ? ((known === side) ? ' ok' : ' gone') : '') + (r === row && !done ? ' now' : '') + (known !== undefined && known !== side ? ' broken' : '') + (known === side && r >= row ? ' hint' : '');
      c.textContent = known !== undefined && known !== side ? '💥' : (known === side && r >= row ? '✅' : '');
      c.disabled = done || r !== row || Date.now() < lock || cur.reveal || null;
    }));
    const list = (cur.crowd || []).filter((c) => c.id !== state.me);
    list.push({ id: state.me, name: 'You', pos: row, hit: Date.now() < lock, fin: done });
    crowd.set(list, (c) => ({ x: 6 + (hashN(c.id) % 80), y: 100 - (c.pos / (st.rows + 1)) * 100 - 6 }));
  };
  const step = async (r, side) => {
    if (busy || r !== row || done) return; busy = true;
    const res = await attempt(() => api('/show/bridge', 'POST', { step: st.i, side }));
    busy = false; if (!res) return;
    const cur = liveStep(st.i); if (cur) cur.found = res.found;
    if (res.fell) { sfx('early'); lock = Date.now() + 1500; row = 0; msg.textContent = '💥 The panel shattered! Back to the start. Now everyone can see it'; grid.classList.add('shake'); setTimeout(() => grid.classList.remove('shake'), 500); }
    else { row = res.row; sfx('correct'); if (res.finished) { done = true; msg.textContent = `🏁 You crossed! +${res.pts} points`; popConfetti(); } else msg.textContent = 'Safe! Keep going'; }
    paint();
  };
  const root = h('div', { class: 'gbw' }, h('h2', {}, HW() ? 'Cross the haunted bridge' : 'Cross the glass bridge'), h('div', { class: 'gb-map' }, grid, crowd.layer), msg);
  const loop = setInterval(() => { if (!root.isConnected) return clearInterval(loop); paint(); }, 400);
  paint(); return root;
}

// Tug of War: two teams, tap to pull the rope.
function tugGame(st) {
  const fill = h('i', {}), knot = h('span', { class: 'tg-knot' }, '🪢'), rope = h('div', { class: 'tg-rope' }, fill, knot);
  const names = st.tug.names, team = st.tug.team;
  const label = h('div', { class: 'tg-teams' }, h('span', { class: 't0' }, names[0] + (team === 0 ? ' (you)' : '')), h('span', { class: 't1' }, names[1] + (team === 1 ? ' (you)' : '')));
  const msg = h('div', { class: 'tr-msg' }, `You are on team ${names[team]}. Mash the button!`);
  let pending = 0, busy = false;
  const flush = async () => {
    if (busy || !pending) return; const n = pending; pending = 0; busy = true;
    const r = await attempt(() => api('/show/pull', 'POST', { n })); busy = false;
    const cur = liveStep(st.i); if (r && cur) cur.tug.t = r.t;
  };
  const pullIt = () => { if (showNow() > st.at + st.answerMs) return; pending++; const cur = liveStep(st.i); if (cur) cur.tug.t[team]++; if (pending >= 3) flush(); };
  const btn = h('button', { type: 'button', class: 'rl-btn tg-btn' }, 'PULL!');
  btn.addEventListener('pointerdown', (e) => { e.preventDefault(); pullIt(); });
  const onKey = (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); pullIt(); } };
  document.addEventListener('keydown', onKey);
  const root = h('div', { class: 'tg' }, h('h2', {}, HW() ? 'Ghosts vs Witches!' : 'Team battle!'), label, rope, btn, msg);
  const loop = setInterval(() => {
    if (!root.isConnected) { clearInterval(loop); document.removeEventListener('keydown', onKey); return; }
    flush();
    const cur = liveStep(st.i) || st, t = cur.tug.t, tot = (t[0] + t[1]) || 1;
    fill.style.width = (t[0] / tot * 100) + '%'; knot.style.left = (t[0] / tot * 100) + '%';
    const over = showNow() > st.at + st.answerMs;
    btn.disabled = over || null;
    if (over) { const w = cur.tug.winner; if (w === -1) msg.textContent = 'A tie!'; else if (w >= 0) { msg.textContent = `🏆 ${names[w]} wins!` + (w === team ? ' Your team gets a bonus!' : ''); } }
  }, 100);
  return root;
}

// Red Light, Green Light: tap (or press Space) to run, but only while the light is green.
function rlglGame(st) {
  const light = h('div', { class: 'rl-light' }), word = h('div', { class: 'rl-word' });
  const crowd = crowdLayer(), track = h('div', { class: 'rl-field' }, h('span', { class: 'rl-start' }, 'START'), h('span', { class: 'rl-flag' }, '🏁'), crowd.layer);
  const msg = h('div', { class: 'tr-msg' }, 'Tap fast on green. Stop on red!');
  const btn = h('button', { type: 'button', class: 'rl-btn' }, 'RUN!');
  const mine0 = st.mine || {};
  let pos = mine0.pos || 0, pending = 0, busy = false, lockUntil = 0, done = !!mine0.finished;
  const place = (c) => ({ x: 3 + Math.min(1, c.pos / st.finish) * 82, y: (hashN(c.id) % 8) * 11 + 2 });
  const paint = () => {
    const cur = liveStep(st.i) || st, list = (cur.crowd || []).filter((c) => c.id !== state.me);
    list.push({ id: state.me, name: 'You', pos, hit: Date.now() < lockUntil, fin: done });
    crowd.set(list, place);
  };
  const phase = () => {
    const off = showNow() - st.at; let t = 0;
    for (let i = 0; i < st.segs.length; i++) { if (off < t + st.segs[i]) return { green: i % 2 === 1, left: t + st.segs[i] - off }; t += st.segs[i]; }
    return { green: false, left: 0 };
  };
  let last = null;
  const flush = async () => {
    if (busy || !pending || done) return;
    const n = pending; pending = 0; busy = true;
    const r = await attempt(() => api('/show/run', 'POST', { step: st.i, n }));
    busy = false;
    if (!r) return;
    pos = r.pos; paint();
    if (r.caught) { sfx('early'); btn.classList.add('shake'); setTimeout(() => btn.classList.remove('shake'), 500); msg.textContent = '🚫 Caught moving on red! Back to the start'; lockUntil = Date.now() + 1500; }
    if (r.finished && !done) { done = true; sfx('correct'); msg.textContent = `🏁 You made it! +${r.pts} points`; popConfetti(); }
  };
  const tap = () => {
    if (done || st.reveal || Date.now() < lockUntil || showNow() > st.at + st.answerMs) return;
    pending++; if (phase().green) { pos = Math.min(st.finish, pos + 1); paint(); } if (pending >= 3) flush();
  };
  btn.addEventListener('pointerdown', (e) => { e.preventDefault(); tap(); });
  const onKey = (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); tap(); } };
  document.addEventListener('keydown', onKey);
  const root = h('div', { class: 'rl' }, h('h2', {}, TXT('rlh')), light, word, track, btn, msg);
  const loop = setInterval(() => {
    if (!root.isConnected) { clearInterval(loop); document.removeEventListener('keydown', onKey); return; }
    flush(); paint(); track.classList.toggle('g', phase().green);
    const p = phase(), g = p.green;
    if (last !== g) { last = g; light.className = 'rl-light ' + (g ? 'green' : 'red'); word.textContent = g ? 'GO! GO! GO!' : 'FREEZE!'; if (!st.reveal && !done) sfx(g ? 'go' : 'miss'); }
    if (Date.now() < lockUntil) btn.disabled = true; else btn.disabled = done || st.reveal || null;
    if (showNow() > st.at + st.answerMs && !done) { word.textContent = 'Time!'; light.className = 'rl-light red'; }
  }, 80);
  paint(); return root;
}

function paintGo(el, go, st) {
  if (st.kind === 'drop') { el.className = 'go-pad drop' + (go ? ' go' : ''); el.firstChild.textContent = go ? TXT('dropI') : TXT('dropW'); el.lastChild.textContent = go ? 'GRAB IT!' : 'Get ready'; }
  else { el.className = 'go-pad react' + (go ? ' go' : ''); el.firstChild.textContent = go ? TXT('goI') : TXT('waitI'); el.lastChild.textContent = go ? TXT('go') : 'WAIT…'; }
}

function stageBuild(v, newStep) {
  const st = v.step, list = [];
  const say = (cls, ...kids) => h('div', { class: cls }, ...kids);
  if (!st) { // lobby: waiting for the show to open
    if (newStep) sfx('round');
    list.push(say('lb', h('div', { class: 'lb-ico' }, TXT('ico')), h('h1', {}, TXT('lobby')), say('lb-clock', fmtClock(v.startedAt - showNow())),
      h('p', {}, 'Turn your sound up. Trivia, reflexes, loot drops and real prizes. Top three get paid.'), prizeBox(v), h('p', { class: 'dim' }, `${v.players} player${v.players === 1 ? '' : 's'} in the room`)));
    return { list };
  }
  if (st.kind === 'intro') {
    if (newStep) { sfx('fanfare'); popConfetti(); }
    list.push(say('lb', h('div', { class: 'lb-ico' }, TXT('ico')), h('h1', {}, TXT('welcome')),
      h('p', {}, 'Five rounds. Every point counts toward the payout.'), prizeBox(v),
      h('ul', { class: 'lb-how' }, h('li', {}, '🧠 Trivia: right answers, faster = more points'), h('li', {}, '⚡ Reflexes: click on the signal. Early costs you'), h('li', {}, '💎 Loot drops: first three to grab it win'), h('li', {}, '🔥 Surge: everyone taps, everyone gets paid'))));
    return { list };
  }
  if (st.kind === 'round') {
    if (newStep) sfx('whoosh');
    list.push(say('rd', h('div', { class: 'rd-ico' }, st.icon), h('h1', {}, st.title), h('p', {}, st.sub)));
    return { list };
  }
  if (st.kind === 'trivia') {
    const mine = st.mine, letters = ['A', 'B', 'C', 'D'];
    if (newStep) sfx('round');
    if (st.reveal && newStepReveal(st)) sfx(mine && mine.correct ? 'correct' : 'wrong');
    list.push(say('tr', say('tr-count-wrap', h('span', { class: 'tr-count' }, st.reveal ? '0' : '')), h('h2', {}, st.q)));
    const opts = h('div', { class: 'tr-opts' }, st.options.map((o, i) => {
      const cls = ['tr-opt', 'c' + i];
      if (st.reveal) { if (i === st.ans) cls.push('right'); else if (mine && mine.choice === i) cls.push('wrongpick'); else cls.push('dim'); }
      else if (mine && mine.choice === i) cls.push('picked');
      return h('button', { type: 'button', class: cls.join(' '), disabled: !!mine || st.reveal || null, onclick: async () => { sfx('tick'); const r = await attempt(() => api('/show/answer', 'POST', { step: st.i, choice: i })); if (r) attempt(loadShow); } }, h('b', {}, letters[i]), ' ' + o);
    }));
    list.push(opts);
    list.push(say('tr-msg', st.reveal ? (mine ? (mine.correct ? `✅ Correct! +${mine.pts} points` : '❌ Not this time') : '⏰ You ran out of time') : (mine ? '🔒 Locked in' : 'Lock in your answer')));
    return { list };
  }
  if (st.kind === 'math') {
    const mine = st.mine;
    if (newStep) sfx('round');
    if (st.reveal && newStepReveal(st)) sfx(mine && mine.correct ? 'correct' : 'wrong');
    const input = h('input', { type: 'number', class: 'mt-in', placeholder: '?', inputmode: 'numeric', disabled: !!mine || st.reveal || null });
    const submit = async () => { if (input.value === '' || mine || st.reveal) return; input.disabled = true; const r = await attempt(() => api('/show/answer', 'POST', { step: st.i, value: input.value })); if (r) attempt(loadShow); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    list.push(say('tr', say('tr-count-wrap', h('span', { class: 'tr-count' }, st.reveal ? '0' : '')), h('h2', { class: 'mt-q' }, st.text + ' = ?'),
      say('mt-row', input, h('button', { type: 'button', class: 'btn primary', disabled: !!mine || st.reveal || null, onclick: submit }, 'Go'))));
    list.push(say('tr-msg', st.reveal ? `The answer was ${st.ans}. ` + (mine ? (mine.correct ? `✅ +${mine.pts} points` : '❌ Not this time') : '⏰ No answer') : (mine ? '🔒 Locked in!' : 'Type your answer and press Enter')));
    if (!mine && !st.reveal) setTimeout(() => input.focus(), 50);
    return { list };
  }
  if (st.kind === 'rlgl') {
    if (newStep) sfx('round');
    list.push(rlglGame(st));
    return { list };
  }
  if (st.kind === 'simon') { if (newStep) sfx('round'); list.push(simonGame(st)); return { list }; }
  if (st.kind === 'bridge') { if (newStep) sfx('round'); list.push(bridgeGame(st)); return { list }; }
  if (st.kind === 'tug') { if (newStep) sfx('airhorn'); list.push(tugGame(st)); return { list }; }
  if (st.kind === 'reaction') {
    const mine = st.mine, go = showNow() >= st.goAt;
    if (newStep) sfx('round');
    const pad = h('button', { type: 'button', class: 'go-pad react' + (go ? ' go' : ''), 'data-go': go ? '1' : '0', onclick: async () => {
      if (st.mine || st.reveal) return;
      const r = await attempt(() => api('/show/react', 'POST', { step: st.i })); if (!r) return;
      sfx(r.early ? 'early' : 'correct'); attempt(loadShow);
    } }, h('div', { class: 'gp-ico' }, go ? TXT('goI') : TXT('waitI')), h('div', { class: 'gp-t' }, go ? TXT('go') : 'WAIT…'));
    list.push(say('rx', h('h2', {}, TXT('rxh')), pad,
      say('tr-msg', mine ? (mine.early ? '🚫 Too early! −50 points' : `⚡ ${Math.round(mine.ms)} ms · +${mine.pts} points`) : (st.reveal ? '⏰ You missed it' : ''))));
    return { list };
  }
  if (st.kind === 'drop') {
    const mine = st.mine, go = showNow() >= st.goAt;
    if (newStep) sfx('round');
    if (mine && mine.claimed && stageEl.dataset.dropmsg !== String(st.i)) { stageEl.dataset.dropmsg = String(st.i); }
    const label = st.prize.kind === 'coins' ? `${st.prize.amount} coins` : st.prize.kind === 'spin' ? 'a free machine spin' : 'a random tag';
    const pad = h('button', { type: 'button', class: 'go-pad drop' + (go ? ' go' : ''), 'data-go': go ? '1' : '0', disabled: !!mine || st.reveal || null, onclick: async () => {
      if (st.mine || st.reveal) return;
      const r = await attempt(() => api('/show/claim', 'POST', { step: st.i })); if (!r) return;
      if (r.missed) { sfx('miss'); toast2('Too slow, someone got it first'); } else { sfx('prize'); popConfetti(); toast2(`🎁 You won ${r.text || 'a prize'}!`); attempt(loadEcoSoft); }
      attempt(loadShow);
    } }, h('div', { class: 'gp-ico' }, go ? TXT('dropI') : TXT('dropW')), h('div', { class: 'gp-t' }, go ? 'GRAB IT!' : 'Get ready'));
    list.push(say('rx', h('h2', {}, `Loot drop: ${label}`), h('p', { class: 'dim' }, 'First three to grab it win.'), pad,
      say('tr-msg', st.winners.length ? '🏆 Grabbed by: ' + st.winners.join(', ') : (st.reveal ? 'Nobody grabbed it!' : ''))));
    return { list };
  }
  if (st.kind === 'hype') {
    if (newStep) sfx('airhorn');
    const btn = h('button', { type: 'button', class: 'hy-btn', onclick: hypeTap }, h('span', {}, TXT('hypeI')), h('b', {}, TXT('hypeB')));
    const meter = say('hy-meter', h('i', { id: 'hyFill' }), h('span', { id: 'hyTxt' }));
    list.push(say('hy', h('h2', {}, TXT('hypeH')), meter, btn, say('tr-msg', 'Keep going until the bar is full')));
    setTimeout(() => updateHype(showData.show), 0);
    return { list, keepBtn: true };
  }
  if (st.kind === 'dance') {
    if (newStep) { sfx('airhorn'); popConfetti(); }
    list.push(say('dn', h('div', { class: 'eq' }, Array.from({ length: 28 }, (_, i) => h('i', { style: `--i:${i};--h:${30 + (i * 37) % 70}%` }))), h('h1', {}, TXT('dance')), h('p', {}, HW() ? 'Lights out. Turn it up.' : 'Turn it up. Nothing to do but feel it.')));
    return { list };
  }
  if (st.kind === 'finale') {
    if (newStep) { sfx('fanfare'); popConfetti(); setTimeout(() => sfx('applause'), 900); }
    const res = st.results;
    if (!res) { list.push(say('fn', h('h1', {}, '🏆 Final scores'), h('p', {}, 'Counting up the payouts…'))); return { list }; }
    const medals = ['🥇', '🥈', '🥉'];
    const podium = res.slice(0, 3).map((r, i) => say('pod p' + i, h('div', { class: 'pod-m' }, medals[i]), h('b', {}, r.name), h('small', {}, `${r.score} pts`),
      h('small', { class: 'pod-prize' }, [r.coins ? `${r.coins.toLocaleString('en-US')} 🪙` : '', r.spins ? `${r.spins} 🎰` : '', r.tag ? '🏷️ tag' : ''].filter(Boolean).join(' · '))));
    const me = res.find((r) => r.id === state.me);
    list.push(say('fn', h('h1', {}, TXT('win')), say('podium', ...podium),
      me ? say('fn-me', `You finished #${me.rank} with ${me.score} points and won ${me.coins.toLocaleString('en-US')} coins${me.spins ? ` + ${me.spins} free spins` : ''}${me.tag ? ' + a tag' : ''}${me.evTag ? ' and the limited event tag' : ''}!`) : say('fn-me', 'Thanks for watching!'),
      h('div', { class: 'fn-list' }, res.slice(3, 10).map((r) => h('div', { class: 'fn-row' + (r.id === state.me ? ' me' : '') }, `#${r.rank} ${r.name}`, h('b', {}, `${r.score} pts`))))));
    return { list };
  }
  return { list };
}
const revealSeen = {};
function newStepReveal(st) { if (revealSeen[st.i]) return false; revealSeen[st.i] = true; return true; }
async function loadEcoSoft() { try { const e = await api('/economy'); takeEco(e); } catch (x) { /* ok */ } }

function prizeBox(v) {
  const o = v.opts;
  return h('div', { class: 'lb-prizes' }, [`🥇 ${o.prizes[0].toLocaleString('en-US')} 🪙${o.spins[0] ? ` + ${o.spins[0]} 🎰` : ''}${o.winnerTag ? ' + a tag' : ''}`, `🥈 ${o.prizes[1].toLocaleString('en-US')} 🪙${o.spins[1] ? ` + ${o.spins[1]} 🎰` : ''}`, `🥉 ${o.prizes[2].toLocaleString('en-US')} 🪙${o.spins[2] ? ` + ${o.spins[2]} 🎰` : ''}`, `🎈 ${o.partCoins} 🪙 just for joining`].map((t) => h('span', {}, t)));
}

// Hype: taps are collected and sent a few times a second.
let hypePending = 0, hypeFlushT = null;
function hypeTap() {
  hypePending++; sfx('hype');
  const b = stageEl && stageEl.querySelector('.hy-btn'); if (b) { b.classList.remove('pulse'); void b.offsetWidth; b.classList.add('pulse'); }
  if (!hypeFlushT) hypeFlushT = setTimeout(async () => {
    const n = hypePending; hypePending = 0; hypeFlushT = null;
    try { const r = await api('/show/tap', 'POST', { n }); if (showData && showData.show && showData.show.step && showData.show.step.hype) { showData.show.step.hype.total = r.total; showData.show.step.hype.mine = r.mine; showData.show.step.hype.target = r.target; updateHype(showData.show); } } catch (e) { /* meter closed */ }
  }, 400);
}
function updateHype(v) {
  const st = v && v.step; if (!st || st.kind !== 'hype' || !st.hype) return;
  const f = $('hyFill'), t = $('hyTxt'); if (!f) return;
  const pct = Math.min(100, Math.round((st.hype.total / st.hype.target) * 100));
  f.style.width = pct + '%'; f.classList.toggle('full', pct >= 100);
  t.textContent = pct >= 100 ? '🔥 METER FULL! Everyone gets coins!' : `${pct}% · you tapped ${st.hype.mine}`;
  const b = stageEl && stageEl.querySelector('.hy-btn'); if (b) b.disabled = !!st.reveal;
}

/* ---- the control window for the host ---- */
async function openShowControl() {
  await attempt(loadShow);
  const d = showData; if (!d) return;
  if (!d.canRun) return toast('Only the Owner can run a show');
  const o = d.defaults, live = d.show;
  const num = (v, w) => h('input', { type: 'number', min: 0, value: v, style: `width:${w || 90}px` });
  const theme = h('select', {}, h('option', { value: 'party' }, '⚡ Live show (neon)'), h('option', { value: 'halloween' }, '💀 Halloween show (dark)'));
  const len = h('select', {}, d.presets.map((p) => h('option', { value: p.id, selected: p.id === o.length || null }, p.label)));
  const pz = [num(o.prizes[0]), num(o.prizes[1]), num(o.prizes[2])], sp = [num(o.spins[0], 60), num(o.spins[1], 60), num(o.spins[2], 60)];
  const part = num(o.partCoins), hype = num(o.hypeCoins), back = num(o.returnCoins);
  const tag = h('input', { type: 'checkbox', checked: o.winnerTag });
  const mode = h('select', {}, h('option', { value: 'builtin' }, 'Built-in music (made by the site)'), h('option', { value: 'link' }, 'My own music link'));
  const url = h('input', { type: 'text', placeholder: 'https://… link to an audio file (.mp3, .ogg…)', maxlength: 400 });
  const box = h('div', { class: 'modal showctl' },
    h('h2', {}, '🎉 Live Show'),
    h('p', { class: 'dim' }, 'Music, trivia, party games, prize drops and a finale. Everyone joins from the LIVE bar at the top.'));
  if (live) {
    box.append(h('div', { class: 'sc-live' }, h('b', {}, '🔴 A show is running'), h('div', {}, `${live.players} player${live.players === 1 ? '' : 's'} · started by ${live.by || 'the host'}`)),
      h('div', { class: 'row-end' },
        h('button', { type: 'button', class: 'btn', onclick: () => { closeOverlay(); openStage(); } }, 'Watch / play'),
        h('button', { type: 'button', class: 'btn danger', onclick: async () => { if (!(await confirmBox('End the show now?', 'Nobody gets the finale prizes if you stop it early.', 'End show'))) return; await attempt(() => api('/show/stop', 'POST', {})); await loadShow(); closeOverlay(); } }, 'End the show')));
  } else {
    box.append(
      h('label', {}, 'Theme', theme),
      h('label', {}, 'Length', len),
      h('label', {}, 'Prize coins: 1st / 2nd / 3rd', h('span', { class: 'sc-row' }, ...pz)),
      h('label', {}, 'Free machine spins: 1st / 2nd / 3rd', h('span', { class: 'sc-row' }, ...sp)),
      h('label', {}, 'Coins for everyone who joins', part),
      h('label', {}, 'Tug of war win bonus coins (each win)', hype),
      h('label', {}, 'Bonus coins for people who already hold a limited event tag', back),
      h('label', { class: 'own-check' }, tag, ' The winner also gets a random tag (never a Croma)'),
      h('label', {}, 'Music', mode), h('label', {}, 'Music link (only used for "My own music link")', url),
      h('div', { class: 'row-end' }, h('button', { type: 'button', class: 'btn primary', onclick: async () => {
        const r = await attempt(() => api('/show/start', 'POST', { theme: theme.value, length: len.value, prizes: pz.map((i) => Number(i.value)), spins: sp.map((i) => Number(i.value)), partCoins: Number(part.value), returnCoins: Number(back.value), hypeCoins: Number(hype.value), winnerTag: tag.checked, musicMode: mode.value, musicUrl: url.value }));
        if (r) { await loadShow(); closeOverlay(); toast2('🎉 The show is starting!'); openStage(); }
      } }, 'Start the show')));
  }
  if (d.owner) {
    const adm = h('input', { type: 'checkbox', checked: d.admins, onchange: async () => { await attempt(() => api('/owner/show-admins', 'PUT', { enabled: adm.checked })); } });
    box.append(h('hr'), h('label', { class: 'own-check' }, adm, ' Let Admins start and stop shows too'));
  }
  if (d.last && d.last.results && d.last.results[0]) box.append(h('p', { class: 'dim' }, `Last show winner: ${d.last.results[0].name} (${d.last.results[0].score} pts)`));
  box.append(h('div', { class: 'row-end' }, h('button', { type: 'button', class: 'btn', onclick: closeOverlay }, 'Close')));
  openOverlay(box);
}

/* ------------------------------------------------------------------ boot */

/* Welcome splash: plays for everyone on every visit, then new visitors get the login and members go straight in. */
const SPLASH_HTML = $('splash') ? $('splash').outerHTML : '';
window.replaySplash = () => { if ($('splash') || !SPLASH_HTML) return; document.body.insertAdjacentHTML('afterbegin', SPLASH_HTML); splashSetup(true); };
function splashSetup(force) {
  const sp = $('splash'); if (!sp) return null;
  if (!force && navigator.webdriver && !/[?&]splash=1/.test(location.search)) { sp.remove(); return null; }
  const t = $('spTitle'); 'Warms World'.split('').forEach((c, i) => t.append(h('span', { style: `--i:${i}` }, c === ' ' ? '\u00a0' : c)));
  const st = sp.querySelector('.sp-stars');
  for (let i = 0; i < 40; i++) st.append(h('i', { style: `left:${rnd(100)}%;top:${rnd(100)}%;--d:${(rnd(30) / 10).toFixed(1)}s;--s:${2 + rnd(4)}px` }));
  const bu = $('spBurst');
  for (let i = 0; i < 46; i++) { const a = (i / 46) * Math.PI * 2 + Math.random() * .3, d = 140 + rnd(260); bu.append(h('i', { style: `--bx:${(Math.cos(a) * d).toFixed(0)}px;--by:${(Math.sin(a) * d).toFixed(0)}px;--bs:${3 + rnd(6)}px;--bh:${rnd(60)};--bd:${(rnd(30) / 100).toFixed(2)}s` })); }
  const pct = $('spPct'), t0 = Date.now(), calm = calmMotion(), total = calm ? 900 : 6200;
  const tick = setInterval(() => { const x = Math.max(0, Math.min(1, (Date.now() - t0 - (calm ? 0 : 3700)) / (calm ? total : 1800))); pct.textContent = Math.round(x * 100) + '%'; if (x >= 1) clearInterval(tick); }, 60);
  document.body.classList.add('splashing');
  const started = Date.now();
  let leaving = false;
  const done = new Promise((res) => {
    const leave = () => { if (leaving) return; leaving = true; clearInterval(tick); sp.classList.add('out'); document.body.classList.remove('splashing'); setTimeout(() => { sp.remove(); res(); }, 850); };
    $('spEnter').addEventListener('click', () => { uiSound('open'); leave(); });
    window.__splashLeave = leave;
  });
  return done;
}

(async function boot() {
  const splash = splashSetup();
  let authNeeded = !state.token;
  if (!authNeeded) { try { await start(); } catch (e) { authNeeded = true; } }
  if (splash) await splash;
  if (authNeeded) showAuth();
})();

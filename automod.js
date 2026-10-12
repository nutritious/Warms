'use strict';
// AutoMod: the chat-filter bot. Pure logic, no server state, so it is easy to test.
// check(userId, text, extraWords) -> null (fine) or { reason: 'language' | 'spam', detail }

// Words that are blocked when they appear as a whole word.
const EXACT = new Set([
  'ass', 'asshole', 'assholes', 'arse', 'arsehole', 'bastard', 'bastards', 'bitch', 'bitches', 'bitchy', 'dick', 'dicks', 'dickhead',
  'cock', 'cocks', 'pussy', 'pussies', 'slut', 'sluts', 'whore', 'whores', 'twat', 'wanker', 'prick', 'douche', 'douchebag',
  'cum', 'jizz', 'tits', 'boobs', 'porn', 'fag', 'fags', 'kike', 'spic', 'chink', 'coon', 'tranny', 'dyke', 'retard', 'retards', 'retarded',
]); // mild slang (wtf, damn, hell...) is allowed on purpose

// Blocked when a word STARTS with one of these (catches fuuuck, fucking, motherfucker via the second list).
const STEMS = ['fuck', 'shit', 'bitch', 'cunt', 'nigg', 'faggot', 'whore', 'bullshit', 'asshol', 'dickhead', 'cocksuck', 'jackass', 'dumbass', 'wank'];
const INSIDE = ['motherfuck', 'fucker', 'fucking', 'shithead', 'bullshit', 'nigger', 'nigga'];

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's', '!': 'i', '+': 't', '€': 'e' };

function normalize(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/(?<![a-z0-9])[!+]|[!+](?![a-z0-9])/g, ' ') // "ass!" is punctuation, "sh!t" is a letter
    .replace(/[0134578@$!+€]/g, (c) => LEET[c]);
}

// Lower-case words made of letters only, repeated letters squeezed ("fuuuuck" -> "fuck").
function wordsOf(text) {
  const out = [];
  for (const raw of normalize(text).split(/[^a-z]+/)) {
    if (!raw) continue;
    out.push(raw, raw.replace(/(.)\1+/g, '$1'));
  }
  return out;
}

// "f u c k", "f.u.c.k" and "s-h-i-t": single letters separated by spaces or punctuation.
function spacedOut(text) {
  const runs = normalize(text).match(/(?:^|[^a-z])((?:[a-z][\s.\-_*]+){2,}[a-z])(?=$|[^a-z])/g) || [];
  return runs.map((r) => r.replace(/[^a-z]/g, ''));
}

function badWord(text, extra = []) {
  const extras = new Set(extra.map((w) => String(w).toLowerCase().trim()).filter(Boolean));
  const check = (w) => {
    if (EXACT.has(w) || extras.has(w)) return true;
    if (STEMS.some((s) => w.startsWith(s))) return true;
    if (INSIDE.some((s) => w.includes(s))) return true;
    return false;
  };
  for (const w of wordsOf(text)) if (check(w)) return w;
  for (const w of spacedOut(text)) if (check(w) || check(w.replace(/(.)\1+/g, '$1'))) return w;
  return null;
}

const history = new Map(); // userId -> [{ ts, key }]

function spamReason(userId, text, now = Date.now()) {
  const raw = String(text);
  const key = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  const list = (history.get(userId) || []).filter((m) => now - m.ts < 60_000);
  list.push({ ts: now, key });
  history.set(userId, list);

  if (list.filter((m) => now - m.ts < 8_000).length >= 7) return 'sending messages too fast';
  if (key.length >= 2 && list.filter((m) => m.key === key).length >= 4) return 'repeating the same message';
  if (/(.)\1{14,}/.test(raw)) return 'repeating characters';
  if ((raw.match(/@/g) || []).length >= 8) return 'mass mentions';
  const links = raw.match(/https?:\/\/\S+|www\.\S+/gi) || [];
  if (links.length >= 4) return 'link spam';
  return null;
}

function check(userId, text, extraWords = []) {
  const t = String(text || '');
  if (!t.trim()) return null;
  const bad = badWord(t, extraWords);
  if (bad) return { reason: 'language', detail: 'inappropriate language' };
  const spam = spamReason(userId, t);
  if (spam) return { reason: 'spam', detail: spam };
  return null;
}

// First offence 10 minutes, then it doubles each time: 10, 20, 40, 80 ... capped at 7 days.
const muteMinutesFor = (offenseNumber) => Math.min(10 * 2 ** Math.max(0, offenseNumber - 1), 7 * 24 * 60);

module.exports = { check, badWord, muteMinutesFor, _history: history };

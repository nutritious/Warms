'use strict';
// Optional permanent storage in an external Postgres database (Neon, Supabase, ...).
// The chat always works from files in DATA_DIR. When DATABASE_URL is set, every save is also copied into the database,
// and on startup the database is copied back into DATA_DIR. That way the data survives hosts that wipe the disk on update.
const fs = require('fs');
const path = require('path');

const URL_ = String(process.env.DATABASE_URL || '').trim();
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const enabled = !!URL_;

let pool = null, ready = false;
let pendingDb = null, dbTimer = null, writing = Promise.resolve();
const pendingFiles = new Map();

async function init() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  if (!enabled) return;
  const { Pool } = require('pg');
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(URL_);
  pool = new Pool({ connectionString: URL_, max: 3, ssl: local ? false : { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
  pool.on('error', (e) => console.error('Database connection problem: ' + e.message));
  await pool.query('CREATE TABLE IF NOT EXISTS warms_state (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT now())');
  await pool.query('CREATE TABLE IF NOT EXISTS warms_files (name TEXT PRIMARY KEY, data BYTEA NOT NULL)');

  const row = (await pool.query("SELECT data FROM warms_state WHERE id = 'db'")).rows[0];
  if (row) { // the database is the truth: copy it down
    fs.writeFileSync(DB_FILE, row.data);
    console.log('Storage: restored your data from the external database');
  } else if (fs.existsSync(DB_FILE)) { // first time: copy what we have up
    await pool.query("INSERT INTO warms_state (id, data) VALUES ('db', $1) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()", [fs.readFileSync(DB_FILE, 'utf8')]);
    console.log('Storage: copied your existing data into the external database');
  }
  const have = new Set((await pool.query('SELECT name FROM warms_files')).rows.map((r) => r.name));
  for (const name of have) {
    if (!/^[a-f0-9]+\.(png|jpg|gif|webp)$/.test(name) || fs.existsSync(path.join(UPLOAD_DIR, name))) continue;
    const f = (await pool.query('SELECT data FROM warms_files WHERE name = $1', [name])).rows[0];
    if (f) fs.writeFileSync(path.join(UPLOAD_DIR, name), f.data);
  }
  for (const name of fs.readdirSync(UPLOAD_DIR)) {
    if (!have.has(name) && /^[a-f0-9]+\.(png|jpg|gif|webp)$/.test(name)) await pool.query('INSERT INTO warms_files (name, data) VALUES ($1, $2) ON CONFLICT DO NOTHING', [name, fs.readFileSync(path.join(UPLOAD_DIR, name))]);
  }
  ready = true;
}

function drain() {
  writing = writing.then(async () => {
    const files = [...pendingFiles.entries()]; pendingFiles.clear();
    const json = pendingDb; pendingDb = null;
    try {
      for (const [name, buf] of files) await pool.query('INSERT INTO warms_files (name, data) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET data = EXCLUDED.data', [name, buf]);
      if (json !== null) await pool.query("INSERT INTO warms_state (id, data) VALUES ('db', $1) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()", [json]);
    } catch (e) { // keep it and try again with the next save
      console.error('Could not save to the external database: ' + e.message);
      if (json !== null && pendingDb === null) pendingDb = json;
      for (const [n, b] of files) if (!pendingFiles.has(n)) pendingFiles.set(n, b);
    }
  });
  return writing;
}

// Called after every save (the JSON text of the whole data file).
function mirrorDb(json) {
  if (!enabled || !ready) return;
  pendingDb = json;
  if (!dbTimer) dbTimer = setTimeout(() => { dbTimer = null; drain(); }, 800);
}
function mirrorFile(name, buf) {
  if (!enabled || !ready) return;
  pendingFiles.set(name, buf);
  if (!dbTimer) dbTimer = setTimeout(() => { dbTimer = null; drain(); }, 800);
}
// Write whatever is waiting right now (used when the site is shutting down).
async function flush() {
  if (!enabled || !ready) return;
  if (dbTimer) { clearTimeout(dbTimer); dbTimer = null; }
  await Promise.race([drain(), new Promise((r) => setTimeout(r, 8000))]);
}

// A picture that is missing from the disk (for example after the host wiped it) can still be fetched from the database.
async function getFile(name) {
  if (!enabled || !pool || !/^[a-f0-9]+\.(png|jpg|gif|webp)$/.test(name)) return null;
  try { const r = await pool.query('SELECT data FROM warms_files WHERE name = $1', [name]); return r.rows[0] ? r.rows[0].data : null; } catch (e) { return null; }
}

module.exports = { init, mirrorDb, mirrorFile, flush, enabled, getFile };

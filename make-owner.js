// Makes one existing account the Owner. Stop the site first (Control + C), then run:
//   node make-owner.js USERNAME
// The previous Owner (if different) becomes an Admin.
const fs = require('fs');
const path = require('path');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const file = path.join(DATA_DIR, 'db.json');
const name = (process.argv[2] || '').trim().toLowerCase();
if (!name) { console.log('Usage: node make-owner.js USERNAME'); process.exit(1); }
if (!fs.existsSync(file)) { console.log('No data found at ' + file + '. Start the site and register first.'); process.exit(1); }
const db = JSON.parse(fs.readFileSync(file, 'utf8'));
const users = Object.values(db.users || {});
const target = users.find((u) => u.username.toLowerCase() === name);
if (!target) { console.log('No account named "' + process.argv[2] + '". Accounts: ' + users.map((u) => u.username).join(', ')); process.exit(1); }
for (const u of users) if (u.roleId === 'owner' && u !== target) u.roleId = 'admin';
target.roleId = 'owner';
fs.writeFileSync(file + '.tmp', JSON.stringify(db));
fs.renameSync(file + '.tmp', file);
console.log(target.username + ' is now the Owner. Start the site again with: node server.js');

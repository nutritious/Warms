'use strict';
// Launcher. If DATABASE_URL is set, the saved data is restored from that database first, then the chat starts.
const store = require('./store');
store.init().then(() => require('./server-main')).catch((e) => {
  console.error('Could not start: ' + (e && e.message));
  process.exit(1);
});

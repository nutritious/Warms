'use strict';
// The Update Log. Everyone can read it, only the Owner can edit it in the app.
// RULE: every update to Warms adds a new entry at the BOTTOM of this list (newest last), with the next "v" number.
// New entries appear in the app automatically after the update is deployed.
module.exports = [
  { id: 'v1', date: '2026-10-11', title: 'Warms is born', notes: [
    'Accounts, sign-in and a first chat server for you and your friends',
    'Channels, replies, reactions, image uploads, editing and deleting your own messages',
    'Roles with permissions, plus a member list with online status',
  ] },
  { id: 'v2', date: '2026-10-11', title: 'Command Center and announcements', notes: [
    'Admin Command Center with live stats, charts and a console',
    'Global announcements with an entrance animation that everyone sees',
  ] },
  { id: 'v3', date: '2026-10-11', title: 'Owner, Admins and staff tools', notes: [
    'New Owner and Admin roles, with coloured tags beside names (gold for the Owner)',
    'Owner Panel: manage admins, sign-ups, welcome message, security and ownership handover',
    'Staff panel for moderators and managers',
    'Sign-in and join notices',
  ] },
  { id: 'v4', date: '2026-10-11', title: 'Voice channels', notes: [
    'Talk to friends in Lounge and Hangout voice rooms',
    'Clearer Mute, Deafen and Leave buttons',
  ] },
  { id: 'v5', date: '2026-10-11', title: 'A sleeker look', notes: [
    'The site is now called Warms, with a warm orange glass-and-glow design',
    'Floating panels and smoother animations',
  ] },
  { id: 'v6', date: '2026-10-11', title: 'Spaces and the Announcements chat', notes: [
    'Spaces on the far-left bar, each with its own chats. Owner and Admins can create them and change their pictures',
    'A separate Announcements chat that only the Owner can post in, with its own icon',
  ] },
  { id: 'v7', date: '2026-10-11', title: 'Report a problem', notes: [
    'A new button lets anyone report an issue straight to the Owner',
  ] },
  { id: 'v8', date: '2026-10-11', title: 'Coins, the Daily Wheel and tags', notes: [
    'Spin the Daily Wheel once every 24 hours for free coins',
    'Spend coins to unlock profile tags and wear one next to your name',
    'The first tags were Halloween themed',
  ] },
  { id: 'v9', date: '2026-10-11', title: 'Backups, Warmaster and Give coins', notes: [
    'Owner Panel can download and restore a backup, and warns if your data is on temporary storage',
    'Signing up as Warmaster makes you the Owner',
    'Owner can give coins to anyone',
  ] },
  { id: 'v10', date: '2026-10-11', title: 'Shop, packs, friends and AutoMod', notes: [
    'The coin button is now the Shop: Daily Wheel, Tag Packs and My Tags',
    'Four tag packs (Halloween, Dog, Space, Ocean) and a new rainbow rarity, Croma, at 0.1%',
    'Owner events for everyone: Lucky Hour, Double Coins, Pack Sale, Coin Rain, Free Spin',
    'Friends and direct messages. Add friends from their profile',
    'AutoMod filters cuss words and spam. Mutes start at 10 minutes and double each time. Admins can unmute',
  ] },
  { id: 'v11', date: '2026-10-11', title: 'Staff can give tags', notes: [
    'Owner and Admins can give or take back any tag, or a whole pack, from the Command Center or a profile card',
  ] },
  { id: 'v12', date: '2026-10-11', title: 'Update Log', notes: [
    'This page! Every update is written here for everyone to read',
    'Only the Owner can add, edit or delete entries',
    'Safer updates: the site now saves everything just before it restarts',
  ] },
  { id: 'v13', date: '2026-10-11', title: 'Updates no longer erase everything', notes: [
    'Warms can now keep all its data (accounts, chats, coins, tags, pictures) in a free external database, so updates do not sign anyone out or wipe anything',
    'The Owner Panel shows where your data is saved',
  ] },
  { id: 'v14', date: '2026-10-11', title: 'Better messages and screen sharing', notes: [
    'Messages now open as a full screen next to the left bar (press the 💬 button, or Esc to close). On phones there is a 💬 button at the top',
    'See who you talked to last, a preview of the last message, unread counts, and search your friends',
    'Send pictures in messages, delete your own messages, and see when a friend is typing',
    'A 💬 button appears next to your friends in the member list for one-click chatting. Press Enter to send, Shift+Enter for a new line',
    'Owner Panel: see how many coins every member has',
    'Screen sharing in voice channels: press Share in the voice bar. One person can share per channel, and everyone in the call can watch, go full screen or close it',
  ] },
];

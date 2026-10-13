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
  { id: 'v15', date: '2026-10-12', title: 'Big update: staff tools, rules and fun', notes: [
    'New members must agree to the Server Rules when they sign up. Everyone can read them any time ("Server rules" under the user panel)',
    'New role: Community Manager, above Manager and below Admin, with its own Community Panel (announcements, reports and a look at who is new or muted)',
    'Staff Hub: a private space with a staff chat and a staff voice room for Owner, Admins, Community Managers and Managers',
    'Troll Panel: the Owner can give it to people. Jump scares, lights out, spiders, creepy eyes, a fake crash and more, with sounds. Press Esc to stop one, or turn pranks off in Appearance',
    'Owner Panel: a Surprise event button, and a Minigame (Number Rush). Finish under the time limit to win coins or a tag',
    'The Owner can choose which roles can open a new space, or change it later in Settings > Server',
    'Announcements now only pop up in #general',
    'Five new events: Spin Rush, Duplicate Bonus, Trick or Treat, Free Pack For All and Jackpot Draw',
    'Four new tag packs: Food, Fantasy, Music and Robot',
    'Private calls: press 📞 next to a friend in Messages to call them. They get a ringing pop-up with Answer and Decline. You can share your screen in the call too',
    'Redeem codes: the Owner makes codes (coins, a tag, or both) in the Owner Panel. Type one in the Shop > Codes tab to get the reward, with a celebration animation',
    'The jump scare is a lot scarier now',
    'Halloween! The lobby is decorated, and the Halloween pack is limited: both leave on November 1st (tags you already won are kept)',
  ] },
  { id: 'v16', date: '2026-10-12', title: 'Arcade, bouncy look and more pranks', notes: [
    'New 🕹️ Arcade button on the far-left bar with six games: Whack-a-Mole, Memory Match and Reaction Test earn coins (up to 300 a day), and Coin Flip, Lucky Dice and Slots let you bet your coins',
    'A bouncier, more fun look: springy buttons, messages that pop in, emoji bursts when you react, confetti when you send a 🎉, and a smooth coin counter',
    'Soft sounds for clicks, sent and received messages and coins. Turn sounds or the bouncy motion off in Settings > Appearance',
    'Three new colorful themes: Candy, Mint and Galaxy',
    'Troll Panel: 8 new pranks (peeking figure, flickering lights, possessed screen, whispers, fake ban, fake update, fake delete-everything and fake virus pop-ups) plus 💀 CHAOS, which sends four random pranks in a row. Trolling Everyone has a short cooldown for people with the Troll Panel (the Owner has none)',
    'Admins now have their own Admin Panel (🛠️) next to the ⚡ Command Center: find members and change their role, mute or remove them, handle reports, edit AutoMod words, post announcements and see recent staff actions',
    'Better panels: the Troll Panel is sorted into Scary, Fake system screens and Shake it up, and the Owner, Community and Troll panels are roomier, with a close button that stays put and quick-jump chips to hop between sections',
  ] },
  { id: 'v17', date: '2026-10-12', title: 'Polls and more casino games', notes: [
    'Polls: the Owner can start a poll (Owner Panel > Polls) and everyone votes from the new 📊 button. A dot shows until you vote, you can change your vote while it is open, and results show as live bars',
    'Three new coin games in the Arcade: Blackjack (blackjack pays 3 to 2, double down), Roulette (colors, odd or even, dozens or a single number) and Higher or Lower (keep guessing to build a streak, cash out any time)',
    'Bet as much as you want: every coin game now lets you bet any amount up to what you have, with quick buttons for Half and All in',
  ] },
];

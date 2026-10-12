# Warms: private Discord-style chat

Accounts, roles, text channels, image sharing, live messages, typing indicators and an online member list grouped by role.

## Run it

```
npm install
npm start
```

Open http://localhost:3000 and **register with the username `Warmaster`**: that account becomes the **Owner**.
Everyone after that starts as **Member**.

Needs Node 18 or newer.

## Roles

Whoever registers the username `Warmaster` is the Owner (nobody else gets it automatically). If you already have test accounts and want a different one to be Owner, stop the site and run `node make-owner.js USERNAME` (or delete the `data` folder to start over).


- Defaults: Owner, Admin, Manager, Moderator, Member. Owner and Admin have every permission; those roles can't be deleted or have their permissions edited.
- Owner, Admin (or anyone with *Manage roles*) opens **Settings > Roles** to create roles, pick a colour, tick permissions, and reorder them (higher = more rank).
- To give someone a role: click their name in the member list and pick a role from the dropdown.
- Permissions: Manage roles, Manage channels (also renames the server), Remove members, Delete messages.
- Rank rules, enforced on the server: you can only edit, assign or remove roles/people ranked **below** you, and you can't hand out permissions you don't have. **Only the Owner can make someone an Admin.** The Owner's role can't be changed or removed by anyone; it can only be handed over with *Transfer ownership* (password required).

## What's in it

- **Chat:** live messages, image sharing (button or paste), emoji reactions, replies, editing your own messages, @mentions, unread badges, typing indicators.
- **Slash commands for everyone:** `/roll [sides]`, `/flip`, `/8ball question`, `/shrug`.
- **Profiles:** profile picture and a status line that shows in the member list.
- **Themes:** Midnight, Neon, Forest, Ember, Ocean plus a custom accent color. Saved per person, on their device (Settings > Appearance).
- **Accounts and roles:** the account named Warmaster is the Owner; Owner and Admins build roles and hand them out. Everyone with a non-Member role gets a coloured tag beside their name; the Owner's tag is gold.
- **Sign-in notices:** when a brand-new person joins, everyone gets a welcome banner and a join message in the first channel (the text is editable, `{name}` is replaced). When a returning member comes online, others see a small "signed in" toast.
- **Spaces (the round icons on the far-left bar):** each space is like its own server section with its own chats, voice rooms and message history, while everyone shares the same accounts and roles. The Owner and Admins click **＋** to create one and can rename or delete it in Settings > Space. The Owner and Admins can also upload a picture for each space (and for Announcements) in Settings > Space; it replaces the letters on the far-left bar. The first space can't be deleted. Anyone with *Manage channels* can add chats inside a space with **New chat**.
- **Announcements (the megaphone icon at the top of the far-left bar):** one shared chat for the whole server. Only the Owner can post there; everyone can read and react. It can't be deleted. Existing sites get it added automatically.
- **Voice channels (Lounge and Hangout in every space):** click one to join and talk. Mute, deafen and leave buttons appear above your name; a green ring shows who is speaking; up to 8 people per channel. Audio goes directly between browsers (WebRTC), so it needs **https** (Render provides it) and microphone permission. Most home networks work; a few strict networks (some school/work/mobile) block direct audio, which would need a TURN relay server to fix.
- **Report a problem:** a "Report a problem" link in the sidebar (and in Settings) lets anyone send a message to the Owner. Reports always show up in the Owner Panel (mark done / delete). To **also get them by email** at artem.yegorov@icloud.com, set these environment variables on your host (on Render the names are already in `render.yaml`; fill in the two secret ones in the dashboard): `SMTP_USER` = your iCloud email address, `SMTP_PASS` = an **app-specific password** (create one at appleid.apple.com > Sign-In and Security > App-Specific Passwords; your normal Apple password will not work). Without these, reports are only in the Owner Panel. When the site starts it prints `Email reports: ON` or `OFF` or `login FAILED`, and the Owner Panel has a **Send a test email** button that shows the exact reason if sending fails. If your Apple ID is not an @icloud.com address, also set `SMTP_FROM` to your iCloud address.
- **Owner Panel (Owner only, the crown button):** make/remove Admins, close or open sign-ups, edit the welcome message, sign everyone else out, transfer ownership, wipe all messages (type the server name to confirm), recent activity.
- **Staff panel (anyone whose role has staff permissions, the shield button):** a panel that shows only the tools their role allows.
  - *Delete messages*: a feed of recent messages across channels with channel filter, search and one-click delete.
  - *Remove members*: member list with **mute** (5 min, 15 min, 1 hour, 24 hours), unmute and remove. Muted people can still read and react but can't post or edit.
  - *Manage roles*: a role dropdown on each member.
  - *Manage channels*: create and delete channels, rename the server.
  - Everyone on staff also sees a "Your powers" card and a staff log of recent moderation actions. People can only act on those ranked below them. Roles with no permissions get no panel.
- **Command Center (Owner and Admins, the lightning-bolt button):** live dashboard with member/online/message counts, a 24-hour activity chart, roles breakdown, busiest channels, top posters, who's online, an audit log of admin actions, a global-message composer and a command console.
- **Entrance animation** when you sign in (click to skip; off automatically for people who prefer reduced motion).

### Console commands

| Command | What it does |
| --- | --- |
| `announce <text>` | Posts in every channel and shows a banner to everyone online |
| `stats`, `who`, `users`, `channels` | Quick overviews |
| `role <user> <role>` | Change someone's role |
| `kick <user>` | Remove a member |
| `purge <channel> [count]` | Delete recent (or all) messages in a channel |
| `rename <name>` | Rename the server |

Use "quotes" around names with spaces. Only the Owner and Admin roles can use the Command Center, and the server checks that on every request.

## Letting friends in

`localhost` only works on your own computer. Options:

1. **Quick, from your own computer:** run the app, then expose it with a tunnel such as Cloudflare Tunnel (`cloudflared tunnel --url http://localhost:3000`) or ngrok. You get an `https://` link to send your friends. It works only while your computer and the app are running.
2. **Always on:** deploy to a host that runs Node (Render, Railway, Fly.io, a VPS). Attach a **persistent disk/volume** and set `DATA_DIR` to it, otherwise accounts and messages are lost on redeploy.

Use an **https** link: passwords are sent when people log in, and plain http would expose them on the network.

## Deploy as a website (step by step, Render)

1. Create a free GitHub account and a new **private** repository, then upload these files (drag and drop works on github.com; skip `node_modules` and `data`).
2. Create an account at render.com, choose **New > Blueprint**, and select the repository. `render.yaml` sets everything up, including the storage disk.
3. When it finishes you get an `https://...onrender.com` address. Open it, **register first** (you become Owner), then send the link to your friends.

The disk is what keeps your accounts and messages. Hosts generally charge a small monthly fee for persistent disks; check current pricing before you pick a plan. A `Dockerfile` is included for Fly.io, Railway or any VPS: mount a volume at `/data`.

Register your own account right after it goes live. Until someone registers, anyone who finds the link would become Owner.

## Where data lives

`data/db.json` (accounts, roles, channels, messages) and `data/uploads/` (images). Back those up. Passwords are stored as salted scrypt hashes. Delete `data/` to reset everything; the next registration becomes Owner again.

Settings: `PORT` (default 3000) and `DATA_DIR` (default `./data`).

## Not included

Video and screen sharing, direct messages, and password reset (an Owner or Admin can remove a user and they can re-register).

## Coins, Daily Wheel and Tag Machine

Everyone gets a free spin of the Daily Wheel every 24 hours (click the 🪙 coin chip by your name). Coins are play money only. Spend 100 coins in the Halloween cauldron (Tag Machine) for a random profile tag, then wear one from "My Tags" and it shows next to your name.

Tag odds per roll: Common 60%, Uncommon 25%, Rare 10%, Epic 4%, Legendary 1%. A duplicate gives some coins back. Owner and Admins can use the console command `givecoins <user> <amount>`. Odds and tags live at the top of the "coins, wheel, tags" section in `server-main.js`.

The Owner Panel has a **Give coins** box (pick a member, type an amount; a minus number takes coins away). The console command `givecoins <user> <amount>` still works too.

## Keeping your data when you update

Accounts, chats and coins live in `db.json` inside the data folder. On Render that folder must be on a **disk** (render.yaml asks for one, and disks need a paid plan). Without a disk, every update wipes the site. The Owner Panel shows "permanent disk" or a warning, and the startup log prints `Storage: permanent` or `Storage: TEMPORARY`. As an extra safety net use **Owner Panel -> Save & restore -> Download backup** before updating and **Restore from backup** afterwards. Uploaded pictures are not in the backup.

## Shop, packs and events

The coin chip is now the **Shop** button. It has the Daily Wheel, **Tag Packs** (Halloween, Dog, Space and Ocean, 15 tags each) and **My Tags**. Rarities per pack: Common 59.9%, Uncommon 25%, Rare 10%, Epic 4%, Legendary 1%, **Croma 0.1%** (animated rainbow). Packs, tags and odds are defined at the top of the "coins, wheel, tags" section in `server-main.js`; adding a pack means adding one block of 15 tags.

The Owner Panel has an **Events** section: Lucky Hour (rare chances x2 to x10), Double Coins (wheel), Pack Sale, Coin Rain (coins for everyone) and Free Spin For All. Everyone gets a banner and a post in #announcements.

## Friends and messages

Press the 💬 button on the far-left bar (or a person's name -> Add friend). Once a request is accepted you can send each other direct messages.

## AutoMod

A filter bot blocks cuss words and spam (flooding, repeating the same message, link spam, mass mentions) in channels, edits and DMs. The first offence is a **10 minute mute**, then it doubles (20, 40, 80...). Strikes fade after a week. The Owner and Admins are not filtered unless the Owner turns on "Also filter Owner and Admins" (handy for testing). Owner and Admins lift mutes from the Staff panel or the console (`unmute <user>`); the Owner can also do it, and add extra banned words, in the Owner Panel's AutoMod section.

## Giving tags (Owner and Admins)

Open the **Command Center** (the ⚡ button) and use the **Give tags & coins** panel, or open anyone's profile card (click their name or picture) and use **Tags (staff)**: pick one tag, or a whole pack, then **Give** or **Take back**. The console command `givetag <user> <tag name>` does the same for one tag.

## Update Log

The 📜 button on the far-left bar opens the Update Log: everyone can read it, only the Owner can add, edit or delete entries. Entries that ship with the code live in `changelog.js`. **Every update adds a new entry at the bottom of that file** (see CLAUDE.md); it shows up in the app after the update is deployed. The Owner can also type entries directly in the app.

## Keeping your data without a paid disk (external database)

If your host erases its disk on every update, set one environment variable, `DATABASE_URL`, to the connection string of a free Postgres database (for example from neon.tech). Warms then copies every save (accounts, chats, coins, tags, pictures) into that database and restores it on start. The Owner Panel's Save & restore section shows "saved in an external database". If the database can't be reached the site refuses to start rather than starting empty. `server.js` is only a small launcher; the chat itself is `server-main.js`.

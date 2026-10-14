'use strict';
/* Warms Live Show: the rules of the show, with no server or browser code in here.
   The server and the preview both use this same file. A show is a timeline of steps (trivia, reaction, math, prize drops, hype, dance breaks)
   that the server times, so nobody can change the clock in their browser. */

const TRIVIA = [ // [question, right answer, three wrong answers]
  ['Which game made "Victory Royale" a household phrase?', 'Fortnite', 'PUBG', 'Apex Legends', 'Call of Duty: Warzone'],
  ['What do you build to enter the Nether in Minecraft?', 'An Obsidian portal', 'A Bedrock gate', 'A Diamond arch', 'A Netherrack tower'],
  ['Which company makes the PlayStation?', 'Sony', 'Microsoft', 'Nintendo', 'Sega'],
  ['In what year did the first iPhone come out?', '2007', '2005', '2009', '2010'],
  ['Which app introduced "Stories" first?', 'Snapchat', 'Instagram', 'Facebook', 'TikTok'],
  ['What does GOAT stand for?', 'Greatest Of All Time', 'Good On All Terrain', 'Gold Over All Teams', 'Great Online Anime Title'],
  ['Which artist released the album "Astroworld"?', 'Travis Scott', 'Drake', 'Kendrick Lamar', 'Kanye West'],
  ['Which Marvel villain snaps away half of all life?', 'Thanos', 'Loki', 'Ultron', 'Killmonger'],
  ['Which country won the 2022 FIFA World Cup?', 'Argentina', 'France', 'Brazil', 'Croatia'],
  ['What is the chemical symbol for gold?', 'Au', 'Ag', 'Gd', 'Go'],
  ['What does HTTP stand for?', 'HyperText Transfer Protocol', 'High Tech Transfer Program', 'Hyper Terminal Tracking Protocol', 'Home Tool Transfer Process'],
  ['In gaming chat, what does AFK mean?', 'Away From Keyboard', 'Always For Kicks', 'Ahead of the Kill', 'Another Fast Kill'],
  ['Which Pokémon is number 25 in the Pokédex?', 'Pikachu', 'Charmander', 'Eevee', 'Jigglypuff'],
  ['In Among Us, what are the bad guys called?', 'Impostors', 'Killers', 'Traitors', 'Infected'],
  ['What is the capital of Japan?', 'Tokyo', 'Kyoto', 'Osaka', 'Seoul'],
  ['How many bones does an adult human have?', '206', '212', '198', '250'],
  ['Which Nintendo console launched in 2017?', 'Switch', 'Wii U', 'GameCube', '3DS'],
  ['Which singer is nicknamed "Queen Bey"?', 'Beyoncé', 'Rihanna', 'Adele', 'Taylor Swift'],
  ['Which anime follows the Straw Hat Pirates?', 'One Piece', 'Naruto', 'Bleach', 'Dragon Ball'],
  ['Which NBA star is nicknamed "King James"?', 'LeBron James', 'Kobe Bryant', 'Stephen Curry', 'Kevin Durant'],
  ['Roughly how fast does light travel?', '300,000 km per second', '30,000 km per second', '3,000,000 km per second', '150,000 km per second'],
  ['What is 2 to the power of 10?', '1024', '512', '2048', '1000'],
  ['In what year did Fortnite first release?', '2017', '2015', '2019', '2013'],
  ['Which person founded both Tesla and SpaceX?', 'Elon Musk', 'Jeff Bezos', 'Mark Zuckerberg', 'Bill Gates'],
  ['Who painted the Mona Lisa?', 'Leonardo da Vinci', 'Michelangelo', 'Raphael', 'Van Gogh'],
  ['Which programming language is named after a snake?', 'Python', 'Ruby', 'Cobra', 'Java'],
  ['Which band recorded "Bohemian Rhapsody"?', 'Queen', 'The Beatles', 'Led Zeppelin', 'Nirvana'],
  ['How many Infinity Stones are there in the Marvel movies?', '6', '5', '7', '8'],
  ['Which team did Stephen Curry spend his career with?', 'Golden State Warriors', 'Lakers', 'Celtics', 'Bulls'],
  ['Which language has the most native speakers?', 'Mandarin Chinese', 'English', 'Spanish', 'Hindi'],
  ['In which series do you play as Link?', 'The Legend of Zelda', 'Mario', 'Metroid', 'Kirby'],
  ['In what year did the Titanic sink?', '1912', '1905', '1920', '1898'],
  ['In gaming, what does NPC stand for?', 'Non-Player Character', 'New Player Challenge', 'Next Power Charge', 'Normal Pixel Character'],
  ['Which rapper\'s real name is Marshall Mathers?', 'Eminem', 'Jay-Z', '50 Cent', 'Snoop Dogg'],
  ['What does FOMO stand for?', 'Fear Of Missing Out', 'Fun Online Mobile Option', 'First On My Own', 'Free Offer Mega Online'],
  ['Which studio made Valorant?', 'Riot Games', 'Valve', 'Epic Games', 'Blizzard'],
  ['In chess, which piece moves only diagonally?', 'Bishop', 'Rook', 'Knight', 'Queen'],
  ['What is the capital of Australia?', 'Canberra', 'Sydney', 'Melbourne', 'Perth'],
  ['What is the square root of 144?', '12', '14', '11', '13'],
  ['Which element has the symbol Fe?', 'Iron', 'Fluorine', 'Lead', 'Francium'],
  ['Which console was the home of the original Halo?', 'Xbox', 'PlayStation', 'Wii', 'Dreamcast'],
  ['Which Kendrick Lamar album came out in 2015?', 'To Pimp a Butterfly', 'DAMN.', 'good kid, m.A.A.d city', 'Mr. Morale & the Big Steppers'],
  ['Which club did Lionel Messi join in 2023?', 'Inter Miami', 'PSG', 'Barcelona', 'Al-Nassr'],
  ['Which show features the Demogorgon?', 'Stranger Things', 'Wednesday', 'Squid Game', 'Dark'],
  ['What is the first game in Squid Game?', 'Red Light, Green Light', 'Tug of war', 'Marbles', 'Glass bridge'],
  ['What is the largest planet in our solar system?', 'Jupiter', 'Saturn', 'Neptune', 'Uranus'],
  ['How many players from one team are on the court in basketball?', '5', '6', '7', '4'],
  ['Which Zelda, Mario and Smash studio is based in Kyoto?', 'Nintendo', 'Capcom', 'Square Enix', 'Konami'],
  ['What is the most-streamed type of content on Twitch, by hours watched?', 'Just Chatting', 'Speedruns', 'Cooking', 'Sports'],
  ['Which planet has the Great Red Spot?', 'Jupiter', 'Mars', 'Saturn', 'Venus'],
  ['Which of these is a real Discord feature?', 'Server boosts', 'Time travel mode', 'Hologram calls', 'Auto-homework'],
];

const GAME_TRIVIA = [
  ['Which company created Minecraft?', 'Mojang', 'Epic Games', 'Valve', 'Roblox Corp.'],
  ['What is the in-game currency in Fortnite?', 'V-Bucks', 'Robux', 'Gems', 'Coins'],
  ['What is the in-game currency in Roblox?', 'Robux', 'V-Bucks', 'Gold', 'Tokens'],
  ['Which game series features the Triforce?', 'The Legend of Zelda', 'Mario', 'Pokémon', 'Kirby'],
  ['Which mob explodes next to you in Minecraft?', 'Creeper', 'Zombie', 'Skeleton', 'Enderman'],
  ['What color is Sonic the Hedgehog?', 'Blue', 'Red', 'Yellow', 'Green'],
  ['Who is Mario\'s brother?', 'Luigi', 'Wario', 'Toad', 'Yoshi'],
  ['In Among Us, what do you press after finding a dead crewmate?', 'Report', 'Vent', 'Sabotage', 'Use'],
  ['Which game has Terrorists versus Counter-Terrorists?', 'Counter-Strike', 'Call of Duty', 'Halo', 'Overwatch'],
  ['In League of Legends, what must you destroy to win?', 'The enemy Nexus', 'The enemy Flag', 'The enemy Core Reactor', 'The Dragon'],
  ['What does GG mean after a match?', 'Good game', 'Get gone', 'Great goal', 'Game gone'],
  ['In gaming, what does FPS usually mean when talking about performance?', 'Frames per second', 'Fast play speed', 'First player spawn', 'Fire power system'],
  ['What does RNG stand for in gaming?', 'Random Number Generator', 'Real Nice Game', 'Rapid Network Gain', 'Ranked Next Gen'],
  ['What does DLC stand for?', 'Downloadable Content', 'Digital Level Code', 'Direct Load Client', 'Dual Link Controller'],
  ['What does MMO stand for?', 'Massively Multiplayer Online', 'Most Missions Open', 'Multi Mode Offline', 'Mega Map Order'],
  ['What does XP stand for in games?', 'Experience Points', 'Extra Power', 'Xtreme Play', 'Xenon Pack'],
  ['Which game has the line "It\'s dangerous to go alone! Take this."?', 'The Legend of Zelda', 'Final Fantasy', 'Metroid', 'Castlevania'],
  ['Who is the main character of the Halo series?', 'Master Chief', 'Marcus Fenix', 'Gordon Freeman', 'Doomguy'],
  ['Who is the main character of God of War?', 'Kratos', 'Atreus', 'Zeus', 'Ares'],
  ['Which game stars the monster hunter Geralt of Rivia?', 'The Witcher 3', 'Skyrim', 'Dark Souls', 'Dragon Age'],
  ['Which studio made Elden Ring?', 'FromSoftware', 'Bethesda', 'CD Projekt', 'Ubisoft'],
  ['What are the falling pieces in Tetris called?', 'Tetrominoes', 'Polyblocks', 'Quadrats', 'Bricks'],
  ['What does Pac-Man eat?', 'Dots', 'Fruit only', 'Coins', 'Stars'],
  ['Which console uses Joy-Con controllers?', 'Nintendo Switch', 'PlayStation 5', 'Xbox Series X', 'Steam Deck'],
  ['What is the name of Valve\'s PC game store?', 'Steam', 'Origin', 'Battle.net', 'Epic Store'],
  ['Which company makes the Xbox?', 'Microsoft', 'Sony', 'Nintendo', 'Sega'],
  ['What is a speedrun?', 'Finishing a game as fast as possible', 'A race game', 'A cheat code', 'A game with only running'],
  ['In online games, what does high lag mean?', 'A big delay between your action and the server', 'Very high graphics', 'A free item drop', 'Better aim'],
  ['In gaming slang, what is a "noob"?', 'A new or inexperienced player', 'A pro player', 'A cheater', 'A game developer'],
  ['Which game series features Vault Boy?', 'Fallout', 'BioShock', 'Borderlands', 'Doom'],
  ['What do you need to defeat to beat the Minecraft main storyline?', 'The Ender Dragon', 'The Wither', 'The Warden', 'The Elder Guardian'],
  ['Which Nintendo character is often kidnapped by Bowser?', 'Princess Peach', 'Zelda', 'Samus', 'Daisy'],
  ['In Counter-Strike, what explosive do terrorists plant?', 'The bomb (C4)', 'A grenade', 'A mine', 'Dynamite'],
  ['Which hero shooter features Tracer and Mercy?', 'Overwatch', 'Valorant', 'Apex Legends', 'Paladins'],
  ['Which engine is Fortnite built on?', 'Unreal Engine', 'Unity', 'Source', 'Godot'],
  ['Which item in Mario Kart hits the player in first place?', 'Blue shell', 'Banana', 'Mushroom', 'Star'],
  ['In which fictional city does GTA V take place?', 'Los Santos', 'Vice City', 'Liberty City', 'San Fierro'],
  ['Which Pokémon evolves into Pikachu?', 'Pichu', 'Raichu', 'Pidgey', 'Plusle'],
  ['What type is Charmander in Pokémon?', 'Fire', 'Water', 'Grass', 'Dragon'],
  ['In Fortnite, what do players drop from at the start of a match?', 'The Battle Bus', 'A helicopter', 'A plane called Air Drop', 'A hot air balloon'],
  ['What does "AFK" mean in a game lobby?', 'Away from keyboard', 'All for kills', 'Armor from kit', 'Attack first, kill'],
  ['Which game is basically soccer played with rocket-powered cars?', 'Rocket League', 'Forza', 'Need for Speed', 'Gran Turismo'],
  ['What do you call the area where players respawn after dying in many shooters?', 'Spawn point', 'Safe house', 'Checkpoint hub', 'Lobby tree'],
  ['What is the max level of a "prestige" system used for in many shooters?', 'Resetting your rank for a badge', 'Buying skins with real money', 'Unlocking cheats', 'Joining a clan'],
];
const PROXY_TRIVIA = [
  ['What does a proxy server do?', 'Sits between you and the internet and forwards your requests', 'Speeds up your Wi-Fi hardware', 'Stores your passwords', 'Turns your PC into a router'],
  ['What does VPN stand for?', 'Virtual Private Network', 'Very Protected Node', 'Verified Proxy Number', 'Variable Port Network'],
  ['What does IP stand for in "IP address"?', 'Internet Protocol', 'Instant Port', 'Internal Proxy', 'Input Packet'],
  ['What does DNS do?', 'Turns domain names into IP addresses', 'Encrypts your files', 'Blocks ads', 'Speeds up downloads'],
  ['Which port does HTTPS normally use?', '443', '80', '21', '22'],
  ['Which port does plain HTTP normally use?', '80', '443', '25', '3389'],
  ['What is the IP address of "localhost"?', '127.0.0.1', '192.168.0.1', '8.8.8.8', '0.0.0.255'],
  ['When you browse through a proxy, what does the website usually see?', 'The proxy\'s IP address', 'Your real IP address', 'Your password', 'Nothing at all'],
  ['What is a web filter at school or work?', 'Software that blocks certain websites', 'A browser extension for videos', 'A type of antivirus scan', 'A router brand'],
  ['What does the S in HTTPS stand for?', 'Secure', 'Speed', 'Server', 'Social'],
  ['What is a firewall?', 'A barrier that controls network traffic', 'A game cheat', 'A cooling fan', 'A backup drive'],
  ['What does "ping" measure?', 'How long data takes to reach a server and come back', 'Your download size', 'Your screen brightness', 'Your password strength'],
  ['What does ISP stand for?', 'Internet Service Provider', 'Internal Server Port', 'Internet Safe Protocol', 'Instant Site Proxy'],
  ['What do CAPTCHAs try to tell apart?', 'Humans from bots', 'Kids from adults', 'Mac from PC', 'Fast from slow Wi-Fi'],
  ['What does a reverse proxy usually sit in front of?', 'Web servers', 'Game controllers', 'Printers', 'Webcams'],
  ['SOCKS5 is a type of what?', 'Proxy protocol', 'Graphics card', 'Game engine', 'Video format'],
  ['What does the "TOR" in Tor Browser stand for?', 'The Onion Router', 'The Open Router', 'Total Online Relay', 'Trusted Origin Route'],
  ['What does URL stand for?', 'Uniform Resource Locator', 'Universal Router Link', 'User Request Line', 'Unified Remote Login'],
  ['What is a mirror site?', 'A copy of a website at another address', 'A site that flips text', 'A site with only photos', 'A banned account'],
  ['Why do some networks block proxy sites?', 'To stop people bypassing the web filter', 'Because they use too much electricity', 'Because they only show ads', 'Because they are made of video'],
];
const HORROR_GAMES = [
  ['Which co-op horror game has you hunting ghosts with an EMF reader and spirit box?', 'Phasmophobia', 'Lethal Company', 'Resident Evil', 'Outlast'],
  ['In Dead by Daylight, what role is hunted by the killer?', 'Survivor', 'Hunter', 'Detective', 'Witness'],
  ['In Outlast, what is the main character\'s job?', 'Journalist', 'Police officer', 'Doctor', 'Soldier'],
  ['Which horror game stars a space engineer fighting Necromorphs?', 'Dead Space', 'Alien: Isolation', 'Doom', 'Bioshock'],
  ['Which horror game has you survive five nights?', 'Five Nights at Freddy\'s', 'Slender', 'Amnesia', 'Little Nightmares'],
  ['Which horror game series features Leon S. Kennedy?', 'Resident Evil', 'Silent Hill', 'Dying Light', 'Left 4 Dead'],
];

const HALLOWEEN_TRIVIA = [
  ['Which killer stalks Haddonfield in the 1978 film "Halloween"?', 'Michael Myers', 'Jason Voorhees', 'Freddy Krueger', 'Ghostface'],
  ['Which horror villain wears a hockey mask?', 'Jason Voorhees', 'Michael Myers', 'Leatherface', 'Pinhead'],
  ['Which franchise features Freddy Krueger?', 'A Nightmare on Elm Street', 'Friday the 13th', 'Saw', 'Scream'],
  ['Ghostface is the killer in which series?', 'Scream', 'Saw', 'Final Destination', 'Hostel'],
  ['What is the clown in Stephen King\'s "It" called?', 'Pennywise', 'Twisty', 'Art', 'Captain Spaulding'],
  ['Which game features the animatronic Freddy Fazbear?', 'Five Nights at Freddy\'s', 'Poppy Playtime', 'Bendy and the Ink Machine', 'Granny'],
  ['In Resident Evil, which company created the T-virus?', 'Umbrella Corporation', 'Aperture Science', 'Weyland-Yutani', 'Shinra'],
  ['Who wrote the novel "Dracula"?', 'Bram Stoker', 'Mary Shelley', 'Edgar Allan Poe', 'H. P. Lovecraft'],
  ['Who wrote "Frankenstein"?', 'Mary Shelley', 'Bram Stoker', 'Stephen King', 'Shirley Jackson'],
  ['What is the shadowy parallel world in Stranger Things called?', 'The Upside Down', 'The Void', 'The Rift', 'The Hollow'],
  ['Which movie has the line "Here\'s Johnny!"?', 'The Shining', 'Psycho', 'The Exorcist', 'Carrie'],
  ['Which creepy doll stars in a Conjuring spin-off?', 'Annabelle', 'Chucky', 'Robert', 'Billy'],
  ['What is the possessed doll in Child\'s Play called?', 'Chucky', 'Annabelle', 'Brahms', 'Slappy'],
  ['What is the fear of clowns called?', 'Coulrophobia', 'Arachnophobia', 'Claustrophobia', 'Xenophobia'],
  ['Which creature is traditionally weak to silver?', 'Werewolf', 'Zombie', 'Ghost', 'Mummy'],
  ['Which US state were the Salem witch trials in?', 'Massachusetts', 'Maine', 'Virginia', 'Connecticut'],
  ['What style of filming is "The Blair Witch Project"?', 'Found footage', 'Animation', 'Black and white silent', 'Stop motion'],
  ['Which horror game series features Pyramid Head?', 'Silent Hill', 'Resident Evil', 'Dead Space', 'Outlast'],
  ['In "The Exorcist", what is the possessed girl called?', 'Regan', 'Carrie', 'Samara', 'Damien'],
  ['Which horror film features the ghost girl Samara?', 'The Ring', 'The Grudge', 'Insidious', 'Sinister'],
  ['Who wrote "Carrie" and "The Shining"?', 'Stephen King', 'Dean Koontz', 'Anne Rice', 'Clive Barker'],
  ['"Halloween" is short for All Hallows\'...?', 'Eve', 'Day', 'Night', 'Moon'],
  ['Which villain traps victims in games in the Saw movies?', 'Jigsaw', 'Pinhead', 'The Collector', 'Candyman'],
  ['Which game has you survive with Joel and Ellie?', 'The Last of Us', 'Left 4 Dead', 'Days Gone', 'Dying Light'],
  ['Which country does the jack-o\'-lantern tradition come from?', 'Ireland', 'Mexico', 'Japan', 'Germany'],
  ['Which holiday on Nov 1-2 features sugar skulls?', 'Day of the Dead', 'Carnival', 'Cinco de Mayo', 'Diwali'],
  ['In which show does the character Wednesday Addams star as a teen?', 'Wednesday', 'Riverdale', 'Euphoria', 'Outer Banks'],
  ['What is the name of the cannibal family-style killer from "The Texas Chain Saw Massacre"?', 'Leatherface', 'Jason', 'Pinhead', 'Candyman'],
  ['Which creature does a stake through the heart kill in folklore?', 'Vampire', 'Werewolf', 'Mummy', 'Banshee'],
  ['What is the name of the haunted hotel in "The Shining"?', 'The Overlook Hotel', 'The Bates Motel', 'The Hotel Cortez', 'The Stanley'],
  ['Which of these is a classic horror movie monster created by a mad scientist?', 'Frankenstein\'s monster', 'The Mummy', 'The Wolf Man', 'The Invisible Man'],
  ['In the Alien movies, what is the main monster commonly called?', 'Xenomorph', 'Predator', 'Facehugger only', 'Thing'],
  ['Which Halloween-time film is set in Halloween Town?', 'The Nightmare Before Christmas', 'Beetlejuice', 'Coraline', 'Corpse Bride'],
];

const THEMES = {
  party: { prefix: '', rounds: { trivia: ['Round 1: Brain Check', 'Right answers only. Speed is points.', '🧠'], drop: ['Loot Drop', 'First three to grab it win. No second chances.', '💎'], rlgl: ['Red Light, Green Light', 'Run on green. Freeze on red or you lose your progress.', '🚦'], simon: ['Simon Says', 'Watch the pattern, then copy it exactly. It gets longer.', '🎛️'], bridge: ['Glass Bridge', 'One panel holds, one shatters. Fall and you start over, but everyone sees what broke.', '🌉'], tug: ['Tug of War', 'Two teams. Mash the button to pull the rope. Win and your whole team gets paid.', '🪢'], reaction: ['Round 2: Reflex Test', 'Wait for the signal. Jump the gun and you pay for it.', '⚡'], math: ['Round 3: Mental Math', 'Solve it, hit Enter, be fast.', '🧮'], hype: ['Surge', 'Everybody taps together. Fill the meter and EVERYONE gets paid.', '🔥'], finale: ['The Finale', 'Scores are locked. Payouts incoming.', '🏆'] }, music: { lobby: 'lobby', trivia: 'trivia', tense: 'tense', party: 'party', finale: 'finale' }, dance: 'The Drop', teams: ['Neon Blue', 'Hot Pink'] },
  halloween: { prefix: 'h-', rounds: { trivia: ['Round 1: Horror Trivia', 'Get it wrong and the lights go out.', '💀'], drop: ['Loot Drop', 'Grab it before the others do.', '🩸'], rlgl: ['Red Light, Green Light: Haunted', 'Run while the lantern is green. Freeze when the eyes glow red.', '🚦'], simon: ['Seance Says', 'Watch the candles flicker, then repeat the pattern.', '🕯️'], bridge: ['Haunted Bridge', 'One plank holds, one rots through. Fall and you start over, but everyone sees what broke.', '🌉'], tug: ['Tug of Souls', 'Ghosts versus Witches. Mash the button to pull the rope.', '🪢'], reaction: ['Round 2: Jump Scare Reflexes', 'Wait for the scare, then click. Flinch early and you lose points.', '👁️'], math: ['Round 3: Dark Math', 'Solve it before the candles burn out.', '🕯️'], hype: ['Scream Surge', 'Everybody screams together. Fill the meter and EVERYONE gets paid.', '😱'], finale: ['Survivors', 'Counting who made it out alive…', '🏆'] }, music: { lobby: 'h-lobby', trivia: 'h-trivia', tense: 'h-tense', party: 'h-party', finale: 'h-finale' }, dance: 'Midnight Rave', teams: ['Ghosts', 'Witches'] },
};
const PRESETS = {
  quick: { label: 'Quick (about 6 min)', trivia: 5, rlgl: 1, simon: 1, bridge: 1, tug: 1, math: 2, drops: 3, dance: 1 },
  standard: { label: 'Standard (about 12 min)', trivia: 10, rlgl: 2, simon: 2, bridge: 1, tug: 2, math: 4, drops: 6, dance: 2 },
  epic: { label: 'Epic (about 20 min)', trivia: 16, rlgl: 3, simon: 3, bridge: 2, tug: 3, math: 6, drops: 10, dance: 3 },
};

const DEFAULTS = { returnCoins: 100, theme: 'party', length: 'standard', prizes: [1000, 600, 300], spins: [3, 2, 1], partCoins: 50, hypeCoins: 40, winnerTag: true, musicMode: 'builtin', musicUrl: '' };
const SPEED = (typeof process !== 'undefined' && process.env && Number(process.env.SHOW_SPEED)) || 1; // only for testing: 10 = ten times faster
const LEAD_MS = Math.round(20000 / SPEED); // the show opens 20 seconds after the host presses Start so people can join
const DROP_WINNERS = 3;

const clamp = (v, lo, hi, d) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
function shuffle(a, rng) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const between = (lo, hi, rng) => lo + Math.floor(rng() * (hi - lo + 1));

function cleanOpts(o, isOwnerCall) {
  o = o || {};
  const out = {
    theme: THEMES[o.theme] ? o.theme : 'party',
    length: PRESETS[o.length] ? o.length : DEFAULTS.length,
    prizes: [0, 1, 2].map((i) => clamp(o.prizes && o.prizes[i], 0, 100000, DEFAULTS.prizes[i])),
    spins: [0, 1, 2].map((i) => clamp(o.spins && o.spins[i], 0, 20, DEFAULTS.spins[i])),
    partCoins: clamp(o.partCoins, 0, 5000, DEFAULTS.partCoins),
    returnCoins: clamp(o.returnCoins, 0, 5000, DEFAULTS.returnCoins),
    hypeCoins: clamp(o.hypeCoins, 0, 5000, DEFAULTS.hypeCoins),
    winnerTag: o.winnerTag === undefined ? DEFAULTS.winnerTag : !!o.winnerTag,
    musicMode: o.musicMode === 'link' ? 'link' : 'builtin',
    musicUrl: '',
  };
  const url = String(o.musicUrl || '').trim();
  if (/^https:\/\/[^\s]{4,400}$/i.test(url)) out.musicUrl = url; else if (out.musicMode === 'link') out.musicMode = 'builtin';
  return out;
}

function makeMath(i, rng) {
  const hard = Math.min(2, Math.floor(i / 2));
  const kind = between(0, 1 + hard, rng);
  let a, b, c, text, ans;
  if (kind === 0) { a = between(12, 69, rng); b = between(11, 29, rng); text = `${a} + ${b}`; ans = a + b; }
  else if (kind === 1) { a = between(40, 99, rng); b = between(11, 39, rng); text = `${a} - ${b}`; ans = a - b; }
  else if (kind === 2) { a = between(3, 12, rng); b = between(3, 9, rng); text = `${a} × ${b}`; ans = a * b; }
  else { a = between(3, 9, rng); b = between(3, 9, rng); c = between(5, 30, rng); text = `${a} × ${b} + ${c}`; ans = a * b + c; }
  return { text, ans };
}

// Picks N unique questions from several banks, by share.
function mixQuestions(N, parts, rng) {
  const used = new Set(), out = [];
  const take = (bank, n) => { for (const q of shuffle(bank, rng)) { if (n <= 0) break; if (used.has(q[0])) continue; used.add(q[0]); out.push(q); n--; } };
  parts.forEach(([bank, share]) => take(bank, Math.round(N * share)));
  const all = parts.flatMap(([b]) => b);
  take(all, N - out.length);
  return shuffle(out, rng).slice(0, N);
}

function makeShow(opts, now, rng) {
  rng = rng || Math.random;
  opts = cleanOpts(opts);
  const P = PRESETS[opts.length], TH = THEMES[opts.theme], MU = TH.music, R = TH.rounds;
  const steps = [];
  let t = 0;
  const add = (s) => { s.i = steps.length; s.at = t; t += s.dur; steps.push(s); return s; };
  const round = (r, music, num) => add({ kind: 'round', dur: 6500, title: num ? r[0] + ' ' + num : r[0], sub: r[1], icon: r[2], music });

  add({ kind: 'intro', dur: 22000, music: MU.lobby });
  const qs = opts.theme === 'halloween'
    ? mixQuestions(P.trivia, [[HALLOWEEN_TRIVIA, 0.4], [HORROR_GAMES, 0.2], [PROXY_TRIVIA, 0.2], [GAME_TRIVIA, 0.2]], rng)
    : mixQuestions(P.trivia, [[GAME_TRIVIA, 0.55], [PROXY_TRIVIA, 0.3], [TRIVIA, 0.15]], rng);
  round(R.trivia, MU.trivia);
  qs.forEach((q, n) => {
    const opts4 = shuffle(q.slice(1), rng);
    add({ kind: 'trivia', dur: 22000, answerMs: 16000, n: n + 1, of: qs.length, q: q[0], options: opts4, ans: opts4.indexOf(q[1]), music: MU.trivia });
  });
  let drops = 0;
  const dropKinds = ['coins', 'spin', 'coins', 'tag', 'coins', 'spin', 'coins', 'tag', 'coins', 'spin'];
  const addDrop = () => {
    const kind = dropKinds[drops % dropKinds.length];
    const prize = kind === 'coins' ? { kind, amount: [100, 150, 200, 250][between(0, 3, rng)] } : kind === 'spin' ? { kind, n: 1 } : { kind };
    add({ kind: 'drop', dur: 20000, answerMs: 15000, n: drops + 1, goDelay: between(3000, 9000, rng), prize, winners: [], music: MU.party });
    drops++;
  };
  if (P.drops > 0) { round(R.drop, MU.party); }
  const dropsFirst = Math.ceil(P.drops / 2);
  while (drops < dropsFirst) addDrop();
  for (let d = 0; d < P.dance; d++) {
    if (d === 0) add({ kind: 'dance', dur: 22000, title: TH.dance, music: MU.party });
    else if (d === 1) { /* second one comes after math */ }
  }
  if (P.rlgl > 0) {
    round(R.rlgl, MU.tense);
    for (let n = 0; n < P.rlgl; n++) {
      const segs = [between(1800, 2500, rng)]; let sum = segs[0], green = true;
      while (sum < 19000) { const d = green ? between(2200, 4200, rng) : between(1500, 3000, rng); segs.push(d); sum += d; green = !green; }
      add({ kind: 'rlgl', dur: 25000, answerMs: 20000, n: n + 1, of: P.rlgl, segs, music: MU.tense });
    }
  }
  round(R.math, MU.tense);
  for (let n = 0; n < P.math; n++) { const m = makeMath(n, rng); add({ kind: 'math', dur: 20000, answerMs: 15000, n: n + 1, of: P.math, text: m.text, ans: m.ans, music: MU.tense }); }
  while (drops < P.drops) addDrop();
  if (P.simon > 0) {
    round(R.simon, MU.tense);
    for (let n = 0; n < P.simon; n++) {
      const L = 4 + n * 2, seq = Array.from({ length: L }, () => between(0, 3, rng)), showMs = 1500 + L * 800, answerMs = showMs + 3000 + L * 1700;
      add({ kind: 'simon', dur: answerMs + 4500, answerMs, showMs, n: n + 1, of: P.simon, L, seq, music: MU.tense });
    }
  }
  if (P.bridge > 0) {
    round(R.bridge, MU.tense);
    for (let n = 0; n < P.bridge; n++) add({ kind: 'bridge', dur: 34000, answerMs: 28000, n: n + 1, of: P.bridge, rows: 8, safe: Array.from({ length: 8 }, () => between(0, 1, rng)), found: {}, music: MU.tense });
  }
  if (P.dance > 1) add({ kind: 'dance', dur: 22000, title: TH.dance, music: MU.party });
  if (P.tug > 0) {
    round(R.tug, MU.party);
    for (let n = 0; n < P.tug; n++) add({ kind: 'tug', dur: 30000, answerMs: 24000, n: n + 1, of: P.tug, music: MU.party });
  }
  round(R.finale, MU.finale);
  const finale = add({ kind: 'finale', dur: 60000, music: MU.finale });
  if (SPEED !== 1) { t = Math.round(t / SPEED); steps.forEach((x) => { x.at = Math.round(x.at / SPEED); x.dur = Math.round(x.dur / SPEED); if (x.answerMs !== undefined) x.answerMs = Math.round(x.answerMs / SPEED); if (x.goDelay !== undefined) x.goDelay = Math.round(x.goDelay / SPEED); if (x.segs) x.segs = x.segs.map((d) => Math.round(d / SPEED)); if (x.showMs) x.showMs = Math.round(x.showMs / SPEED); }); }
  return { id: Math.random().toString(36).slice(2, 8), opts, startedAt: now + LEAD_MS, endsAt: now + LEAD_MS + t, finaleAt: now + LEAD_MS + finale.at, steps, players: {}, paid: false, results: null, hype: {}, tug: {}, closed: false, started: now };
}

function stepIndex(show, now) {
  const off = now - show.startedAt;
  if (off < 0) return -1;
  for (let i = show.steps.length - 1; i >= 0; i--) if (off >= show.steps[i].at) return i;
  return 0;
}
const isOver = (show, now) => now >= show.endsAt;
const stepOff = (show, s, now) => now - show.startedAt - s.at;

function player(show, userId, name) {
  let p = show.players[userId];
  if (!p) p = show.players[userId] = { name: name || 'Player', score: 0, lastAt: 0, streak: 0, done: {}, taps: 0, team: Object.keys(show.players).length % 2, joinedAt: Date.now() };
  if (name) p.name = name;
  return p;
}
function join(show, userId, name) { const wasIn = !!show.players[userId]; player(show, userId, name); return { joined: !wasIn }; }

function addScore(p, pts, now) { p.score = Math.max(0, p.score + pts); p.lastAt = now; }

/* One action per step per person. Returns { ok, ... } or { error }. */
function answer(show, userId, b, now) {
  const p = show.players[userId]; if (!p) return { error: 'Join the show first' };
  const idx = stepIndex(show, now), s = show.steps[idx];
  if (!s || idx !== Number(b.step) || (s.kind !== 'trivia' && s.kind !== 'math')) return { error: 'That question is over' };
  const off = stepOff(show, s, now);
  if (off > s.answerMs) return { error: 'Time is up' };
  if (p.done[s.i]) return { error: 'You already answered' };
  let correct;
  if (s.kind === 'trivia') correct = Number(b.choice) === s.ans; else correct = String(b.value).trim() !== '' && Number(String(b.value).trim()) === s.ans;
  const speed = Math.round(100 * (1 - Math.min(1, off / s.answerMs)));
  let pts = 0;
  if (correct) { p.streak++; pts = (s.kind === 'math' ? 120 : 100) + speed + (p.streak >= 3 ? 25 : 0); } else p.streak = 0;
  p.done[s.i] = { correct, pts, choice: b.choice === undefined ? null : Number(b.choice) };
  if (pts) addScore(p, pts, now);
  return { ok: true, correct, pts, streak: p.streak };
}

function react(show, userId, b, now) {
  const p = show.players[userId]; if (!p) return { error: 'Join the show first' };
  const idx = stepIndex(show, now), s = show.steps[idx];
  if (!s || idx !== Number(b.step) || s.kind !== 'reaction') return { error: 'That round is over' };
  if (p.done[s.i]) return { error: 'You already went' };
  const off = stepOff(show, s, now);
  if (off > s.answerMs) return { error: 'Time is up' };
  if (off < s.goDelay) { p.done[s.i] = { early: true, pts: -50 }; addScore(p, -50, now); p.streak = 0; return { ok: true, early: true, pts: -50 }; }
  const ms = off - s.goDelay;
  const pts = Math.max(20, Math.min(220, Math.round(220 - ms / 6)));
  p.done[s.i] = { ms, pts }; addScore(p, pts, now);
  return { ok: true, ms, pts };
}

/* Red Light, Green Light: taps count only while the light is green. A tap on red (after a short grace) sends you back to the start. */
const RL_FINISH = 60;
function lightAt(s, off) {
  let t = 0;
  for (let i = 0; i < s.segs.length; i++) { if (off < t + s.segs[i]) return { green: i % 2 === 1, since: off - t }; t += s.segs[i]; }
  return { green: false, since: off - t };
}
function run(show, userId, b, now) {
  const p = show.players[userId]; if (!p) return { error: 'Join the show first' };
  const idx = stepIndex(show, now), s = show.steps[idx];
  if (!s || idx !== Number(b.step) || s.kind !== 'rlgl') return { error: 'That round is over' };
  const off = stepOff(show, s, now);
  if (off > s.answerMs) return { error: 'Time is up' };
  const d = p.done[s.i] || (p.done[s.i] = { pos: 0, caught: 0, pts: 0, lock: 0 });
  const out = () => ({ ok: true, pos: d.pos, caught: false, finished: !!d.finished, locked: off < d.lock, pts: d.pts });
  if (d.finished || off < d.lock) return out();
  const n = Math.max(0, Math.min(8, Math.floor(Number(b.n) || 0)));
  if (!n) return out();
  const ph = lightAt(s, off);
  if (!ph.green && ph.since > 450) {
    addScore(p, -d.pts, now); d.pts = 0; d.pos = 0; d.caught++; d.lock = off + 1500; p.streak = 0;
    const r = out(); r.caught = true; r.locked = true; return r;
  }
  d.pos = Math.min(RL_FINISH, d.pos + n);
  let pts = Math.round(d.pos * 1.5);
  if (d.pos >= RL_FINISH) { d.finished = true; pts += 40 + Math.round(Math.max(0, s.answerMs - off) / 1000) * 4; }
  addScore(p, pts - d.pts, now); d.pts = pts;
  return out();
}

/* Simon Says: copy the pattern. The whole answer is sent at once. */
function simon(show, userId, b, now) {
  const p = show.players[userId]; if (!p) return { error: 'Join the show first' };
  const idx = stepIndex(show, now), s = show.steps[idx];
  if (!s || idx !== Number(b.step) || s.kind !== 'simon') return { error: 'That round is over' };
  const off = stepOff(show, s, now);
  if (off < s.showMs) return { error: 'Wait for the pattern to finish' };
  if (off > s.answerMs) return { error: 'Time is up' };
  if (p.done[s.i]) return { error: 'You already went' };
  const seq = Array.isArray(b.seq) ? b.seq.slice(0, s.L).map((x) => Number(x)) : [];
  let prefix = 0; while (prefix < seq.length && seq[prefix] === s.seq[prefix]) prefix++;
  const correct = seq.length === s.L && prefix === s.L;
  let pts = prefix * 10;
  if (correct) { p.streak++; pts = 130 + Math.round(100 * (1 - (off - s.showMs) / (s.answerMs - s.showMs))) + (p.streak >= 3 ? 25 : 0); } else p.streak = 0;
  p.done[s.i] = { correct, pts, prefix };
  addScore(p, pts, now);
  return { ok: true, correct, pts, prefix };
}

/* Glass Bridge: each row has a safe panel and a broken one. A fall sends you back, and shows the broken panel to everyone. */
function bridge(show, userId, b, now) {
  const p = show.players[userId]; if (!p) return { error: 'Join the show first' };
  const idx = stepIndex(show, now), s = show.steps[idx];
  if (!s || idx !== Number(b.step) || s.kind !== 'bridge') return { error: 'That round is over' };
  const off = stepOff(show, s, now);
  if (off > s.answerMs) return { error: 'Time is up' };
  const d = p.done[s.i] || (p.done[s.i] = { row: 0, falls: 0, pts: 0, lock: 0 });
  const out = (fell) => ({ ok: true, row: d.row, fell: !!fell, finished: !!d.finished, pts: d.pts, found: s.found });
  if (d.finished || off < d.lock) return out(false);
  const side = Number(b.side) === 1 ? 1 : 0;
  if (side === s.safe[d.row]) {
    s.found[d.row] = s.safe[d.row]; d.row++;
    let pts = d.row * 15;
    if (d.row >= s.rows) { d.finished = true; pts += 60 + Math.round(Math.max(0, s.answerMs - off) / 1000) * 3; }
    addScore(p, pts - d.pts, now); d.pts = pts;
    return out(false);
  }
  s.found[d.row] = s.safe[d.row];
  addScore(p, -d.pts, now); d.pts = 0; d.row = 0; d.falls++; d.lock = off + 1500; p.streak = 0;
  return out(true);
}

/* Tug of War: two teams, every tap pulls. */
function pull(show, userId, b, now) {
  const p = show.players[userId]; if (!p) return { error: 'Join the show first' };
  const idx = stepIndex(show, now), s = show.steps[idx];
  if (!s || s.kind !== 'tug' || stepOff(show, s, now) > s.answerMs) return { error: 'The rope is let go' };
  const n = Math.max(0, Math.min(12, Math.floor(Number(b.n) || 0)));
  const g = show.tug[s.i] || (show.tug[s.i] = { t: [0, 0], per: {} });
  const mine = g.per[userId] || 0, add = Math.min(n, Math.max(0, 300 - mine));
  g.per[userId] = mine + add; g.t[p.team === 1 ? 1 : 0] += add;
  const before = Math.min(120, Math.floor(mine / 2)), after = Math.min(120, Math.floor((mine + add) / 2));
  if (after > before) addScore(p, after - before, now);
  return { ok: true, t: g.t, team: p.team, mine: g.per[userId] };
}
const tugWinner = (show, s) => { const g = show.tug[s.i]; return !g || g.t[0] === g.t[1] ? -1 : g.t[0] > g.t[1] ? 0 : 1; };

/* Claiming a prize drop. Returns { ok, place, award } where award is { coins, spins, tag } for the server to hand out. */
function claim(show, userId, b, now) {
  const p = show.players[userId]; if (!p) return { error: 'Join the show first' };
  const idx = stepIndex(show, now), s = show.steps[idx];
  if (!s || idx !== Number(b.step) || s.kind !== 'drop') return { error: 'That prize is gone' };
  const off = stepOff(show, s, now);
  if (off < s.goDelay) return { error: 'Not yet!' };
  if (off > s.answerMs) return { error: 'Too late' };
  if (p.done[s.i]) return { error: 'You already tried' };
  p.done[s.i] = { claimed: true };
  if (s.winners.length >= DROP_WINNERS) return { ok: true, place: 0, missed: true };
  s.winners.push(userId);
  const place = s.winners.length;
  const pz = s.prize;
  const award = pz.kind === 'coins' ? { coins: Math.round(pz.amount * (place === 1 ? 1 : place === 2 ? 0.6 : 0.4)) } : pz.kind === 'spin' ? { spins: 1 } : { tag: true };
  addScore(p, place === 1 ? 100 : place === 2 ? 70 : 50, now);
  return { ok: true, place, award, prize: pz };
}

function tap(show, userId, b, now) {
  const p = show.players[userId]; if (!p) return { error: 'Join the show first' };
  const idx = stepIndex(show, now), s = show.steps[idx];
  if (!s || s.kind !== 'hype' || stepOff(show, s, now) > s.answerMs) return { error: 'The meter is closed' };
  const n = Math.max(0, Math.min(12, Math.floor(Number(b.n) || 0)));
  const key = s.i;
  const h = show.hype[key] || (show.hype[key] = { total: 0, per: {} });
  const mine = h.per[userId] || 0;
  const room = Math.max(0, 260 - mine), add = Math.min(n, room);
  h.per[userId] = mine + add; h.total += add;
  const before = Math.min(120, Math.floor(mine / 2)), after = Math.min(120, Math.floor((mine + add) / 2));
  if (after > before) addScore(p, after - before, now);
  return { ok: true, total: h.total, target: hypeTarget(show), mine: h.per[userId] };
}
const hypeTarget = (show) => Math.max(90, Object.keys(show.players).length * 40);

function board(show) {
  return Object.entries(show.players).map(([id, p]) => ({ id, name: p.name, score: p.score, lastAt: p.lastAt })).sort((a, b) => b.score - a.score || a.lastAt - b.lastAt);
}

/* Prizes, paid once when the finale starts. pickTag(rng) lets the server choose a tag that is not Croma. */
function payout(show, pickTag, holders) {
  if (show.paid) return [];
  show.paid = true;
  const ranked = board(show).filter((r) => show.players[r.id]);
  const ledger = {};
  const give = (id, o) => { const l = ledger[id] || (ledger[id] = { coins: 0, spins: 0, tag: null, evTag: null, notes: [] }); l.coins += o.coins || 0; l.spins += o.spins || 0; if (o.tag) l.tag = o.tag; if (o.evTag) l.evTag = o.evTag; if (o.note) l.notes.push(o.note); };
  ranked.forEach((r) => { give(r.id, { coins: show.opts.partCoins, note: `${show.opts.partCoins} coins for joining` }); });
  // Everyone who joined gets this show's limited tag. (The server also gives it to everyone online when the finale starts.)
  const evTag = show.opts.theme === 'halloween' ? 'show-halloween' : 'show-live';
  ranked.forEach((r) => give(r.id, { evTag, note: 'limited tag' }));
  // People who already hold a limited event tag from an earlier show get bonus coins for coming back.
  if (holders && show.opts.returnCoins) ranked.forEach((r) => { if (holders.has(r.id)) give(r.id, { coins: show.opts.returnCoins, note: 'returning tag holder bonus' }); });
  ranked.slice(0, 3).forEach((r, i) => {
    if (r.score <= 0) return;
    give(r.id, { coins: show.opts.prizes[i], spins: show.opts.spins[i], note: `${['1st', '2nd', '3rd'][i]} place` });
  });
  if (show.opts.winnerTag && ranked[0] && ranked[0].score > 0 && pickTag) { const tg = pickTag(); if (tg) give(ranked[0].id, { tag: tg, note: 'winner tag' }); }
  // Tug of war: everyone on the winning team of each round gets a bonus.
  show.steps.filter((x) => x.kind === 'tug').forEach((x) => {
    const w = tugWinner(show, x); if (w < 0 || !show.opts.hypeCoins) return;
    ranked.forEach((r) => { if (show.players[r.id].team === w && (show.tug[x.i] || { per: {} }).per[r.id]) give(r.id, { coins: show.opts.hypeCoins, note: 'tug of war win' }); });
  });
  show.results = ranked.map((r, i) => ({ id: r.id, name: r.name, score: r.score, rank: i + 1, coins: (ledger[r.id] || {}).coins || 0, spins: (ledger[r.id] || {}).spins || 0, tag: (ledger[r.id] || {}).tag || null, evTag: (ledger[r.id] || {}).evTag || null }));
  return Object.entries(ledger).map(([id, l]) => Object.assign({ userId: id }, l));
}

/* What one person sees. Answers stay hidden until a step's answer time has passed. */
function view(show, userId, now) {
  const idx = stepIndex(show, now);
  const lb = board(show);
  const me = show.players[userId] || null;
  const rank = me ? lb.findIndex((r) => r.id === userId) + 1 : 0;
  const out = {
    id: show.id, now, startedAt: show.startedAt, endsAt: show.endsAt, joined: !!me, players: lb.length,
    score: me ? me.score : 0, rank, board: lb.slice(0, 10).map((r, i) => ({ id: r.id, name: r.name, score: r.score, rank: i + 1 })),
    total: show.steps.length, index: idx, opts: { theme: show.opts.theme, musicMode: show.opts.musicMode, musicUrl: show.opts.musicMode === 'link' ? show.opts.musicUrl : '', prizes: show.opts.prizes, spins: show.opts.spins, winnerTag: show.opts.winnerTag, partCoins: show.opts.partCoins, returnCoins: show.opts.returnCoins },
    streak: me ? me.streak : 0,
  };
  if (idx < 0) { out.phase = 'lobby'; out.step = null; out.next = show.startedAt; return out; }
  const s = show.steps[idx], off = stepOff(show, s, now);
  const reveal = s.answerMs !== undefined && off >= s.answerMs;
  const st = { i: s.i, kind: s.kind, at: show.startedAt + s.at, dur: s.dur, answerMs: s.answerMs || 0, music: s.music, n: s.n, of: s.of, title: s.title, sub: s.sub, icon: s.icon, reveal };
  if (s.kind === 'trivia') { st.q = s.q; st.options = s.options; if (reveal) st.ans = s.ans; }
  if (s.kind === 'math') { st.text = s.text; if (reveal) st.ans = s.ans; }
  if (s.kind === 'reaction' || s.kind === 'drop') { st.goAt = show.startedAt + s.at + s.goDelay; }
  if (s.kind === 'drop') { st.prize = s.prize; st.winners = s.winners.map((id) => (show.players[id] || {}).name || '?'); st.full = s.winners.length >= DROP_WINNERS; }
  if (s.kind === 'rlgl' || s.kind === 'bridge') st.crowd = Object.entries(show.players).slice(0, 80).map(([id, p]) => { const d = p.done[s.i] || {}; return { id, name: p.name, pos: s.kind === 'rlgl' ? (d.pos || 0) : (d.row || 0), fin: !!d.finished, hit: !!(d.lock && off < d.lock) }; });
  if (s.kind === 'simon') { st.seq = s.seq; st.showMs = s.showMs; st.L = s.L; }
  if (s.kind === 'bridge') { st.rows = s.rows; st.found = Object.assign({}, s.found); if (reveal) st.safe = s.safe; }
  if (s.kind === 'tug') { const g = show.tug[s.i] || { t: [0, 0] }; st.tug = { t: g.t.slice(), team: me && me.team === 1 ? 1 : 0, names: THEMES[show.opts.theme].teams, winner: reveal ? tugWinner(show, s) : -2 }; }
  if (s.kind === 'rlgl') { st.segs = s.segs; st.finish = RL_FINISH; }
  if (s.kind === 'hype') { const h = show.hype[s.i] || { total: 0, per: {} }; st.hype = { total: h.total, target: hypeTarget(show), mine: h.per[userId] || 0 }; }
  if (me && me.done[s.i]) st.mine = Object.assign({}, me.done[s.i]);
  if (s.kind === 'finale') { st.results = show.results || null; st.paid = show.paid; }
  out.step = st; out.phase = s.kind;
  return out;
}

module.exports = { TRIVIA, GAME_TRIVIA, PROXY_TRIVIA, HORROR_GAMES, HALLOWEEN_TRIVIA, THEMES, PRESETS, DEFAULTS, LEAD_MS, DROP_WINNERS, cleanOpts, makeShow, stepIndex, isOver, join, answer, react, run, simon, bridge, pull, claim, tap, board, payout, view, hypeTarget };

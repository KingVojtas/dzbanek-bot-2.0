# 🍪 Dzbanek-bot 2.0

A TypeScript Discord bot (discord.js v14) for the kitchen. It plays YouTube and Spotify in voice, streams Czech live radio, posts Steam deals and Epic free games, and keeps a cookie warm for anyone who walks in.

Music and radio share one voice slot per server. Starting one takes the speaker from the other.

---

## ✨ What’s cooking

### 🎵 Music

Play from YouTube (a link or a search) and from Spotify (track, album, or playlist). Spotify is the recipe card. The audio comes from YouTube via yt-dlp.

It is quick about it. A search reads only YouTube’s result list, about 2 s instead of 6. A YouTube link starts downloading while its title is still being read. A Spotify album or playlist starts its first song as soon as that one is found, and the rest join the queue in order while you listen. Anything played in the last 6 hours resolves instantly.

Now Playing is a Components v2 card: album art, a progress bar, and transport buttons. When the next track starts, the previous card is cleared so the chat stays tidy.

| Command              | What it does                                                                            |
| -------------------- | --------------------------------------------------------------------------------------- |
| `/play <query>`      | Join your voice channel and play a track, or add it to the queue. Optional `play_next`. |
| `/queue`             | Show the current track and the upcoming queue as a card, page by page.                  |
| `/nowplaying`        | Bring the Now Playing card down to the bottom of the chat.                              |
| `/skip`              | Skip to the next track.                                                                 |
| `/pause`             | Pause, or resume when already paused.                                                   |
| `/volume <percent>`  | Set the volume for everyone, 25–150 % (100 is normal).                                  |
| `/stop`              | Stop playback, clear the queue, delete the Now Playing card, and leave.                 |
| `/remove <position>` | Drop one upcoming track (1-based).                                                      |

The Now Playing card carries two rows of buttons: ⏸️ pause, ⏭️ skip, ⏹️ stop, 🔁 loop and 🔀 shuffle, then ⏮️ previous, 🔉 / 🔊 volume (25 % steps) and 📜 queue. Previous plays the last finished track again, and the current one waits right behind it. The volume carries over to the next track. Anyone can open the queue; the other buttons want you in the bot’s voice channel. The Kitchen Board shows the same song.

### ❓ Help

`/help` shows every command, grouped by shelf, in a card only you can see. `/help command:<name>` spells out one command and its options. A new command lands in `/help` on its own.

Replies wear a color for what happened: green when something worked, orange when the bot needs something from you (join voice, Manage Server), red when it failed.

On startup, Dzbanek writes its profile’s About Me, so anyone clicking the bot sees what it does and that `/help` is there.

When the queue goes quiet, Dzbanek waits **120 seconds** (configurable). If people are still in the channel, the last radio station fades in (Beat, if there isn’t one yet). `/setup idle-radio` turns that handoff off. `/stop` still leaves. The queue holds **100** tracks.

### 📻 Live radio

`/radio play` joins **your** voice channel and streams a Czech Icecast station. The card wears the station logo and brand color, and it names the track on air. Metadata is checked about every **20 seconds**, and the **same message** is edited when the song changes.

| Choice  | Station    | Stream                                      |
| ------- | ---------- | ------------------------------------------- |
| 💋 Kiss | Kiss Radio | `https://icecast4.play.cz/kiss128.mp3`      |
| 🎸 Rock | Rock Radio | `http://ice.abradio.cz/rockradio128.mp3`    |
| 🥁 Beat | Radio Beat | `https://icecast3.play.cz/radiobeat128.mp3` |

Now-playing sources stay off the FFmpeg voice stream:

- **Kiss / Rock Radio** — [radia.cz](https://radia.cz) `songs/now.json`, then Icecast ICY `StreamTitle`
- **Radio Beat** — Beat’s own `?do=broadcast-update` (“Právě v éteru”), then radia.cz while the listing is still fresh, then ICY

Beat often sends only a station tag over Icecast. During shows such as **Hard & Heavy**, the site publishes the program name. That is what the card shows. 🍪 Catch will smile and refuse it: a show is not a song.

| Command                 | What it does                                             |
| ----------------------- | -------------------------------------------------------- |
| `/radio play <station>` | Join your channel and start Kiss, Rock Radio, or Beat.   |
| `/radio stop`           | Stop the stream, leave voice, and delete the radio card. |
| `/radio night`          | Schedule Friday 20:00 Radio Night in a voice channel.    |
| `/radio night-off`      | Cancel scheduled Radio Night.                            |

The card has **Website**, **Catch**, and **Stop**. Stop wants you in the bot’s voice channel. Catch saves the artist and title for you. The reply grows a **Play** button, which finds that song on YouTube and queues it the same way `/play` does. The Kitchen Board keeps the server’s latest catch, and only the person who saved it can press Play there.

Radio stays up. It does not wander off during a quiet stretch. Switching stations reuses the same connection and retires the previous card.

A restart puts that station back on if idle-radio is still on and people are still in the voice channel. `/radio stop` clears the channel, so a restart after a stop stays quiet. The first boot after this change has no channel saved yet, so `/radio play` is needed once.

### 🍪 The Kitchen Board

`/setup kitchen` hangs one living message and keeps editing it. Three cards stack in that message. The top card is the stereo: the song, or **The Kitchen** when nothing is on, who’s in voice, and **Catch** / **Stop** while the radio plays. The middle card stays amber: the top Steam deal (discount, price, and how many more) and the Epic free game. The bottom card shows up for the latest catch and its **Play** button, today’s joins, and Radio Night. Friday from **12:00 to 20:00** the vote buttons sit on that bottom card.

Discord presence is the well. Each hour in Europe/Prague the three lines play once, twenty minutes each, in a new order: Purifying the source, Analyzing bacteria levels, Pouring fresh drops.

On Sunday at **18:00 Europe/Prague** the kitchen channel gets one postcard for the week 📬: the songs people caught, and Friday’s Radio Night tally when anyone voted. The living board stays the live stereo.

### 🌙 Radio Night

`/radio night` (Manage Server) picks a voice channel and a fallback station. On Friday from **12:00 to 20:00 Europe/Prague** the Kitchen Board puts out Kiss / Rock / Beat vote buttons. One vote per person, and you can change your mind. At **20:00** the winner starts in that channel. A tie falls through the scheduled station, then the last station that played, then Beat. `/radio night-off` takes it off the calendar.

### 💸 Steam daily deals

Every day at **03:33 Europe/Prague** Dzbanek reads Steam discounts from [game-deals.app](https://game-deals.app) and the current Steam specials list, then posts a fresh **10-game** digest in every server that has a Steam channel.

Very Positive games (score ≥ 8, or ≥ 80% positive with at least 10 reviews) sit at the top, deepest discount first. When the curated feed is shorter than 10, current Steam specials fill the empty seats — deepest discount, then the most reviews. Prices use the German storefront (`cc=de` → EUR).

The same 10-game lineup is remembered per server. A repeat stays in the pot. An empty feed stays quiet too.

### 🎁 Epic free games

The Epic Store is checked at **12:00** and **17:00 Europe/Prague**, when the weekly free lineup usually turns over. Each server hears about a lineup once. The 03:33 slot belongs to Steam.

Both cupboards keep what they already served in SQLite (`data/bot.db`, Prisma), per server, so a restart cannot dish it out again.

### 👋 Welcome and goodbye

Turn on **Server Members Intent** in the Discord Developer Portal (Bot → Privileged Gateway Intents).

A join or a leave lands as a card. The server name and icon sit on the author line, their avatar is the thumbnail, and the kitchen copy stays.

| Event | Card                                                                                                                                                                                                                    |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Join  | Amber embed titled **Welcome, name**. `🍪 Hey @user! Welcome to the dark side, we have cookies. I’m Dzbanek — grab one, say hi, and don’t mind the crumbs. 😈` Shows who’s in the kitchen and when they joined Discord. |
| Leave | Dusk embed titled **name left the kitchen**. `👋 Hasta la vista, baby! 🕶️🍪 We’ll keep a cookie warm in case they come back.` Shows who’s still here, and when they sat down if Discord still knows.                    |

### 🚪 Rooms

Open a text or voice room in a category that already exists. Only a server administrator can do this. Dzbanek reads the name and sets one emoji in front, in the sidebar style: `🍪・the-kitchen`, `⛏️・minecraft-vse`, `🎧・room 1`.

| Command                                 | What it does                                                                 |
| --------------------------------------- | ---------------------------------------------------------------------------- |
| `/textroom <name> <category> <access>`  | Text room. Spaces in the name become hyphens. `access` is Public or Private. |
| `/voiceroom <name> <category> <access>` | Voice room. Spaces stay spaces. `access` is Public or Private.               |

Public follows whoever can already see that category. Private hides the room from everyone except administrators. A name that is already on that shelf is left alone. Dzbanek does not invent new categories.

### 🏠 Many kitchens

Music and radio already keep a separate pot per server. Deals and greetings are arranged per server too:

| Command                      | What it does                                                       |
| ---------------------------- | ------------------------------------------------------------------ |
| `/setup steam <channel>`     | Where Steam deals land (Manage Server).                            |
| `/setup epic <channel>`      | Where Epic free games land.                                        |
| `/setup welcome <channel>`   | Where join messages land.                                          |
| `/setup goodbye <channel>`   | Where leave messages land.                                         |
| `/setup kitchen <channel>`   | Where the Kitchen Board hangs.                                     |
| `/setup idle-radio <on/off>` | Fade into radio when the music queue goes quiet.                   |
| `/setup status`              | Show this server’s channels.                                       |
| `/setup disable …`           | Pause one feed, a greeting, the board, Radio Night, or idle radio. |

Skip `/setup` and Dzbanek looks for a text channel named like `#steam`, `#deals`, `#epic`, `#free-games`, `#welcome`, or `#goodbye`. The `channelId` values in `config.json` only season the server that actually owns those channels.

---

## 🧰 What you need

- **Node.js ≥ 22.12**
- **FFmpeg** — bundled via `ffmpeg-static` (a system `ffmpeg` on your `PATH` still works)
- **Deno** on your `PATH` (`deno --version` should answer) — yt-dlp uses it to solve YouTube player JS so audio URLs stay friendly
- A Discord bot token from the [Discord Developer Portal](https://discord.com/developers/applications)
- A home PC or VPS (YouTube is often shy with datacenter IPs)

### 🔑 Bot permissions

OAuth2 scopes: `bot`, `applications.commands`

Privileged intent: **Server Members Intent** (welcome / goodbye).

| Feature            | Permissions                                                              |
| ------------------ | ------------------------------------------------------------------------ |
| 🎵 Music / Radio   | Connect, Speak, View Channel                                             |
| 💸 Steam / Epic    | View Channel, Send Messages, Embed Links, Manage Messages, Add Reactions |
| 👋 Welcome / leave | View Channel, Send Messages                                              |
| 🚪 Rooms           | Manage Channels                                                          |

**Manage Messages** lets Dzbanek clear the previous Now Playing card and the previous digest.

---

## 🍰 Setup

```bash
# 1. Install dependencies (yt-dlp binary, ffmpeg-static, Prisma client)
npm install
npx prisma db push

# 2. Create your .env file
cp .env.example .env
# Edit .env and set:  DISCORD_TOKEN=your_token_here

# 3. Fill in src/config/config.json
#    - discord.clientId  = Application ID from the Developer Portal
#    - discord.guildId   = leave null (deploy publishes global commands)
#    - steam.channelId / epic.channelId = optional legacy channel IDs
#      (seed that one server; other servers use /setup or auto-detect)

# 4. Register slash commands
npm run deploy

# 5. Put the kettle on
npm run dev       # development — auto-reloads on file changes
npm start         # production
```

`npm run deploy` registers the command list on the two kitchen servers immediately, and publishes the same list globally. Other servers can take up to about an hour. Restart the Discord app if the picker is stale.

### 🟢 Optional Spotify

Create an app at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) and set in `.env`:

```
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
```

With those, albums and playlists resolve. A single-track link can still fall back to a YouTube search when the keys are absent.

### 🍪 Optional YouTube cookies

If yt-dlp meets an age gate or a bot check, export Netscape `cookies.txt` from a logged-in browser, base64-encode it, and set:

```
YTDLP_COOKIES_BASE64=...
```

---

## ⚙️ Configuration

Everyday settings live in `src/config/config.json`. The one secret is `DISCORD_TOKEN`.

```json
{
  "discord": {
    "clientId": "YOUR_DISCORD_APPLICATION_ID",
    "guildId": null
  },
  "timezone": "Europe/Prague",
  "music": {
    "idleTimeoutSec": 120,
    "maxQueueSize": 100
  },
  "steam": {
    "channelId": "YOUR_STEAM_CHANNEL_ID",
    "cron": "33 3 * * *",
    "maxSeenIds": 500,
    "postOnFirstRun": true
  },
  "epic": {
    "channelId": "YOUR_EPIC_CHANNEL_ID",
    "cron": "0 12,17 * * *",
    "postOnFirstRun": true
  },
  "welcome": {
    "channelId": ""
  },
  "goodbye": {
    "channelId": ""
  },
  "embedColor": "#5865F2"
}
```

Cron expressions use `timezone` (Europe/Prague). `postOnFirstRun` decides whether the first poll after startup may post.

---

## 🗂️ Project structure

```
src/
  index.ts                 Composition root — music, radio, deals, cron
  deploy-commands.ts       One-shot slash command registration
  config/                  Typed config loader (config.json + DISCORD_TOKEN)
  core/                    Client, logger, types, embeds, Components v2 cards
  commands/
    admin/setup.ts         Per-server deal, greeting, and kitchen channels
    rooms.ts               /textroom and /voiceroom
    music/                 /play, /queue, /nowplaying, /skip, /pause, /volume, /stop, /remove
    help.ts                /help, built from the command list
    radio.ts               /radio play, stop, night, night-off
  rooms/                   Emoji prefixes for new channel names
  events/                  ready, interactions, member join/leave
  greetings/               Welcome / goodbye copy and channel resolve
  kitchen/                 Kitchen Board, Radio Night votes, catches, presence
  music/                   Voice queue, Now Playing, YouTube + Spotify
  radio/                   Icecast session, station catalog, now-playing poll
  db/                      Prisma client + one-shot JSON → SQLite migrate
  deals/
    seen-store.ts          SQLite seen IDs (Prisma DedupEntry)
    guild-settings.ts      SQLite per-server channels
    steam/                 RSS + reviews + prices + digest
    epic/                  Free-games API + digest
prisma/schema.prisma       SQLite models
prisma.config.ts           Database URL (Prisma 7)
data/bot.db                Runtime SQLite (git-ignored)
```

---

## 📜 Scripts

| Script              | What it does                                                                         |
| ------------------- | ------------------------------------------------------------------------------------ |
| `npm run dev`       | Run with auto-reload (`tsx watch`). 👀                                               |
| `npm start`         | Run the bot. 🍪                                                                      |
| `npm run deploy`    | Register slash commands with Discord.                                                |
| `npm run db:push`   | Create or update `data/bot.db` from the Prisma schema.                               |
| `npm run typecheck` | Type-check with `tsc --noEmit`.                                                      |
| `npm run lint`      | Lint with ESLint.                                                                    |
| `npm run format`    | Format with Prettier.                                                                |
| `npm run check`     | Typecheck, lint, Prettier, and the offline card checks in one go.                    |
| `npm run verify`    | Live smoke test: ffmpeg, yt-dlp, Spotify, Steam, Epic, Discord login (needs `.env`). |

---

## 🔧 If something smells off

| What happened                            | What to try                                                                                                                                     |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Song won't play / "Could not load track" | Update yt-dlp: delete `node_modules/youtube-dl-exec` and reinstall. Set `YTDLP_COOKIES_BASE64` if YouTube asks you to prove you’re human.       |
| No audio                                 | Confirm `ffmpeg-static` came in with `npm install`, and that the bot has Connect + Speak.                                                       |
| Slash commands missing                   | Run `npm run deploy`. The two kitchen servers update immediately. Other servers can take about an hour. Restart Discord if the picker is stale. |
| `/radio` is missing the station option   | Deploy again after pulling. Type `/radio`, then pick **play** and a station.                                                                    |
| Radio Beat shows a show name             | During a program, Beat publishes the show. The card follows “Právě v éteru”. Catch waits for a real song.                                       |
| Steam / Epic stayed quiet                | Check `/setup status` and the bot’s permissions. An unchanged lineup stays in the pot.                                                          |
| Welcome / goodbye stayed quiet           | Enable **Server Members Intent**, then `/setup welcome` and `/setup goodbye`.                                                                   |
| An old card is stuck                     | Grant **Manage Messages** so Dzbanek can clear the previous one.                                                                                |

# Dzbanek-bot 2.0

A TypeScript Discord bot (discord.js v14) that plays YouTube/Spotify in voice, streams Czech live radio, posts Steam daily deals and Epic free games, and greets members when they join or leave.

Voice, deals, and greetings are separate modules. Music and radio share one voice slot per server — starting one stops the other.

---

## Features

### Music player

Play audio from YouTube (URL or search) and Spotify (track / album / playlist). Spotify is metadata only; audio is resolved on YouTube via yt-dlp.

Now Playing is a Components v2 card (album art, progress, transport buttons). When a new track starts, the previous card is deleted so the chat does not stack player messages.

| Command              | Description                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------- |
| `/play <query>`      | Join your voice channel and play a track (or add it to the queue). Optional `play_next`. |
| `/skip`              | Skip the current track.                                                                  |
| `/queue`             | Show the upcoming queue (paginated).                                                     |
| `/stop`              | Stop playback, clear the queue, delete the Now Playing card, and leave.                  |
| `/pause` / `/resume` | Pause or resume playback.                                                                |
| `/nowplaying`        | Show the current track.                                                                  |
| `/shuffle`           | Shuffle the upcoming queue.                                                              |
| `/loop`              | `off`, `track`, or `queue`.                                                              |
| `/remove <position>` | Drop a track from the upcoming queue (1-based).                                          |

Idle auto-disconnect after **120 seconds** of silence (configurable). Queue cap is **100** tracks.

### Live radio

`/radio play` joins **your** voice channel and streams a Czech Icecast station. The card uses the station logo, brand color, and the track currently on air. Metadata is polled about every **20 seconds** and the **same message** is edited when the song changes.

| Choice     | Station    | Stream                                      |
| ---------- | ---------- | ------------------------------------------- |
| Kiss       | Kiss Radio | `https://icecast4.play.cz/kiss128.mp3`      |
| Rock Radio | Rock Radio | `http://ice.abradio.cz/rockradio128.mp3`    |
| Radio Beat | Radio Beat | `https://icecast3.play.cz/radiobeat128.mp3` |

Now-playing sources (never mixed into the FFmpeg voice stream):

- **Kiss / Rock Radio** — [radia.cz](https://radia.cz) `songs/now.json`, then Icecast ICY `StreamTitle`
- **Radio Beat** — Beat’s own `?do=broadcast-update` (“Právě v éteru”), then radia.cz if the listing is still fresh, then ICY

Beat often only sends a station tag over Icecast. During shows such as **Hard & Heavy**, the site publishes the program name instead of a single song — that is what the card shows.

| Command                 | Description                                              |
| ----------------------- | -------------------------------------------------------- |
| `/radio play <station>` | Join your channel and start Kiss, Rock Radio, or Beat.   |
| `/radio stop`           | Stop the stream, leave voice, and delete the radio card. |

The card also has **Website** and **Stop**. You must be in the bot’s voice channel to stop it.

Radio does **not** idle-kick. Switching stations reuses the same connection and deletes the previous card.

### Steam daily deals

Every day at **03:33 Europe/Prague** the bot fetches Steam discounts from [game-deals.app](https://game-deals.app), keeps games rated _Very Positive_ or better, and posts a digest of **new** deals in every server that has a Steam channel.

If every deal was already posted in that server, or none pass the review filter, **no message is sent**.

Steam prices use the German storefront (`cc=de` → EUR). Review threshold is Very Positive (`score ≥ 8` or ≥ 80% positive, ≥ 10 reviews).

### Epic Games free games

Polls the Epic Store at **12:00** and **17:00 Europe/Prague** (when the weekly free lineup usually rotates). Posts in **each server** only when that server has not seen this lineup yet. Not at 03:33 — that slot is Steam only.

Both fetchers persist posted IDs / lineup fingerprints **per server** in SQLite (`data/bot.db`, Prisma) so restarts cannot re-spam.

### Welcome and goodbye

Requires **Server Members Intent** in the Discord Developer Portal (Bot → Privileged Gateway Intents).

| Event | Message                                                                                                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------ |
| Join  | `🍪 Hey @user! Welcome to the dark side, we have cookies. I’m Dzbanek — grab one, say hi, and don’t mind the crumbs. 😈` |
| Leave | `👋 name just left the kitchen. Hasta la vista, baby! 🕶️🍪 We’ll keep a cookie warm in case they come back.`             |

### Multi-server

Music and radio already work per guild. Deals and greetings are configured per server:

| Command                                        | Description                             |
| ---------------------------------------------- | --------------------------------------- |
| `/setup steam <channel>`                       | Where Steam deals post (Manage Server). |
| `/setup epic <channel>`                        | Where Epic free games post.             |
| `/setup welcome <channel>`                     | Where join messages post.               |
| `/setup goodbye <channel>`                     | Where leave messages post.              |
| `/setup status`                                | Show this server’s channels.            |
| `/setup disable steam\|epic\|welcome\|goodbye` | Stop that feed or greeting here.        |

If you never run `/setup`, the bot looks for a text channel named like `#steam`, `#deals`, `#epic`, `#free-games`, `#welcome`, or `#goodbye`. The `channelId` values in `config.json` only seed the server that actually owns those channels.

---

## Prerequisites

- **Node.js ≥ 22.12**
- **FFmpeg** — bundled via `ffmpeg-static` (a system `ffmpeg` on your `PATH` still works)
- **Deno** on your `PATH` (`deno --version` should work) — yt-dlp uses it to solve YouTube player JS so audio URLs do not 403
- A Discord bot token from the [Discord Developer Portal](https://discord.com/developers/applications)
- A home PC or VPS (YouTube often blocks datacenter IPs)

### Bot permissions

OAuth2 scopes: `bot`, `applications.commands`

Privileged intent: **Server Members Intent** (welcome / goodbye).

| Feature         | Permissions                                                              |
| --------------- | ------------------------------------------------------------------------ |
| Music / Radio   | Connect, Speak, View Channel                                             |
| Steam / Epic    | View Channel, Send Messages, Embed Links, Manage Messages, Add Reactions |
| Welcome / leave | View Channel, Send Messages                                              |

**Manage Messages** is required so the bot can delete its own previous Now Playing / digest cards.

---

## Setup

```bash
# 1. Install dependencies (yt-dlp binary, ffmpeg-static, Prisma client)
npm install
npx prisma db push

# 2. Create your .env file
cp .env.example .env
# Edit .env and set:  DISCORD_TOKEN=your_token_here

# 3. Fill in src/config/config.json
#    - discord.clientId  = Application ID from the Developer Portal
#    - discord.guildId   = your server ID for instant command deploy (or null for global)
#    - steam.channelId / epic.channelId = optional legacy channel IDs
#      (seed that one server; other servers use /setup or auto-detect)

# 4. Register slash commands
npm run deploy

# 5. Start the bot
npm run dev       # development — auto-reloads on file changes
npm start         # production
```

`config.json` has `"guildId": null` by default, so `npm run deploy` registers **global** commands (can take up to about an hour to show in Discord). Set `discord.guildId` to your server ID for instant guild commands.

### Optional Spotify

Create an app at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) and set in `.env`:

```
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
```

Without these, Spotify **playlists and albums** cannot be resolved. Single-track links fall back to a YouTube search.

### Optional YouTube cookies

If yt-dlp hits an age gate or bot check, export Netscape `cookies.txt` from a logged-in browser, base64-encode it, and set:

```
YTDLP_COOKIES_BASE64=...
```

---

## Configuration

Non-secret settings live in `src/config/config.json`. The only required secret is `DISCORD_TOKEN`.

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

Cron expressions use `timezone` (Europe/Prague). `postOnFirstRun` controls whether the first poll after startup may post.

---

## Project structure

```
src/
  index.ts                 Composition root — music, radio, deals, cron
  deploy-commands.ts       One-shot slash command registration
  config/                  Typed config loader (config.json + DISCORD_TOKEN)
  core/                    Client, logger, types, embeds, Components v2 cards
  commands/
    admin/setup.ts         Per-server deal + greeting channels
    music/                 One file per music slash command
    radio.ts               /radio play and /radio stop
  events/                  ready, interactions, member join/leave
  greetings/               Welcome / goodbye copy and channel resolve
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

## Scripts

| Script              | What it does                                        |
| ------------------- | --------------------------------------------------- |
| `npm run dev`       | Run with auto-reload (`tsx watch`).                 |
| `npm start`         | Run the bot.                                        |
| `npm run deploy`    | Register slash commands with Discord.               |
| `npm run db:push`   | Create/update `data/bot.db` from the Prisma schema. |
| `npm run typecheck` | Type-check with `tsc --noEmit`.                     |
| `npm run lint`      | Lint with ESLint.                                   |
| `npm run format`    | Format with Prettier.                               |

---

## Troubleshooting

| Problem                                  | Fix                                                                                                                           |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Song won't play / "Could not load track" | Update yt-dlp: delete `node_modules/youtube-dl-exec` and reinstall. Set `YTDLP_COOKIES_BASE64` if YouTube bot-checks you.     |
| No audio                                 | Confirm `ffmpeg-static` installed with `npm install`, and that the bot has Connect + Speak.                                   |
| Slash commands missing                   | Run `npm run deploy`. Guild commands appear instantly; global takes ~1 h. Restart the Discord client if the picker is stale.  |
| `/radio` missing the station option      | Deploy again after pulling. Type `/radio` then pick **play** and a station.                                                   |
| Radio Beat shows a show name, not a song | Beat often does not publish per-track metadata (especially during shows). The card follows the official “Právě v éteru” feed. |
| Steam / Epic not posting                 | Confirm the channel (`/setup status`), bot permissions, and that there are _new_ items (already-seen IDs stay silent).        |
| Welcome / goodbye silent                 | Enable **Server Members Intent**, then `/setup welcome` / `/setup goodbye`.                                                   |
| Can't delete previous message            | Grant **Manage Messages**.                                                                                                    |

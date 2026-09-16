# dzbanek-bot 2.0

A Discord bot built with **TypeScript** and **discord.js v14**. It plays YouTube and Spotify audio in voice channels, and posts Steam daily deals plus Epic Games free games — with a strict no-duplicate rule so unchanged lineups stay silent.

Music and deal-fetching are separate modules. Embeds follow the same visual structure as [dzbanek-bot](https://github.com/KingVojtas/dzbanek-bot).

---

## Features

### Music player

Play audio from YouTube (URL or search) and Spotify (track / album / playlist). Spotify is metadata-only; audio is resolved on YouTube.

Whenever a new song starts, the previous **Now Playing** embed is deleted and a fresh one is posted so the chat never stacks player messages.

| Command | Description |
| --- | --- |
| `/play <query>` | Join your voice channel and play a track (or add it to the queue). Optional `play_next`. |
| `/skip` | Skip the current track. |
| `/queue` | Show the current queue (paginated). |
| `/stop` | Stop playback, clear the queue, delete the Now Playing embed, and leave. |
| `/pause` / `/resume` | Pause or resume playback. |
| `/nowplaying` | Show the current track. |
| `/shuffle` | Shuffle the upcoming queue. |
| `/loop` | `off`, `track`, or `queue`. |
| `/remove <position>` | Drop a track from the upcoming queue (1-based). |

Idle auto-disconnect after 120 seconds of silence (configurable).

### Steam daily deals

Every day (default **03:33**) the bot fetches Steam discounts from [game-deals.app](https://game-deals.app), keeps games rated *Very Positive* or better, and posts a digest of **new** deals only.

If every deal was already posted, or none pass the review filter, **no message is sent**.

### Epic Games free games

Polls the Epic Store free-games API (default **12:00** and **17:00**). Posts the current + upcoming lineup only when it changed. Same lineup as last time → **silence**.

Both fetchers persist posted IDs / lineup fingerprints in `data/` so restarts cannot re-spam.

---

## Prerequisites

- **Node.js ≥ 22.12**
- **FFmpeg** on your `PATH` (`ffmpeg -version` should work)
- **Deno** on your `PATH` (`deno --version` should work) — yt-dlp uses it to solve YouTube player JS so audio URLs do not 403
- A Discord bot token from the [Discord Developer Portal](https://discord.com/developers/applications)
- A home PC or VPS (YouTube often blocks datacenter IPs)

### Bot permissions

OAuth2 scopes: `bot`, `applications.commands`

| Feature | Permissions |
| --- | --- |
| Music | Connect, Speak |
| Steam / Epic | View Channel, Send Messages, Embed Links, Manage Messages |

**Manage Messages** is required so the bot can delete its own previous Now Playing / digest embeds.

---

## Setup

```bash
# 1. Install dependencies (also downloads the yt-dlp binary)
npm install

# 2. Create your .env file
cp .env.example .env
# Edit .env and set:  DISCORD_TOKEN=your_token_here

# 3. Fill in src/config/config.json
#    - discord.clientId  = Application ID from the Developer Portal
#    - discord.guildId   = your server ID for instant command deploy (or null for global)
#    - steam.channelId / epic.channelId = text channel IDs (leave empty to disable)

# 4. Register slash commands
npm run deploy

# 5. Start the bot
npm run dev       # development — auto-reloads on file changes
npm start         # production
```

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
  "embedColor": "#5865F2"
}
```

Steam prices use the German storefront (`cc=de` → EUR) in `src/deals/steam/SteamPriceApi.ts`. Review threshold is Very Positive (`score ≥ 8` or ≥ 80% positive, ≥ 10 reviews) in `SteamReviewApi.ts`.

---

## Project structure

```
src/
  index.ts                 Composition root — wires music + deals + cron
  deploy-commands.ts       One-shot slash command registration
  config/                  Typed config loader (config.json + DISCORD_TOKEN)
  core/                    Client, logger, types, embed factories
  commands/music/          One file per slash command
  events/                  ready + interactionCreate
  music/                   Voice, queue, Now Playing, YouTube + Spotify sources
  deals/
    seen-store.ts          Persistent JSON ID store
    steam/                 RSS + reviews + prices + digest
    epic/                  Free-games API + digest
data/                      Runtime state (git-ignored)
```

---

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Run with auto-reload (`tsx watch`). |
| `npm start` | Run the bot. |
| `npm run deploy` | Register slash commands with Discord. |
| `npm run typecheck` | Type-check with `tsc --noEmit`. |
| `npm run lint` | Lint with ESLint. |
| `npm run format` | Format with Prettier. |

---

## Troubleshooting

| Problem | Fix |
| --- | --- |
| Song won't play / "Could not load track" | Update yt-dlp: delete `node_modules/youtube-dl-exec` and reinstall. Set `YTDLP_COOKIES_BASE64` if YouTube bot-checks you. |
| No audio | Check `ffmpeg -version` and that the bot has Connect + Speak. |
| Slash commands missing | Run `npm run deploy`. Guild commands appear instantly; global takes ~1 h. |
| Steam / Epic not posting | Confirm the channel ID, bot permissions, and that there are *new* items (already-seen IDs stay silent). |
| Can't delete previous message | Grant **Manage Messages**. |

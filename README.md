# 🍪 Dzbanek-bot 2.0

A TypeScript Discord bot (discord.js v14) for the kitchen. It plays YouTube and Spotify in voice, streams live radio from Prague, London, and California, runs the kitchen’s own station with an AI DJ who knows who brought each song, posts Steam deals and Epic free games, and keeps a cookie warm for anyone who walks in.

Music and radio share one voice slot per server. Starting one takes the speaker from the other.

---

## ✨ What’s cooking

### 🎵 Music

Play from YouTube (a link or a search) and from Spotify (track, album, or playlist). Spotify is the recipe card. The audio comes from YouTube via yt-dlp.

It is quick about it. A search reads only YouTube’s result list, about 2 s instead of 6. A YouTube link starts downloading while its title is still being read. A Spotify album or playlist starts its first song as soon as that one is found, and the rest join the queue in order while you listen. Anything played in the last 6 hours resolves instantly.

Now Playing is an embed card: the artist, the video art, a progress bar, when the song ends (a live countdown), the next track by name, the volume, and transport buttons. It goes grey while paused. When the next track starts, the previous card is cleared so the chat stays tidy. `/queue` shows the total running time and who asked for each song.

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

`/radio play` joins **your** voice channel and streams one of seven live stations: four Czech, two from London, and Radio Paradise from California. The card wears the station logo and brand color. It names the song and artist on air, shows the album cover when the station sends one, the voice channel, and when the song came on. Metadata is checked about every **20 seconds**, and the **same message** is edited when the song changes.

| Choice            | Station        | Stream                                            |
| ----------------- | -------------- | ------------------------------------------------- |
| 💋 Kiss           | Kiss Radio     | `https://icecast4.play.cz/kiss128.mp3`            |
| 🎸 Rock Radio     | Rock Radio     | `http://ice.abradio.cz/rockradio128.mp3`          |
| 🥁 Radio Beat     | Radio Beat     | `https://icecast3.play.cz/radiobeat128.mp3`       |
| 1️⃣ Frekvence 1    | Frekvence 1    | `https://ice.actve.net/fm-frekvence1-128`         |
| ❤️ Heart London   | Heart London   | `https://media-ssl.musicradio.com/HeartLondonMP3` |
| 🎤 Capital London | Capital London | `https://media-ssl.musicradio.com/CapitalMP3`     |
| 🌴 Radio Paradise | Radio Paradise | `https://stream.radioparadise.com/mp3-128`        |

Now-playing sources stay off the FFmpeg voice stream:

- **Kiss / Rock Radio** — [radia.cz](https://radia.cz) `songs/now.json`, then Icecast ICY `StreamTitle`
- **Radio Beat** — Beat’s own `?do=broadcast-update` (“Právě v éteru”), then radia.cz while the listing is still fresh, then ICY
- **Frekvence 1** — Triton Digital’s public now-playing feed (mount `FREKVENCE1`). Its stream sends no ICY title.
- **Radio Paradise** — ICY `StreamTitle`, and the album cover from ICY `StreamUrl`
- **Heart / Capital London** — ICY `StreamTitle`. Global often sends it blank, so these cards may show only the station, and Catch waits.

Beat often sends only a station tag over Icecast. During shows such as **Hard & Heavy**, the site publishes the program name. That is what the card shows. 🍪 Catch will smile and refuse it: a show is not a song.

| Command                 | What it does                                                          |
| ----------------------- | --------------------------------------------------------------------- |
| `/radio play <station>` | Join your channel and start one of the seven stations, or Kitchen FM. |
| `/radio stop`           | Stop the stream, leave voice, and delete the radio card.              |
| `/radio night`          | Schedule Friday 20:00 Radio Night in a voice channel.                 |
| `/radio night-off`      | Cancel scheduled Radio Night.                                         |
| `/radio dedicate`       | Send a short dedication. The DJ on Kitchen FM reads it aloud.         |

The card has **🍪 Catch**, **⏹️ Stop**, and **🌐 Website**. Catch is greyed out while nothing is on air. Stop wants you in the bot’s voice channel. Catch saves the artist and title for you. The reply grows a **Play** button, which finds that song on YouTube and queues it the same way `/play` does. The Kitchen Board keeps the server’s latest catch, and only the person who saved it can press Play there.

Radio stays up. It does not wander off during a quiet stretch. Switching stations reuses the same connection and retires the previous card.

A restart puts that station back on if idle-radio is still on and people are still in the voice channel. `/radio stop` clears the channel, so a restart after a stop stays quiet. The first boot after this change has no channel saved yet, so `/radio play` is needed once.

### 🍪 The Kitchen Board

`/setup kitchen` hangs one living message and keeps editing it. Three cards stack in that message:

- **The stereo**, in the color of what’s playing. Radio shows a 🔴 LIVE badge with the station’s slogan, the song and artist, the album cover (or the station logo), and who’s listening, with **🍪 Catch**, **⏹️ Stop**, and **🌐 Website**. Music shows the video art as a banner, the length, who asked for it, and how many are up next, with **Pause / Resume**, **Skip**, **Queue**, and **Stop** right on the board. When nothing is on, the kitchen photo hangs there instead.
- **The Pantry**, in amber. The Steam deal of the day with its cover, `−75%` chip, struck price, what you save, Steam’s review label, and a countdown to the end of the sale, plus how many more wait in the Steam channel. Under it, this week’s Epic freebie with its countdown, or the next one when nothing is free.
- **The room**, when there’s news: the latest catch with its cover and a **▶️ Play it** button, today’s cookies, Radio Night, and who is chef of the week so far when anyone has points. Friday from **12:00 to 20:00** the vote sits here, with tally bars, a 👑 for the leader, a live countdown to 20:00, and a button for each station (💋 🎸 🥁 1️⃣ ❤️ 🎤 🌴) that shows the count.

The last card is always a small 💛 Thanks to **Sunka**.

Discord presence is the well. Each hour in Europe/Prague the three lines play once, twenty minutes each, in a new order: Purifying the source, Analyzing bacteria levels, Pouring fresh drops.

On Sunday at **18:00 Europe/Prague** the kitchen channel gets one postcard for the week 📬, with the kitchen photo on top: the songs people caught, with 🥇🥈🥉 and who caught them, Friday’s Radio Night tally and winner when anyone voted, the quiz champion, Chef of the week, and the 🔥 song of the week. The living board stays the live stereo. Its room card names the chef so far.

### 🎁 Kitchen Wrapped

On the **1st** at **18:00 Europe/Prague** every kitchen channel gets last month: songs and hours, the top songs, who brought the most, the favourite genre, the 🔥 song, the quiz champion, the station people caught most, and new finds a 🔥 kept. On **1 January** the year is posted right after the month. `/setup wrapped-preview` shows the month so far, only to you. The first month can say “since 27 October” when the log starts after the 1st.

### 🌙 Radio Night

`/radio night` (Manage Server) picks a voice channel and a fallback station. On Friday from **12:00 to 20:00 Europe/Prague** the Kitchen Board puts out a vote button for each station, five to a row. One vote per person, and you can change your mind. At **20:00** the winner starts in that channel. A tie falls through the scheduled station, then the last station that played, then Beat. `/radio night-off` takes it off the calendar.

### 🎙️ Kitchen FM

The kitchen’s own station. `/radio play station:Kitchen FM` joins your voice channel and plays the kitchen’s songs (every track the server `/play`ed and every 🍪 catch). It does this for free: no API key.

The show is **genre blocks** of ten songs: two sets of five. The opening block is shorter, one set of five. The station learns what the server likes from its `/play` history and plays one genre, then moves on. The favourite, often Czech rap, comes up most often. The DJ talks once, before each set: the time, the genre, the first song, and who brought it in. For example: “It’s 6 PM and The Kitchen is open. For the next few songs it’s Czech rap, starting with Numb by Linkin Park. Brought in by Vojta.” Then the songs play back to back. Someone who walked in during the last set gets a welcome.

- **Genres** come from Deezer and MusicBrainz, both free and keyless. Deezer’s album genre plus the artist’s country decide the shelf: rap from Czechia or Slovakia is Czech rap, Dance and Electro are EDM, and so on. The result is cached in `data/fm-genres.json`, which deploys leave in place. Blocks start once 30 songs have a genre, or 60% of the kitchen. Until then the station plays themed sets: someone’s picks, radio catches, throwbacks, what’s fresh, or a bit of everything.
- **The DJ’s words** are a line book, `src/fm/lines/en.json` and `cs.json`. The bot only fills in the time, the genre, the song, and the name. It does not call an AI to write them. A line is not repeated in the same show while unused ones remain. From midnight to 5 AM a new block gets a quieter line.
- **New finds** are songs the kitchen has not played. The first set of a show is only songs the kitchen already has, so it starts straight away. From the second set, the station asks Deezer for artists related to the ones in the block, takes one of their top tracks, and plays it from YouTube only when the upload is that song and at most 12 minutes. A themed set, before genres are known, does the same from the second set on, using every kitchen song that has a Deezer artist. A set aims for five songs and fills with finds when the kitchen runs short. Songs under a minute are left out, and a song does not come back while another is waiting. The card says `Czech rap · new find`.
- **A small kitchen** (fewer than 10 songs) plays its own songs in the first set, then sets of new finds from similar artists, so a few songs never loop.
- **The voice** is a Microsoft Edge read-aloud voice: free, no key. Edge returns MP3, and FFmpeg decodes it to audio the same way the radio plays, so the DJ is heard in voice. Microsoft changes that service now and then. When it fails, the line still shows on the card and the music carries on.
- **The card**: Now Playing turns into 🎙️ Kitchen FM with the block’s genre. The DJ’s line sits under the progress bar, and Up next names the station’s next song. While the show is on, the card also has **🔥** and **👎**.
- **Dedications.** `/radio dedicate` sends a short message (120 characters) while Kitchen FM is on and you are in its voice channel. The DJ reads it before the next song, or before a song you named. One dedication per person can be waiting, and three per server. Anything still unread is dropped when the show ends.
- **🔥 and 👎.** Anyone in the voice channel can react, once per song: press again to take it back, or press the other one to switch. 🔥 on a new find keeps it as a kitchen song, credited to the first person who did. 🔥 on a kitchen song makes the station pick it a bit more often. 👎 on a new find means it is never suggested again. 👎 on a kitchen song leaves it out of sets while the 👎s outnumber the 🔥s. `/play` can still play that song. The set already on air is left as it is.

`/play` requests go first, and the set carries on after them. ⏭️ Skip while the DJ talks cuts the talk and starts the song. `/stop` or `/radio stop` ends the show. The next set is planned while the current set’s last song plays, so there is no dead air. A set that waits more than 20 minutes behind requests is planned again, since its line names the time. When the voice channel empties, the show ends after the idle timeout. Kitchen FM needs at least 3 kitchen songs.

| `config.json` → `dj` | Default                          | What it does                                                   |
| -------------------- | -------------------------------- | -------------------------------------------------------------- |
| `language`           | `en`                             | `en` or `cs`. The line book and the genre names follow it.     |
| `voice`              | `en-US-AndrewMultilingualNeural` | Any Edge voice. `cs-CZ-VlastaNeural` speaks Czech.             |
| `model`              | `claude-opus-5-5`                | Unused once genres are known. See the optional key below.      |
| `discover`           | `2`                              | New finds per set, 0 to 3. A short kitchen gets more, up to 3. |
| `blockSets`          | `2`                              | Sets per genre block after the opener, from 1 to 4.            |

### 🎧 Kitchen Quiz

Name that tune, in voice, using the kitchen’s own music. `/quiz start` joins your voice channel and takes the speaker, as radio does. A lobby card counts down 20 seconds (or press **Start now**). Each round plays 15 seconds from the middle of a song, and the card offers four titles as buttons. Only people in the quiz’s voice channel can answer, once each per round.

- **Points:** 100 for the right song, up to 50 more for speed (falling over the 20-second window), and 25 extra on every third right answer in a row.
- **Reveal:** the right button turns green. The card shows the song’s art and artist, who brought the song to the kitchen (their `/play` or their 🍪 catch), the fastest right answer, and the top three. The round closes early once everyone in voice has answered.
- **Podium:** 🥇🥈🥉 with scores, right answers, and each player’s fastest time, plus **Play again**. The Sunday postcard names the week’s quiz champion.

The songs are every track the server `/play`ed (remembered from now on, newest 500) plus every radio catch. With `playlist:`, a YouTube or Spotify playlist or album is the pool instead. The quiz needs at least 4 songs. Clips are cut while the previous round plays, and an unplayable song is swapped for another. `/play` and `/radio play` wait until `/quiz stop` or the end of the game, and Radio Night skips its slot while a quiz holds the speaker.

| Command                           | What it does                                                     |
| --------------------------------- | ---------------------------------------------------------------- |
| `/quiz start [rounds] [playlist]` | Start a quiz in your voice channel (5–20 rounds, 10 by default). |
| `/quiz stop`                      | End it now and show the podium.                                  |

### 💸 Steam daily deals

Every day at **03:33 Europe/Prague** Dzbanek reads Steam discounts from [game-deals.app](https://game-deals.app) and the current Steam specials list, then posts a fresh **10-game** digest in every server that has a Steam channel.

Very Positive games (score ≥ 8, or ≥ 80% positive with at least 10 reviews) sit at the top, deepest discount first. When the curated feed is shorter than 10, current Steam specials fill the empty seats — deepest discount, then the most reviews. Prices use the German storefront (`cc=de` → EUR).

The card has no header and no banner: just ten numbered rows. Each row shows the game’s box art, the `−75%` chip, the struck and current price, a one-line description from the Steam store, then a quiet line with the game’s style (up to three tags, e.g. Action, Shooter, Open World), Steam’s review label for well-reviewed games, and when the sale ends. A single footer line names the day and has an **All specials** button. Art that Discord can’t load is left out, and a row without art gets a **Store** button instead. Near Discord’s text limit the descriptions shorten first, then go, then the tags. Every row stays.

The same 10-game lineup is remembered per server. A repeat stays in the pot. An empty feed stays quiet too. Before the ten are picked, every game is checked against Steam’s own price, so a sale the feed still lists after it ended is left out.

### 🎯 Wishlist Radar

Link your Steam profile once, and Dzbanek watches your Steam wishlist. Each morning after the digest, the wishlist channel gets a radar card if anything you wished for went on sale. It pings only the people with something new. The channel is set with `/setup wishlist`. Without that, it uses the server’s channel from `wishlist.channelIds` in `config.json`, then the Steam channel.

- **🤝 Wanted together** lists games that two or more people in the server wishlisted, with their art, the price, and who wants them. Buy them together.
- **🎯 For @you** lists your own hits, deepest discount first, with the price and when the sale ends.
- A digest row that someone wishlisted gets a quiet `👀 @name` line. That one doesn’t ping.

Each hit is announced once per discount. A game that drops from −50 % to −75 % pings again, and an unchanged sale stays quiet. A restart doesn’t repeat anything.

| Command                 | What it does                                                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `/steam link <profile>` | Link your Steam profile (link, custom name, or 17-digit ID).                                                                              |
| `/steam wishlist`       | See, privately, your whole wishlist with prices: sales first with the struck price, then full price, free, coming soon. Ten games a page. |
| `/steam unlink`         | Stop watching your wishlist.                                                                                                              |

The wishlist has to be public: Steam → Edit Profile → Privacy Settings → **Game details: Public**. No Steam API key is needed. The link is stored per Discord user, so it works in every server the bot shares with you.

### 🎁 Epic free games

The Epic Store is checked at **12:00** and **17:00 Europe/Prague**, when the weekly free lineup usually turns over. Each server hears about a lineup once. The 03:33 slot belongs to Steam.

The card opens with a gallery of this week’s free games. Under it, each game gets a row with its box art, **🆓 FREE** over the struck store price, and a live countdown to when it stops being free. The first game also shows its blurb and publisher. The card adds up what the week’s games are worth and carries a **Claim** button for each game, plus **All free games**. A grey **Coming next** card follows, with when each upcoming game unlocks.

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
| `/setup wrapped-preview`     | This month’s Kitchen Wrapped so far, only for you.                 |
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

| Feature            | Permissions                                                                   |
| ------------------ | ----------------------------------------------------------------------------- |
| 🎵 Music / Radio   | Connect, Speak, View Channel                                                  |
| 💸 Steam / Epic    | View Channel, Send Messages, Embed Links, Read Message History, Add Reactions |
| 🍪 Kitchen Board   | View Channel, Send Messages, Attach Files, Read Message History               |
| 👋 Welcome / leave | View Channel, Send Messages                                                   |
| 🚪 Rooms           | Manage Channels                                                               |

The install link asks for exactly these: permissions `3263568` (`INSTALL_PERMISSIONS` in `src/core/links.ts`). **Read Message History** lets Dzbanek find its own Kitchen Board and last digest after a restart. It clears its old cards without Manage Messages: a bot may always delete its own messages.

When Dzbanek joins a server, it posts one hello card in the system channel (or the first text channel it can write in) with the first commands to try, and logs the join.

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

Or save the file as `secrets/yt-cookies.txt`. The folder is gitignored, and `/update-dzbanek` ships it with each upload, so the server's `.env` stays untouched. The env var wins when both are set. Export from a private window and close it right after, or YouTube rotates the session and the cookies die within hours. A spare Google account is safer than your own.

The bot copies the export to `data/yt-cookies.txt`, where yt-dlp saves the cookies YouTube refreshes. Restarts keep that copy; a new export replaces it on the next deploy.

After every boot and after the 04:15 yt-dlp update, the bot checks one short YouTube video. When the check meets a bot check, the bot's owner (from the Developer Portal) gets one DM asking for fresh cookies, and another once YouTube works again. The log line `YouTube alerts DM <name>` says who that is.

While YouTube blocks a song, the bot looks for the same song on SoundCloud and plays it from there. A match needs the song name in its title and about the same length. Previews and remixes don't count.

### 🎙️ Optional Anthropic API key (Kitchen FM’s DJ)

Create a key at [platform.claude.com](https://platform.claude.com) and set:

```
ANTHROPIC_API_KEY=...
```

Or save the key alone in `secrets/anthropic-api-key.txt`. `/update-dzbanek` ships it the same way as the cookies, so the server's `.env` stays untouched. The env var wins when both are set. Kitchen FM does not need it. The free DJ, the line book, and the genre blocks run with no key. A key is used only while the genre cache is still too thin to start blocks, and only to plan those early sets.

Each server gets at most `dj.setsPerServerPerDay` sets planned by Claude a day (default 20), and all servers together `dj.setsPerDay` (default 100). Past either, the station plans its own sets until midnight, the same as without a key, and the log says so once. The count lives in memory, so a restart starts the day over. Set either to 0 to keep Claude out.

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
    "maxQueueSize": 100,
    "youtubeClients": "",
    "clientBenchmark": false
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
  "dj": {
    "language": "en",
    "voice": "en-US-AndrewMultilingualNeural",
    "model": "claude-opus-5-5",
    "discover": 2,
    "blockSets": 2,
    "setsPerServerPerDay": 20,
    "setsPerDay": 100
  },
  "embedColor": "#5865F2"
}
```

Cron expressions use `timezone` (Europe/Prague). `postOnFirstRun` decides whether the first poll after startup may post.

`music.youtubeClients` lists the YouTube player clients a stream asks for, comma-separated, the same way as yt-dlp's `player_client`. Empty, which is the default, means `android_vr,tv_simply,mweb,web,web_embedded`. When the list is different and a song fails without a bot check, the bot tries that song once with the default list and logs the first retry of each hour.

`music.clientBenchmark` is false unless you turn it on. On a boot where the YouTube check passed, the bot waits 30 seconds and then times a few client lists for real: two starts on the check's short video and two on one music video, one start at a time, 20 seconds apart. It logs the fastest list that worked all four times; a bot check stops the rest, and this copy going idle stops the run between starts.

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
  kitchen/                 Kitchen Board, Radio Night, Wrapped, catches, presence
  music/                   Voice queue, Now Playing, YouTube + Spotify
  radio/                   Icecast session, station catalog, now-playing poll
  fm/                      Kitchen FM: genre blocks, the line book, Deezer, MusicBrainz, voice (Edge)
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

| What happened                            | What to try                                                                                                                                                                                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Song won't play / "Could not load track" | yt-dlp updates itself at startup and daily at 04:15. If it is still stuck, delete `node_modules/youtube-dl-exec` and reinstall. If YouTube asks you to prove you’re human, put a fresh cookies export in `secrets/yt-cookies.txt` (or `YTDLP_COOKIES_BASE64`) and deploy. |
| No audio                                 | Confirm `ffmpeg-static` came in with `npm install`, and that the bot has Connect + Speak.                                                                                                                                                                                 |
| Slash commands missing                   | Run `npm run deploy`. The two kitchen servers update immediately. Other servers can take about an hour. Restart Discord if the picker is stale.                                                                                                                           |
| `/radio` is missing the station option   | Deploy again after pulling. Type `/radio`, then pick **play** and a station.                                                                                                                                                                                              |
| Radio Beat shows a show name             | During a program, Beat publishes the show. The card follows “Právě v éteru”. Catch waits for a real song.                                                                                                                                                                 |
| Steam / Epic stayed quiet                | Check `/setup status` and the bot’s permissions. An unchanged lineup stays in the pot.                                                                                                                                                                                    |
| Welcome / goodbye stayed quiet           | Enable **Server Members Intent**, then `/setup welcome` and `/setup goodbye`.                                                                                                                                                                                             |
| An old card is stuck                     | Grant **Manage Messages** so Dzbanek can clear the previous one.                                                                                                                                                                                                          |

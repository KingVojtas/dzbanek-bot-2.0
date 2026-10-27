# Listing Dzbanek

Texts to paste into bot lists (top.gg, discordbotlist.com) and into Discord's verification form. The bot speaks English, so the listing does too. Radio, Kitchen FM, the quiz and the deals lead; YouTube playback is a feature, not the headline.

## Links

- Invite: https://discord.com/oauth2/authorize?client_id=923262419923513445&permissions=3263568&scope=bot%20applications.commands
- Website: https://kingvojtas.github.io/dzbanek-bot-website/
- Privacy policy: https://kingvojtas.github.io/dzbanek-bot-website/privacy.html
- Terms: https://kingvojtas.github.io/dzbanek-bot-website/terms.html
- Prefix: none, slash commands only (`/help`)

## Short description

> Live radio, your server's own station with a DJ, a song quiz, and daily Steam & Epic deals. 🍪

(93 characters.)

## Tags

Music, Fun, Game, Utility

## Long description

```md
# 🍪 Dzbanek — the kitchen's stereo

Dzbanek turns any voice channel into a kitchen radio. It calls every server a kitchen.

## 📻 Live radio

Seven stations, live: Kiss, Rock Radio, Radio Beat and Frekvence 1 from Czechia, Heart and Capital from London, and Radio Paradise from California. Every card shows the song on air, its cover and who's listening. Press **🍪 Catch** to save the song and play it later.

## 🎙️ Kitchen FM, your own station

`/radio play station:Kitchen FM` plays your server's own songs, everything you've `/play`ed and caught, in genre blocks, with a DJ who talks between sets and reads your dedications (`/radio dedicate`). Press 🔥 or 👎 on a song and the station learns what you like. On the 1st of each month, **Kitchen Wrapped** sums up your server's month in songs.

## 🎧 Kitchen Quiz

`/quiz` plays clips of your server's songs. Guess fast, keep a streak, and win the week.

## 💸 Deals

The Steam deal of the day, Epic's free games, and **Wishlist Radar**: link your Steam wishlist and Dzbanek pings you when a game on it goes on sale, and shows the games two or more of you want.

## 🍪 Kitchen Board

One live card in a channel you pick: what's playing, today's deals, the latest catch, Friday's Radio Night vote, and the Chef of the week.

## 🎵 And music

`/play` a song name or a YouTube or Spotify link, with a queue, loop, shuffle and volume.

Slash commands only. `/help` lists them all.
```

## Discord verification

Discord asks for these once the bot nears 100 servers. Verification also needs the owner's identity check and two-factor login on the Developer Portal account. Only the owner can do those.

**Privileged intents.** The bot uses one: **Server Members**. It does not use Message Content or Presence.

Answer for "Why do you need the Server Members intent?":

> Dzbanek posts welcome and goodbye messages when members join or leave a server (GUILD_MEMBER_ADD and GUILD_MEMBER_REMOVE), counts the day's arrivals on its Kitchen Board, and looks up members' display names for its music cards, its radio DJ's shout-outs and its Steam wishlist notices. It stores no member lists; the only member data it keeps is a Discord user ID next to things a person did on purpose, such as a song they requested or a Steam account they linked.

**Data and third parties** are listed on the privacy page above. When Kitchen FM can't build a set from its genre blocks or new finds, and an Anthropic API key is set, the DJ asks Claude to plan one. That call sends the server name, the time, listeners' and newcomers' display names, and song titles with who brought them, at most 20 sets per server a day and 100 in total (`dj.setsPerServerPerDay`, `dj.setsPerDay`). The live bot has no key today, so it makes no such calls.

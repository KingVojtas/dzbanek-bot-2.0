import { EmbedBuilder, type EmbedAuthorOptions } from 'discord.js';

/** Kitchen amber, same warmth as the quiet Kitchen Board. */
const WELCOME_COLOR = 0xc4783a;
/** Dusk brown for a leave. */
const GOODBYE_COLOR = 0x6e5846;

export interface GreetingPerson {
  name: string;
  /** Welcome pings them. Leave cards omit this. */
  mention?: string;
  avatarUrl?: string | null;
  createdTimestamp?: number | null;
  joinedTimestamp?: number | null;
}

export interface GreetingPlace {
  name: string;
  iconUrl?: string | null;
  memberCount: number;
}

export function buildWelcomeEmbed(person: GreetingPerson, place: GreetingPlace): EmbedBuilder {
  const name = cardName(person.name);
  const embed = new EmbedBuilder()
    .setColor(WELCOME_COLOR)
    .setAuthor(author(place))
    .setTitle(`Welcome, ${name}`.slice(0, 256))
    .setDescription(
      `🍪 Hey ${person.mention ?? cardName(person.name)}! Welcome to the dark side, we have cookies.\n` +
        `I’m Dzbanek — grab one, say hi, and don’t mind the crumbs. 😈`,
    )
    .addFields(
      stats(
        { name: 'In the kitchen', value: headcount(place.memberCount) },
        person.createdTimestamp
          ? { name: 'Joined Discord', value: discordWhen(person.createdTimestamp) }
          : null,
      ),
    )
    .setFooter({ text: 'Grab a seat' })
    .setTimestamp();

  const avatar = httpUrl(person.avatarUrl);
  if (avatar) embed.setThumbnail(avatar);
  return embed;
}

export function buildGoodbyeEmbed(person: GreetingPerson, place: GreetingPlace): EmbedBuilder {
  const name = cardName(person.name);
  const embed = new EmbedBuilder()
    .setColor(GOODBYE_COLOR)
    .setAuthor(author(place))
    .setTitle(`${name} left the kitchen`.slice(0, 256))
    .setDescription(
      `👋 Hasta la vista, baby! 🕶️🍪\nWe’ll keep a cookie warm in case they come back.`,
    )
    .addFields(
      stats(
        { name: 'Still here', value: headcount(place.memberCount) },
        person.joinedTimestamp
          ? { name: 'Sat down', value: discordWhen(person.joinedTimestamp) }
          : null,
      ),
    )
    .setFooter({ text: 'The oven stays on' })
    .setTimestamp();

  const avatar = httpUrl(person.avatarUrl);
  if (avatar) embed.setThumbnail(avatar);
  return embed;
}

function author(place: GreetingPlace): EmbedAuthorOptions {
  const iconURL = httpUrl(place.iconUrl);
  return iconURL
    ? { name: cardName(place.name, 'Kitchen').slice(0, 256), iconURL }
    : { name: cardName(place.name, 'Kitchen').slice(0, 256) };
}

function stats(
  primary: { name: string; value: string },
  secondary: { name: string; value: string } | null,
): { name: string; value: string; inline: boolean }[] {
  if (!secondary) return [{ ...primary, inline: false }];
  return [
    { ...primary, inline: true },
    { ...secondary, inline: true },
  ];
}

function headcount(count: number): string {
  const n = Math.max(0, Math.floor(Number.isFinite(count) ? count : 0));
  const label = n.toLocaleString('en-US');
  return n === 1 ? `**${label}** person` : `**${label}** people`;
}

/** Calendar date plus a relative “3 years ago”, as Discord renders it. */
function discordWhen(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (!Number.isFinite(sec) || sec <= 0) return 'Unknown';
  return `<t:${sec}:D> · <t:${sec}:R>`;
}

function cardName(name: string, fallback = 'Someone'): string {
  const cleaned = name.replace(/\s+/g, ' ').trim();
  return cleaned || fallback;
}

function httpUrl(url: string | null | undefined): string | undefined {
  const trimmed = url?.trim();
  if (!trimmed || !/^https?:\/\//i.test(trimmed)) return undefined;
  return trimmed;
}

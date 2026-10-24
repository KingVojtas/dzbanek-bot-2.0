import {
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  SectionBuilder,
  TextDisplayBuilder,
} from 'discord.js';
import type { EpicFreeGame } from '../types';
import { discordTime, linkText, linked, moneyToCents, plainBlurb, pragueDay } from './text';
import {
  addBlock,
  artSection,
  divider,
  httpImage,
  linkButton,
  linkRow,
  textBlock,
  type V2Display,
} from './v2';

const EPIC_FREE_URL = 'https://store.epicgames.com/en-US/free-games';
const EPIC_COLOR = 0x26bbff;
const EPIC_LATER_COLOR = 0x8b93a7;

/** In the current Epic card's footer. An older card without it is replaced once. */
export const EPIC_SHELF_MARKER = 'Free to keep forever once claimed';

const EPIC_FREE_MAX = 4;
const EPIC_SOON_MAX = 3;

/** Skip a missing or zero store price. Epic still sends "$0.00" for some rows. */
export function epicWorth(price: string | undefined): string {
  const value = price?.replace(/\s+/g, ' ').trim() ?? '';
  if (!value || /^[^0-9]*0+([.,]0+)?$/.test(value)) return '';
  return value;
}

/** "$19.99" + "$24.99" → "$44.98". Empty when the currencies differ or a price is missing. */
function epicWorthTotal(games: EpicFreeGame[]): string {
  const worths = games.map((game) => epicWorth(game.originalPrice));
  if (worths.length < 2 || worths.some((worth) => !worth)) return '';
  const symbols = new Set(worths.map((worth) => worth.replace(/[\d.,\s]/g, '')));
  if (symbols.size !== 1) return '';
  const cents = worths.map(moneyToCents);
  if (cents.some((value) => value == null)) return '';
  const sum = cents.reduce<number>((total, value) => total + (value ?? 0), 0);
  const symbol = [...symbols][0] ?? '';
  const amount = (sum / 100).toFixed(2);
  return worths[0]!.trim().startsWith(symbol) ? `${symbol}${amount}` : `${amount}${symbol}`;
}

/** Title as it appears on the Epic card. Duplicate checks compare against this. */
export function epicGameTitle(game: EpicFreeGame): string {
  return linkText(game.title, 120);
}

/** The games one Epic card names: free ones first, then what comes next. */
export function selectEpicLineup(games: EpicFreeGame[]): EpicFreeGame[] {
  const current = games.filter((g) => !g.isUpcoming).slice(0, EPIC_FREE_MAX);
  const upcoming = games.filter((g) => g.isUpcoming).slice(0, EPIC_SOON_MAX);
  return [...current, ...upcoming];
}

function epicFreeRow(game: EpicFreeGame, lead: boolean): SectionBuilder | TextDisplayBuilder {
  const title = epicGameTitle(game);
  const worth = epicWorth(game.originalPrice);
  const lines = [
    `### ${linked(title, game.storeUrl)}`,
    `**🆓 FREE**${worth ? ` ~~${worth}~~` : ''}`,
  ];
  const endsIn = discordTime(game.endDate, 'R');
  const seller = linkText(game.seller ?? '', 60);
  if (lead) {
    const endsAt = discordTime(game.endDate, 'f');
    if (endsIn) lines.push(`⏳ Free until ${endsAt} · ${endsIn}`);
    const blurb = plainBlurb(game.description, 240);
    if (blurb) lines.push(`> ${blurb}`);
    if (seller) lines.push(`-# by ${seller}`);
  } else {
    const meta = [endsIn ? `⏳ ends ${endsIn}` : '', seller ? `by ${seller}` : '']
      .filter(Boolean)
      .join(' · ');
    if (meta) lines.push(`-# ${meta}`);
  }
  return artSection(lines, httpImage(game.image) ?? httpImage(game.heroImage), title, {
    label: 'Store',
    url: game.storeUrl,
  });
}

function epicSoonRow(game: EpicFreeGame): SectionBuilder | TextDisplayBuilder {
  const title = epicGameTitle(game);
  const worth = epicWorth(game.originalPrice);
  const unlocks = discordTime(game.upcomingStartDate, 'R');
  const from = discordTime(game.upcomingStartDate, 'D');
  const until = discordTime(game.endDate, 'D');
  const lines = [`### ${linked(title, game.storeUrl)}`];
  if (unlocks) lines.push(`🔓 Free ${unlocks}`);
  const meta = [from && until ? `${from} – ${until}` : '', worth ? `worth ${worth}` : '']
    .filter(Boolean)
    .join(' · ');
  if (meta) lines.push(`-# ${meta}`);
  return artSection(lines, httpImage(game.image) ?? httpImage(game.heroImage), title, {
    label: 'Store',
    url: game.storeUrl,
  });
}

/** Wide store art for each game that is free now, as one gallery. */
function epicGallery(games: EpicFreeGame[]): MediaGalleryBuilder | null {
  const gallery = new MediaGalleryBuilder();
  const seen = new Set<string>();
  for (const game of games) {
    const url = httpImage(game.heroImage) ?? httpImage(game.image);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const worth = epicWorth(game.originalPrice);
    gallery.addItems(
      new MediaGalleryItemBuilder()
        .setURL(url)
        .setDescription(
          [game.title, 'free to keep', worth ? `worth ${worth}` : '']
            .filter(Boolean)
            .join(' · ')
            .slice(0, 1024),
        ),
    );
  }
  return seen.size > 0 ? gallery : null;
}

function epicHeader(current: number, upcoming: number): TextDisplayBuilder {
  const bits: string[] = [];
  if (current > 0) bits.push(`${current} free now`);
  if (upcoming > 0) bits.push(`${upcoming} coming next`);
  return textBlock([
    `## 🎁 [Epic Free Games](${EPIC_FREE_URL})`,
    `-# ${[pragueDay(), ...bits].join(' · ')}`,
  ]);
}

function epicFooter(container: ContainerBuilder, current: EpicFreeGame[]): void {
  const total = epicWorthTotal(current);
  container
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(
      textBlock([
        total ? `💰 **${total}** worth of games, yours for nothing this week.` : '',
        `-# 🎁 ${EPIC_SHELF_MARKER} · checked daily at 12:00 and 17:00`,
      ]),
    );
  const buttons = current
    .filter((game) => game.storeUrl && game.storeUrl !== EPIC_FREE_URL)
    .slice(0, 3)
    .map((game) => linkButton(`Claim ${game.title.replace(/\s+/g, ' ').trim()}`, game.storeUrl));
  buttons.push(linkButton('All free games', EPIC_FREE_URL, '🎁'));
  container.addActionRowComponents(linkRow(buttons));
}

/**
 * Epic digest: a gallery of this week's free games, a row for each with its
 * box art and a live countdown, Claim buttons, then a quieter Coming next card.
 */
export function buildEpicFreeGamesDisplay(games: EpicFreeGame[]): V2Display {
  const lineup = selectEpicLineup(games);
  const current = lineup.filter((g) => !g.isUpcoming);
  const upcoming = lineup.filter((g) => g.isUpcoming);
  const components: ContainerBuilder[] = [];

  if (current.length > 0) {
    const free = new ContainerBuilder()
      .setAccentColor(EPIC_COLOR)
      .addTextDisplayComponents(epicHeader(current.length, upcoming.length));
    const gallery = epicGallery(current);
    if (gallery) free.addMediaGalleryComponents(gallery);
    current.forEach((game, i) => addBlock(free, epicFreeRow(game, i === 0)));
    epicFooter(free, current);
    components.push(free);

    if (upcoming.length > 0) {
      const later = new ContainerBuilder()
        .setAccentColor(EPIC_LATER_COLOR)
        .addTextDisplayComponents(textBlock(['### 🔜 Coming next', '-# Set a reminder.']));
      for (const game of upcoming) addBlock(later, epicSoonRow(game));
      components.push(later);
    }
  } else {
    const card = new ContainerBuilder()
      .setAccentColor(upcoming.length > 0 ? EPIC_LATER_COLOR : EPIC_COLOR)
      .addTextDisplayComponents(epicHeader(0, upcoming.length));
    const next = discordTime(upcoming[0]?.upcomingStartDate, 'R');
    card.addTextDisplayComponents(
      textBlock([
        upcoming.length > 0
          ? `Nothing free right now. The next drop unlocks ${next || 'soon'}.`
          : 'No free games listed right now.',
      ]),
    );
    for (const game of upcoming) addBlock(card, epicSoonRow(game));
    epicFooter(card, []);
    components.push(card);
  }

  return { components, flags: MessageFlags.IsComponentsV2 };
}

export type RoomKind = 'text' | 'voice';

export interface DecoratedChannelName {
  name: string;
  emoji: string;
  slug: string;
}

/** Sidebar style: one emoji, a katakana middle dot, then the room name. */
const SEPARATOR = '\u30fb';
const CHANNEL_NAME_MAX = 100;

interface EmojiRule {
  phrases: readonly string[];
  emoji: string;
  /** Higher wins, so a specific word beats a shorter generic one. */
  priority: number;
}

const EMOJI_RULES: readonly EmojiRule[] = [
  { phrases: ['arc raiders', 'raiders'], emoji: '🎯', priority: 100 },
  { phrases: ['dayz'], emoji: '🧟', priority: 100 },
  { phrases: ['minecraft'], emoji: '⛏️', priority: 100 },
  { phrases: ['rust'], emoji: '🦀', priority: 100 },
  { phrases: ['valorant'], emoji: '🔫', priority: 100 },
  { phrases: ['counter strike', 'cs2'], emoji: '💣', priority: 100 },
  { phrases: ['gta'], emoji: '🚗', priority: 100 },
  { phrases: ['fortnite'], emoji: '🏝️', priority: 100 },
  { phrases: ['league of legends', 'league'], emoji: '⚔️', priority: 100 },
  { phrases: ['among us'], emoji: '👽', priority: 100 },
  { phrases: ['the kitchen', 'kitchen', 'kuchyne', 'kuchyn'], emoji: '🍪', priority: 80 },
  { phrases: ['moderator', 'mod', 'staff'], emoji: '🛡️', priority: 80 },
  { phrases: ['pravidla', 'rules', 'rule'], emoji: '📋', priority: 80 },
  { phrases: ['welcome', 'goodbye', 'ahoj', 'vitej', 'vitejte'], emoji: '👋', priority: 80 },
  { phrases: ['epic games', 'epic'], emoji: '🎁', priority: 90 },
  { phrases: ['steam'], emoji: '🏷️', priority: 90 },
  { phrases: ['kapitoly', 'kniha', 'book', 'lore'], emoji: '📖', priority: 80 },
  { phrases: ['clips', 'clip', 'video', 'videos'], emoji: '🎬', priority: 80 },
  { phrases: ['bot command', 'bot', 'command', 'commands'], emoji: '🤖', priority: 80 },
  { phrases: ['deals', 'deal', 'sleva', 'slevy'], emoji: '🏷️', priority: 60 },
  { phrases: ['main chat', 'main', 'chat', 'obecny', 'general'], emoji: '💬', priority: 50 },
  {
    phrases: ['novinky', 'news', 'announce', 'announcement', 'oznameni'],
    emoji: '📰',
    priority: 50,
  },
  { phrases: ['hudba', 'music', 'song', 'songs'], emoji: '🎵', priority: 50 },
  { phrases: ['radio'], emoji: '📻', priority: 50 },
  { phrases: ['meme', 'memes'], emoji: '😂', priority: 50 },
  { phrases: ['art', 'fanart'], emoji: '🎨', priority: 50 },
  { phrases: ['game', 'games', 'gaming', 'hry'], emoji: '🎮', priority: 40 },
  { phrases: ['room'], emoji: '🎧', priority: 20 },
];

/**
 * Turn a typed room name into the sidebar form (`🍪・the-kitchen`).
 * Returns null when nothing letter-or-number remains.
 */
export function decorateChannelName(raw: string, kind: RoomKind): DecoratedChannelName | null {
  const slug = slugifyRoomName(raw, kind);
  if (!slug) return null;
  const emoji = pickRoomEmoji(slug, kind);
  const prefix = `${emoji}${SEPARATOR}`;
  const room = clipSlug(slug, CHANNEL_NAME_MAX - prefix.length, kind);
  if (!room) return null;
  return { name: `${prefix}${room}`, emoji, slug: room };
}

function pickRoomEmoji(slug: string, kind: RoomKind): string {
  const spaced = slug.replace(/-/g, ' ');
  const tokens = new Set(spaced.split(' ').filter(Boolean));
  let bestScore = 0;
  let bestEmoji = kind === 'voice' ? '🎧' : '💬';

  for (const rule of EMOJI_RULES) {
    for (const phrase of rule.phrases) {
      if (!phraseMatches(phrase, spaced, tokens)) continue;
      const score = rule.priority * 1000 + phrase.length;
      if (score > bestScore) {
        bestScore = score;
        bestEmoji = rule.emoji;
      }
    }
  }

  return bestEmoji;
}

function phraseMatches(phrase: string, spaced: string, tokens: Set<string>): boolean {
  if (phrase.includes(' ')) return ` ${spaced} `.includes(` ${phrase} `);
  return tokens.has(phrase);
}

function slugifyRoomName(raw: string, kind: RoomKind): string {
  const folded = stripEmoji(raw).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  if (kind === 'voice') {
    return folded
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/ +/g, ' ')
      .trim();
  }
  return folded
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function stripEmoji(input: string): string {
  return input
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\p{Regional_Indicator}/gu, '')
    .replace(/\p{Emoji_Modifier}/gu, '')
    .replace(/\u200D|\uFE0E|\uFE0F|\u20E3/g, '');
}

function clipSlug(slug: string, maxUnits: number, kind: RoomKind): string {
  if (maxUnits <= 0) return '';
  let clipped = slug.length <= maxUnits ? slug : slug.slice(0, maxUnits);
  const tail = clipped.charCodeAt(clipped.length - 1);
  if (tail >= 0xd800 && tail <= 0xdbff) clipped = clipped.slice(0, -1);
  if (kind === 'voice') return clipped.replace(/ +$/g, '').trim();
  return clipped.replace(/-+$/g, '').replace(/^-+/g, '');
}

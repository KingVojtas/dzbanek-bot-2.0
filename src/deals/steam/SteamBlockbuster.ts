import type { SteamDealItem } from '../../core/types';
import { extractAppId, parseDiscountPercent } from './SteamPriceApi';

/**
 * Studios behind the big commercial releases (God of War, Red Dead, Sekiro).
 * Matched on word boundaries so "dice" does not hit an unrelated name.
 */
const AAA_STUDIOS = [
  'rockstar',
  'sony interactive',
  'playstation',
  'naughty dog',
  'santa monica',
  'insomniac',
  'guerrilla',
  'sucker punch',
  'bend studio',
  'housemarque',
  'ubisoft',
  'electronic arts',
  'bioware',
  'respawn',
  'dice',
  'bethesda',
  'id software',
  'machinegames',
  'arkane',
  'activision',
  'blizzard',
  'infinity ward',
  'treyarch',
  'capcom',
  'square enix',
  'bandai namco',
  'warner bros',
  'netherrealm',
  'rocksteady',
  'cd projekt',
  '2k',
  'hangar 13',
  'firaxis',
  'gearbox',
  'fromsoftware',
  'from software',
  'larian',
  'remedy',
  'io interactive',
  'crystal dynamics',
  'eidos montreal',
  'platinumgames',
  'koei tecmo',
  'konami',
  'sega',
  'atlus',
  'creative assembly',
  'relic entertainment',
  'xbox game studios',
  'playground games',
  'turn 10',
  '343 industries',
  'obsidian entertainment',
  'ryu ga gotoku',
  'warhorse',
  'sandfall',
  'valve',
];

const FULL_PRICE_CENTS = 3999;
const MID_PRICE_CENTS = 2499;

export interface SteamStoreProfile {
  type: string;
  publishers: string[];
  developers: string[];
  shortDescription: string;
  recommendations: number;
  metacritic: number;
  initialCents: number;
  discountPercent: number;
  initialFormatted?: string;
  finalFormatted?: string;
}

interface RawApp {
  success?: boolean;
  data?: {
    type?: string;
    publishers?: string[];
    developers?: string[];
    short_description?: string;
    recommendations?: { total?: number };
    metacritic?: { score?: number };
    price_overview?: {
      initial?: number;
      discount_percent?: number;
      initial_formatted?: string;
      final_formatted?: string;
    };
  };
}

/** Store blurb, one sentence, safe to drop into a Discord text row. */
export function cleanSteamBlurb(value: string | undefined, max = 150): string {
  if (!value) return '';
  const text = decodeBasic(value)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*_`[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const word = cut.lastIndexOf(' ');
  return `${(word > 80 ? cut.slice(0, word) : cut).trimEnd()}…`;
}

function decodeBasic(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function moneyCents(value: string | undefined): number | null {
  if (!value) return null;
  const match = value.replace(/\s/g, '').match(/(\d+)[,.](\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 100 + Number(match[2]);
}

function matchesStudio(name: string): boolean {
  const normalized = ` ${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;
  return AAA_STUDIOS.some((studio) => normalized.includes(` ${studio} `));
}

/** Major studio, or a full-priced release with a real audience. */
export function isBlockbusterProfile(profile: SteamStoreProfile, originalCents: number): boolean {
  if (profile.type && profile.type !== 'game') return false;
  const names = [...profile.publishers, ...profile.developers];
  if (names.some(matchesStudio)) return true;
  const was = profile.initialCents || originalCents;
  if (was >= 4999 && profile.recommendations >= 8_000) return true;
  if (was >= 3999 && profile.recommendations >= 30_000) return true;
  if (profile.metacritic >= 85 && profile.recommendations >= 15_000 && was >= 3999) return true;
  return false;
}

/**
 * Look up the pricier specials and mark the blockbusters. Their Steam blurb
 * is stored on the deal so the card can show it.
 */
export async function attachStoreProfiles(
  items: SteamDealItem[],
  cache = new Map<string, SteamStoreProfile | null>(),
): Promise<void> {
  const byDiscount = (a: SteamDealItem, b: SteamDealItem): number =>
    (parseDiscountPercent(b.discount) ?? 0) - (parseDiscountPercent(a.discount) ?? 0);
  const fullPrice = items
    .filter((item) => (moneyCents(item.originalPrice) ?? 0) >= FULL_PRICE_CENTS)
    .sort(byDiscount)
    .slice(0, 40);
  const seen = new Set(fullPrice.map((item) => item.id));
  const midPrice = items
    .filter((item) => {
      const was = moneyCents(item.originalPrice) ?? 0;
      return was >= MID_PRICE_CENTS && was < FULL_PRICE_CENTS && !seen.has(item.id);
    })
    .sort(byDiscount)
    .slice(0, 15);
  const premium = [...fullPrice, ...midPrice];

  await mapPool(premium, 4, async (item) => {
    const appId = extractAppId(item.link);
    if (!appId) return;
    const profile = await loadProfile(appId, cache);
    if (!profile) return;
    applyProfile(item, profile);
  });
}

/** Fill Steam blurbs for rows that were not part of the blockbuster lookup. */
export async function attachSteamBlurbs(
  items: SteamDealItem[],
  cache = new Map<string, SteamStoreProfile | null>(),
): Promise<void> {
  const missing = items.filter((item) => !cleanSteamBlurb(item.description));
  await mapPool(missing, 4, async (item) => {
    const appId = extractAppId(item.link);
    if (!appId) return;
    const profile = await loadProfile(appId, cache);
    if (!profile?.shortDescription) return;
    item.description = cleanSteamBlurb(profile.shortDescription);
  });
}

function applyProfile(item: SteamDealItem, profile: SteamStoreProfile): void {
  const publisher = profile.publishers[0];
  if (publisher) item.publisher = publisher;
  if (profile.shortDescription) item.description = cleanSteamBlurb(profile.shortDescription);
  if (profile.finalFormatted) item.salePrice = profile.finalFormatted;
  if (profile.initialFormatted) item.originalPrice = profile.initialFormatted;
  if (profile.discountPercent > 0) item.discount = `-${profile.discountPercent}%`;
  item.blockbuster = isBlockbusterProfile(profile, moneyCents(item.originalPrice) ?? 0);
}

async function loadProfile(
  appId: string,
  cache: Map<string, SteamStoreProfile | null>,
): Promise<SteamStoreProfile | null> {
  if (cache.has(appId)) return cache.get(appId) ?? null;
  const profile = await fetchProfile(appId);
  cache.set(appId, profile);
  return profile;
}

async function fetchProfile(appId: string): Promise<SteamStoreProfile | null> {
  const url = `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=de&l=english`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(12_000),
      });
      if (response.status === 429 && attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 800));
        continue;
      }
      if (!response.ok) return null;
      const json = (await response.json()) as Record<string, RawApp>;
      const data = json[appId]?.data;
      if (!json[appId]?.success || !data) return null;
      const price = data.price_overview;
      return {
        type: data.type ?? 'game',
        publishers: data.publishers ?? [],
        developers: data.developers ?? [],
        shortDescription: data.short_description ?? '',
        recommendations: data.recommendations?.total ?? 0,
        metacritic: data.metacritic?.score ?? 0,
        initialCents: price?.initial ?? 0,
        discountPercent: price?.discount_percent ?? 0,
        initialFormatted: price?.initial_formatted,
        finalFormatted: price?.final_formatted,
      };
    } catch {
      return null;
    }
  }
  return null;
}

async function mapPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
}

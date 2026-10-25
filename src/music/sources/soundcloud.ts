import youtubeDl from 'youtube-dl-exec';
import type { Track } from '../../core/types';

/** Labels upload 30 s previews; anything this short is not the song. */
const PREVIEW_MAX_SEC = 31;
/** Remixes and fan edits sit far from the original's length. */
const DURATION_SLACK_SEC = 8;
const DURATION_SLACK_RATIO = 0.05;
const SEARCH_SIZE = 8;
const VARIANT =
  /\b(nightcore|remix|cover|sped up|slowed|reverb|8d|bass ?boost(ed)?|instrumental|karaoke|mashup|bootleg|extended)\b/;
/** YouTube dressing that no SoundCloud upload carries. */
const YT_NOISE =
  /[([][^)\]]*\b(official|video|audio|lyrics?|visuali[sz]er|hd|hq|4k|mv|clip)\b[^)\]]*[)\]]/gi;

export interface SoundCloudEntry {
  title?: string;
  uploader?: string;
  duration?: number;
  url?: string;
  webpage_url?: string;
}

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function cleanTitle(title: string): string {
  return title
    .replace(YT_NOISE, ' ')
    .replace(/[([]?\s*\b(?:ft|feat|featuring)\b\.?.*$/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "Artist - Song" stays as it is; a bare song name gets the channel in front. */
export function soundCloudQuery(track: Track): string {
  const title = cleanTitle(track.title);
  if (/\s[-–—]\s/.test(title) || !track.uploader) return title;
  const artist = track.uploader.replace(/\s*-\s*Topic$|VEVO$|\bofficial( channel)?\b/gi, '').trim();
  return artist ? `${artist} ${title}` : title;
}

/**
 * The upload that is this song: the song name in its title, the same length
 * give or take a few seconds, and no remix or nightcore unless asked for.
 */
export function pickStandIn(track: Track, entries: SoundCloudEntry[]): string | null {
  if (!track.durationSec) return null;
  const title = cleanTitle(track.title);
  const song = normalize(title.split(/\s[-–—]\s/).pop() ?? title);
  if (!song) return null;
  const wantsVariant = VARIANT.test(normalize(track.title));
  const slack = Math.max(DURATION_SLACK_SEC, track.durationSec * DURATION_SLACK_RATIO);

  const hit = entries.find((entry) => {
    const url = entry.webpage_url || entry.url;
    if (!url || typeof entry.duration !== 'number' || entry.duration <= PREVIEW_MAX_SEC)
      return false;
    if (Math.abs(entry.duration - track.durationSec) > slack) return false;
    const name = normalize(`${entry.title ?? ''} ${entry.uploader ?? ''}`);
    if (!name.includes(song)) return false;
    return wantsVariant || !VARIANT.test(name);
  });
  return hit ? (hit.webpage_url || hit.url)! : null;
}

/** A SoundCloud URL for the same song, for when YouTube will not stream it. */
export async function findSoundCloudStandIn(track: Track): Promise<string | null> {
  if (!track.durationSec) return null;
  const raw = await youtubeDl(`scsearch${SEARCH_SIZE}:${soundCloudQuery(track)}`, {
    dumpSingleJson: true,
    flatPlaylist: true,
    noWarnings: true,
  } as Parameters<typeof youtubeDl>[1]);
  const info = (typeof raw === 'string' ? JSON.parse(raw) : raw) as {
    entries?: (SoundCloudEntry | null)[];
  };
  const entries = (info.entries ?? []).filter((entry): entry is SoundCloudEntry => entry != null);
  return pickStandIn(track, entries);
}

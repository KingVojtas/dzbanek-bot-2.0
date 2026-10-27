/** Chef of the week, scored over the chart week. Pure: the caller brings the rows. */

export interface ChefBringer {
  userId: string;
  songKey: string;
  url?: string;
}

export interface ChefFire {
  userId: string;
  songKey: string;
  url: string;
  title: string;
  artist: string;
}

export interface ChefPlay {
  userId: string | null;
  songKey: string;
  kind: string;
}

export interface ChefStanding {
  userId: string;
  name: string;
  points: number;
  /** 🔥 other people gave songs this person brought. */
  fires: number;
  /** Distinct `play` and `dedication` songs. */
  songs: number;
}

export interface WeekSong {
  title: string;
  artist: string;
  fires: number;
  broughtBy: string[];
}

interface BringerIndex {
  byKey: Map<string, Set<string>>;
  byUrl: Map<string, Set<string>>;
}

/**
 * Top 3 this week.
 * +3 for each 🔥 someone else gave a song they brought (PlayedTrack or a catch).
 * A 🔥 on your own song scores nothing.
 * +2 per 🍪 catch, +1 per distinct song they played or dedicated, +5 for the quiz champion.
 * Ties go to more 🔥, then more songs, then the name.
 */
export function chefOfTheWeek(input: {
  fires: readonly ChefFire[];
  bringers: readonly ChefBringer[];
  plays: readonly ChefPlay[];
  catches: readonly { userId: string }[];
  championUserId: string | null;
  nameOf: (userId: string) => string;
}): ChefStanding[] {
  const index = indexBringers(input.bringers);
  const scores = new Map<string, { points: number; fires: number; songs: number }>();
  const tally = (userId: string) => {
    let row = scores.get(userId);
    if (!row) scores.set(userId, (row = { points: 0, fires: 0, songs: 0 }));
    return row;
  };

  for (const fire of input.fires) {
    const ids = bringersOf(index, fire.songKey, fire.url ? [fire.url] : []);
    for (const id of ids) {
      if (id === fire.userId) continue;
      const row = tally(id);
      row.fires += 1;
      row.points += 3;
    }
  }

  for (const row of input.catches) {
    if (!row.userId) continue;
    tally(row.userId).points += 2;
  }

  const songs = new Map<string, Set<string>>();
  for (const row of input.plays) {
    if (row.kind !== 'play' && row.kind !== 'dedication') continue;
    if (!row.userId || !row.songKey) continue;
    let set = songs.get(row.userId);
    if (!set) songs.set(row.userId, (set = new Set()));
    set.add(row.songKey);
  }
  for (const [userId, set] of songs) {
    const row = tally(userId);
    row.songs = set.size;
    row.points += set.size;
  }

  if (input.championUserId) tally(input.championUserId).points += 5;

  return [...scores.entries()]
    .filter(([, row]) => row.points > 0)
    .map(([userId, row]) => ({
      userId,
      name: input.nameOf(userId),
      points: row.points,
      fires: row.fires,
      songs: row.songs,
    }))
    .sort(
      (a, b) =>
        b.points - a.points ||
        b.fires - a.fires ||
        b.songs - a.songs ||
        a.name.localeCompare(b.name) ||
        a.userId.localeCompare(b.userId),
    )
    .slice(0, 3);
}

/** The song with the most 🔥 this week, and who brought it in. */
export function songOfTheWeek(input: {
  fires: readonly ChefFire[];
  bringers: readonly ChefBringer[];
  nameOf: (userId: string) => string;
}): WeekSong | null {
  const buckets = new Map<
    string,
    { title: string; artist: string; fires: number; urls: Set<string> }
  >();
  for (const fire of input.fires) {
    const key = fire.songKey || fire.url;
    if (!key) continue;
    const bucket = buckets.get(key) ?? {
      title: fire.title,
      artist: fire.artist,
      fires: 0,
      urls: new Set<string>(),
    };
    bucket.fires += 1;
    if (fire.url) bucket.urls.add(fire.url);
    if (fire.title) {
      bucket.title = fire.title;
      bucket.artist = fire.artist;
    }
    buckets.set(key, bucket);
  }
  const best = [...buckets.entries()].sort(
    (a, b) =>
      b[1].fires - a[1].fires || a[1].title.localeCompare(b[1].title) || a[0].localeCompare(b[0]),
  )[0];
  if (!best || !best[1].title.trim()) return null;
  const [songKey, bucket] = best;
  const broughtBy = [...bringersOf(indexBringers(input.bringers), songKey, bucket.urls)]
    .map((id) => input.nameOf(id).trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  return { title: bucket.title, artist: bucket.artist, fires: bucket.fires, broughtBy };
}

function indexBringers(bringers: readonly ChefBringer[]): BringerIndex {
  const byKey = new Map<string, Set<string>>();
  const byUrl = new Map<string, Set<string>>();
  for (const row of bringers) {
    if (!row.userId) continue;
    if (row.songKey) addId(byKey, row.songKey, row.userId);
    if (row.url) addId(byUrl, row.url, row.userId);
  }
  return { byKey, byUrl };
}

function addId(map: Map<string, Set<string>>, key: string, userId: string): void {
  let set = map.get(key);
  if (!set) map.set(key, (set = new Set()));
  set.add(userId);
}

function bringersOf(index: BringerIndex, songKey: string, urls: Iterable<string>): Set<string> {
  const ids = new Set<string>(index.byKey.get(songKey) ?? []);
  for (const url of urls) {
    for (const id of index.byUrl.get(url) ?? []) ids.add(id);
  }
  return ids;
}

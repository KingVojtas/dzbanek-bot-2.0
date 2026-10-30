import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The parts of a between-blocks break, in the file. */
export const BREAK_PARTS = ['ids', 'promos', 'recap', 'comingUp', 'outro'] as const;

export type BreakPart = (typeof BREAK_PARTS)[number];

/** Blanks a break template may use. The break is always English. */
export const BREAK_BLANKS = ['server', 'lastGenre', 'artists', 'genre', 'songs', 'count'] as const;

export type BreakBlank = (typeof BREAK_BLANKS)[number];

/** Station IDs, promos, and the lines that frame a block. */
export interface BreakBook {
  version: 1;
  ids: string[];
  promos: string[];
  recap: string[];
  comingUp: string[];
  outro: string[];
}

/** Values for the blanks. Already phrased: "A, B and C", "Title by Artist". */
export interface BreakSlots {
  server: string;
  lastGenre: string;
  artists: string;
  genre: string;
  songs: string;
  count: string;
}

const ALLOWED = new Set<string>(BREAK_BLANKS);

const SAMPLE: BreakSlots = {
  server: 'Kitchen',
  lastGenre: 'rock',
  artists: 'A, B and C',
  genre: 'rap',
  songs: 'One by A, Two by B and Three by C',
  count: '15',
};

/** A break blank. `{lastGenre}` has a capital, so the line book's lowercase rule would miss it. */
const BREAK_BLANK = /\{([A-Za-z]+)\}/g;

function breakBlanks(template: string): string[] {
  return [...template.matchAll(BREAK_BLANK)].map((match) => match[1]!);
}

/** Fill a break template. An unknown blank is left as written. */
export function fillBreak(template: string, slots: BreakSlots): string {
  return template.replace(BREAK_BLANK, (whole, name: string) => {
    if (!ALLOWED.has(name)) return whole;
    return slots[name as BreakBlank] ?? whole;
  });
}

/**
 * Why `book` cannot be spoken. Empty when every template fills and uses only
 * known blanks.
 */
export function breakBookProblems(book: BreakBook): string[] {
  const problems: string[] = [];
  if (book.version !== 1) problems.push('version is not 1');
  for (const part of BREAK_PARTS) {
    const lines = book[part];
    if (!Array.isArray(lines) || lines.length === 0) {
      problems.push(`${part} is empty`);
      continue;
    }
    for (const template of lines) {
      if (typeof template !== 'string' || template.trim() === '') {
        problems.push(`${part} has an empty line`);
        continue;
      }
      for (const blank of breakBlanks(template)) {
        if (!ALLOWED.has(blank)) problems.push(`${part} has an unknown blank {${blank}}`);
      }
      const filled = fillBreak(template, SAMPLE);
      if (breakBlanks(filled).length > 0) problems.push(`${part} does not fill: ${template}`);
    }
  }
  return problems;
}

/** The break book on disk. Throws when the file is missing or a line will not fill. */
export function readBreakFile(): BreakBook {
  const path = join(dirname(fileURLToPath(import.meta.url)), 'lines', 'breaks.en.json');
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<BreakBook>;
  const book: BreakBook = {
    version: 1,
    ids: raw.ids ?? [],
    promos: raw.promos ?? [],
    recap: raw.recap ?? [],
    comingUp: raw.comingUp ?? [],
    outro: raw.outro ?? [],
  };
  const problems = breakBookProblems(book);
  if (raw.version !== 1 || problems.length > 0) {
    throw new Error(`Kitchen FM break book is unreadable: ${problems.join('; ') || 'bad version'}`);
  }
  return book;
}

/** Load the English break book. Null when the file is missing or a line will not fill. */
export function loadBreakBook(): BreakBook | null {
  try {
    return readBreakFile();
  } catch {
    return null;
  }
}

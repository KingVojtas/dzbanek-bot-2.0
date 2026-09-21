/** Prague-aware clock helpers for Radio Night voting. */

export const RADIO_VOTE_START_HOUR = 12;
export const RADIO_VOTE_END_HOUR = 20;

interface ZonedParts {
  weekday: string;
  hour: number;
  minute: number;
  dateKey: string;
}

export function zonedParts(timeZone: string, date = new Date()): ZonedParts {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const bag: Record<string, string> = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== 'literal') bag[part.type] = part.value;
  }
  return {
    weekday: bag.weekday ?? '',
    hour: Number.parseInt(bag.hour ?? '0', 10) || 0,
    minute: Number.parseInt(bag.minute ?? '0', 10) || 0,
    dateKey: `${bag.year}-${bag.month}-${bag.day}`,
  };
}

/** Friday 12:00–20:00 in `timeZone` (vote buttons on the Kitchen Board). */
export function isRadioVoteOpen(timeZone: string, date = new Date()): boolean {
  const parts = zonedParts(timeZone, date);
  return (
    parts.weekday === 'Fri' &&
    parts.hour >= RADIO_VOTE_START_HOUR &&
    parts.hour < RADIO_VOTE_END_HOUR
  );
}

/** Calendar date of “this Friday’s Radio Night” in `timeZone`. */
export function radioNightWeekKey(timeZone: string, date = new Date()): string {
  return zonedParts(timeZone, date).dateKey;
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface ChartWeek {
  mondayKey: string;
  fridayKey: string;
  sundayKey: string;
  /** Monday 00:00 in `timeZone`. */
  from: Date;
  /** Sunday 18:00 in `timeZone`. */
  to: Date;
  label: string;
}

/** Monday 00:00 through Sunday 18:00 of the week that contains `date`. */
export function chartWeek(timeZone: string, date = new Date()): ChartWeek {
  const parts = zonedParts(timeZone, date);
  const index = WEEKDAYS.indexOf(parts.weekday as (typeof WEEKDAYS)[number]);
  const shift = index === -1 ? 0 : index;
  const mondayKey = addCalendarDays(parts.dateKey, -shift);
  const fridayKey = addCalendarDays(mondayKey, 4);
  const sundayKey = addCalendarDays(mondayKey, 6);
  return {
    mondayKey,
    fridayKey,
    sundayKey,
    from: zonedDateTimeToUtc(timeZone, mondayKey, 0, 0),
    to: zonedDateTimeToUtc(timeZone, sundayKey, 18, 0),
    label: weekLabel(mondayKey, sundayKey),
  };
}

function addCalendarDays(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  const utc = new Date(Date.UTC(year!, (month ?? 1) - 1, day ?? 1));
  utc.setUTCDate(utc.getUTCDate() + days);
  return utc.toISOString().slice(0, 10);
}

/** Convert a civil time in `timeZone` to a UTC instant. */
export function zonedDateTimeToUtc(
  timeZone: string,
  dateKey: string,
  hour: number,
  minute: number,
): Date {
  const [year, month, day] = dateKey.split('-').map(Number);
  const target = Date.UTC(year!, (month ?? 1) - 1, day ?? 1, hour, minute, 0);
  let guess = target;
  for (let i = 0; i < 4; i++) {
    const seenParts = zonedParts(timeZone, new Date(guess));
    const [seenYear, seenMonth, seenDay] = seenParts.dateKey.split('-').map(Number);
    const seen = Date.UTC(
      seenYear!,
      (seenMonth ?? 1) - 1,
      seenDay ?? 1,
      seenParts.hour,
      seenParts.minute,
      0,
    );
    const delta = target - seen;
    if (delta === 0) break;
    guess += delta;
  }
  return new Date(guess);
}

function weekLabel(mondayKey: string, sundayKey: string): string {
  const mon = splitKey(mondayKey);
  const sun = splitKey(sundayKey);
  const monMonth = MONTHS[mon.month - 1] ?? '';
  const sunMonth = MONTHS[sun.month - 1] ?? '';
  if (mon.year === sun.year && mon.month === sun.month) return `${mon.day}–${sun.day} ${monMonth}`;
  if (mon.year === sun.year) return `${mon.day} ${monMonth} – ${sun.day} ${sunMonth}`;
  return `${mon.day} ${monMonth} ${mon.year} – ${sun.day} ${sunMonth} ${sun.year}`;
}

function splitKey(dateKey: string): { year: number; month: number; day: number } {
  const [year, month, day] = dateKey.split('-').map(Number);
  return { year: year ?? 0, month: month ?? 1, day: day ?? 1 };
}

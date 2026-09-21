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
  return parts.weekday === 'Fri' && parts.hour >= RADIO_VOTE_START_HOUR && parts.hour < RADIO_VOTE_END_HOUR;
}

/** Calendar date of “this Friday’s Radio Night” in `timeZone`. */
export function radioNightWeekKey(timeZone: string, date = new Date()): string {
  return zonedParts(timeZone, date).dateKey;
}

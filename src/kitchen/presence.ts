import { ActivityType, type Client } from 'discord.js';
import type { Logger } from '../core/logger';
import { zonedParts } from './time';

/** One line per hour, in order, then back to the first. */
export const LORE_ACTIVITIES = [
  'Purifying the source',
  'Analyzing bacteria levels',
  'Pouring fresh drops',
] as const;

const TICK_MS = 60_000;

/** The status line for the current hour in `timeZone`. */
export function loreActivity(timeZone: string, date = new Date()): string {
  const hour = zonedParts(timeZone, date).hour;
  return LORE_ACTIVITIES[hour % LORE_ACTIVITIES.length] ?? LORE_ACTIVITIES[0];
}

/** Global bot status. Three lore lines, a new one each hour. */
export class LorePresence {
  private lastLine = '';
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly client: Client,
    private readonly logger: Logger,
    private readonly timeZone: string,
  ) {}

  attach(): void {
    this.tick();
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  tick(date = new Date()): void {
    const user = this.client.user;
    if (!user) return;
    const line = loreActivity(this.timeZone, date);
    if (line === this.lastLine) return;
    this.lastLine = line;
    try {
      user.setPresence({
        status: 'online',
        activities: [{ type: ActivityType.Custom, name: 'Custom Status', state: line }],
      });
    } catch (error) {
      this.logger.debug('Presence update failed:', error);
    }
  }
}

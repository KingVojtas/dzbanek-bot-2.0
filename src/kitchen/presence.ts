import { ActivityType, type Client } from 'discord.js';
import type { Logger } from '../core/logger';
import { zonedParts } from './time';

/** The only status lines. Each hour they all play once, in a shuffled order. */
export const LORE_ACTIVITIES = [
  'Purifying the source',
  'Analyzing bacteria levels',
  'Pouring fresh drops',
] as const;

const TICK_MS = 60_000;
const SLOT_MINUTES = 20;

/** The status line for this twenty-minute slice of the Prague hour. */
export function loreActivity(timeZone: string, date = new Date()): string {
  const parts = zonedParts(timeZone, date);
  const order = shuffleForHour(`${parts.dateKey}:${parts.hour}`);
  const slot = Math.floor(parts.minute / SLOT_MINUTES);
  return order[slot] ?? order[0] ?? LORE_ACTIVITIES[0];
}

/** Same date and hour always produce the same order, so a restart stays put. */
function shuffleForHour(key: string): string[] {
  const items = [...LORE_ACTIVITIES];
  let seed = hashHour(key);
  for (let i = items.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1);
    const swap = items[i];
    items[i] = items[j] ?? items[i];
    items[j] = swap;
  }
  return items;
}

function hashHour(key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Global bot status. Three lore lines, all three each hour. */
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

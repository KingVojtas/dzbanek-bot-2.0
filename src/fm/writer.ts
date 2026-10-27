import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../core/logger';
import {
  SET_SCHEMA,
  SET_SYSTEM,
  parsePlan,
  setRequest,
  type SetFacts,
  type SetPlan,
} from './script';

/** Gitignored; travels with /update-dzbanek uploads, as the YouTube cookies do. */
const BUNDLED_KEY_PATH = join(process.cwd(), 'secrets', 'anthropic-api-key.txt');
/** Sets are planned while the song before plays, so a slow answer still lands in time. */
const TIMEOUT_MS = 30_000;
/** Room for low-effort thinking; the set itself is a few hundred tokens. */
const MAX_TOKENS = 4096;

/** How many sets Claude may plan in one day, per server and for the whole bot. */
export interface DjLimits {
  setsPerServerPerDay: number;
  setsPerDay: number;
  /** The day turns over at midnight here. */
  timezone: string;
}

/**
 * Counts the day's Claude sets, so a busy server or many servers can't run up
 * the API bill. Kept in memory: a restart starts the day's count again.
 */
export class DjBudget {
  private day = '';
  private total = 0;
  private readonly byGuild = new Map<string, number>();
  /** Servers already told they hit the cap today, so the log says it once. */
  private readonly warned = new Set<string>();

  constructor(
    private readonly limits: DjLimits,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Spend one set for `guildId`. 'server' or 'bot' names the cap that refused it. */
  take(guildId: string): 'ok' | 'server' | 'bot' {
    this.rollOver();
    const used = this.byGuild.get(guildId) ?? 0;
    if (used >= this.limits.setsPerServerPerDay) return 'server';
    if (this.total >= this.limits.setsPerDay) return 'bot';
    this.byGuild.set(guildId, used + 1);
    this.total += 1;
    return 'ok';
  }

  /** True the first time a cap refuses `key` today. */
  firstRefusal(key: string): boolean {
    if (this.warned.has(key)) return false;
    this.warned.add(key);
    return true;
  }

  private rollOver(): void {
    const day = this.now().toLocaleDateString('en-CA', { timeZone: this.limits.timezone });
    if (day === this.day) return;
    this.day = day;
    this.total = 0;
    this.byGuild.clear();
    this.warned.clear();
  }
}

/** `ANTHROPIC_API_KEY` first, then the bundled file; null when neither is there. */
function apiKey(): { key: string; from: string } | null {
  const fromEnv = process.env.ANTHROPIC_API_KEY?.trim();
  if (fromEnv) return { key: fromEnv, from: 'ANTHROPIC_API_KEY' };
  try {
    const fromFile = readFileSync(BUNDLED_KEY_PATH, 'utf8').trim();
    return fromFile ? { key: fromFile, from: 'secrets/anthropic-api-key.txt' } : null;
  } catch {
    return null;
  }
}

/**
 * Plans the DJ's sets with Claude: a vibe, its songs, and the line before them.
 * Without a key, when a call fails, or past the day's limits, it answers null
 * and the station puts a set together itself.
 */
export class DjWriter {
  private readonly client: Anthropic | null;
  private authFailed = false;
  private readonly budget: DjBudget;

  constructor(
    private readonly model: string,
    private readonly logger: Logger,
    private readonly limits: DjLimits,
  ) {
    this.budget = new DjBudget(limits);
    const found = apiKey();
    this.client = found
      ? new Anthropic({ apiKey: found.key, timeout: TIMEOUT_MS, maxRetries: 1 })
      : null;
    logger.info(
      found
        ? `Kitchen FM DJ: ${model}, key from ${found.from}.`
        : 'Kitchen FM DJ: no ANTHROPIC_API_KEY, so the station plans its own sets.',
    );
  }

  /** False without a key, or once the key was refused. */
  get ready(): boolean {
    return this.client !== null && !this.authFailed;
  }

  async planSet(facts: SetFacts, guildId: string): Promise<SetPlan | null> {
    if (!this.client || this.authFailed) return null;
    const spent = this.budget.take(guildId);
    if (spent !== 'ok') {
      const key = spent === 'bot' ? 'bot' : guildId;
      if (this.budget.firstRefusal(key)) {
        this.logger.info(
          spent === 'bot'
            ? `Kitchen FM DJ: all servers used today's ${this.limits.setsPerDay} Claude sets. Stations plan their own until midnight.`
            : `Kitchen FM DJ: ${facts.server} used today's ${this.limits.setsPerServerPerDay} Claude sets. Its station plans its own until midnight.`,
        );
      }
      return null;
    }
    try {
      const response = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: MAX_TOKENS,
        output_config: { effort: 'low', format: { type: 'json_schema', schema: SET_SCHEMA } },
        system: SET_SYSTEM,
        messages: [{ role: 'user', content: setRequest(facts) }],
        // A declined set is retried on Anthropic's recommended model. Haiku has no fallback.
        ...(/haiku/i.test(this.model)
          ? {}
          : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }),
      });
      this.logger.debug(
        `Kitchen FM DJ: ${response.usage.input_tokens} in, ${response.usage.output_tokens} out.`,
      );
      if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') {
        this.logger.debug(`Kitchen FM DJ: no set from Claude (${response.stop_reason}).`);
        return null;
      }
      const text = response.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('');
      const plan = parsePlan(text, facts.crate, facts.discover);
      if (!plan) this.logger.warn('Kitchen FM DJ: Claude planned no usable set.');
      return plan;
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError) {
        // A bad key stays bad until the next deploy: stop asking.
        this.authFailed = true;
        this.logger.warn('Kitchen FM DJ: the Anthropic API key was refused. Planning sets itself.');
      } else if (error instanceof Anthropic.RateLimitError) {
        this.logger.warn('Kitchen FM DJ: rate limited, so the station plans this set itself.');
      } else if (error instanceof Anthropic.APIError) {
        this.logger.warn(
          `Kitchen FM DJ: Claude answered ${error.status ?? 'an error'}:`,
          error.message,
        );
      } else {
        this.logger.warn('Kitchen FM DJ: could not plan a set:', error);
      }
      return null;
    }
  }
}

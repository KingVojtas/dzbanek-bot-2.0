import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../core/logger';
import { DJ_SYSTEM, djRequest, type DjFacts } from './script';

/** Gitignored; travels with /update-dzbanek uploads, as the YouTube cookies do. */
const BUNDLED_KEY_PATH = join(process.cwd(), 'secrets', 'anthropic-api-key.txt');
/** Lines are written while the previous song plays, so a slow answer still lands in time. */
const TIMEOUT_MS = 20_000;
/** Room for low-effort thinking; the line itself is a few dozen tokens. */
const MAX_TOKENS = 4096;

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
 * Writes the DJ's lines with Claude. Without a key, or when a call fails, it
 * answers null and the station reads its own short line instead.
 */
export class DjWriter {
  private readonly client: Anthropic | null;
  private authFailed = false;

  constructor(
    private readonly model: string,
    private readonly logger: Logger,
  ) {
    const found = apiKey();
    this.client = found
      ? new Anthropic({ apiKey: found.key, timeout: TIMEOUT_MS, maxRetries: 1 })
      : null;
    logger.info(
      found
        ? `Kitchen FM DJ: ${model}, key from ${found.from}.`
        : 'Kitchen FM DJ: no ANTHROPIC_API_KEY, so it reads its own short lines.',
    );
  }

  async write(facts: DjFacts): Promise<string | null> {
    if (!this.client || this.authFailed) return null;
    try {
      const response = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: MAX_TOKENS,
        output_config: { effort: 'low' },
        system: DJ_SYSTEM,
        messages: [{ role: 'user', content: djRequest(facts) }],
        // A declined line is retried on Anthropic's recommended model. Haiku has no fallback.
        ...(/haiku/i.test(this.model)
          ? {}
          : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }),
      });
      if (response.stop_reason === 'refusal') {
        this.logger.debug('Kitchen FM DJ: Claude declined this line.');
        return null;
      }
      const text = response.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join(' ')
        .trim();
      this.logger.debug(
        `Kitchen FM DJ: ${response.usage.input_tokens} in, ${response.usage.output_tokens} out.`,
      );
      return text || null;
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError) {
        // A bad key stays bad until the next deploy: stop asking.
        this.authFailed = true;
        this.logger.warn('Kitchen FM DJ: the Anthropic API key was refused. Using short lines.');
      } else if (error instanceof Anthropic.RateLimitError) {
        this.logger.warn('Kitchen FM DJ: rate limited, this line is a short one.');
      } else if (error instanceof Anthropic.APIError) {
        this.logger.warn(
          `Kitchen FM DJ: Claude answered ${error.status ?? 'an error'}:`,
          error.message,
        );
      } else {
        this.logger.warn('Kitchen FM DJ: could not write a line:', error);
      }
      return null;
    }
  }
}

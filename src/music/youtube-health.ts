import type { Logger } from '../core/logger';
import { isBotCheck } from './ytdlp-cookies';

/** A song's bot check sends at most one probe per this long. */
const SUSPECT_GAP_MS = 5 * 60 * 1000;

export type YouTubeAlert = (text: string) => Promise<void> | void;

export type YouTubeState = 'unknown' | 'ok' | 'blocked';

function blockedAlert(reason: string): string {
  return (
    '🍪 YouTube stopped letting Dzbanek in: it wants a fresh sign-in. Songs fall back to ' +
    'SoundCloud where they can.\n' +
    'Export new cookies from a private window (close it right after), save them as ' +
    '`secrets/yt-cookies.txt`, and deploy with /update-dzbanek.\n' +
    `\`${reason.replace(/`/g, "'").slice(0, 300)}\``
  );
}

const RECOVERED_ALERT = '✅ YouTube works again. Songs play from YouTube as usual.';

/**
 * Whether YouTube lets the bot in. A probe of one never-gated video decides,
 * so a single age-gated song is no alarm. The owner hears of each change once:
 * when the sign-in runs out, and when YouTube works again.
 */
export class YouTubeHealth {
  private current: YouTubeState = 'unknown';
  private running: Promise<void> | null = null;
  private lastSuspect = -Infinity;
  private alert: YouTubeAlert | null = null;

  /** `probe` resolves to null when YouTube streams, else to yt-dlp's reason. */
  constructor(
    private readonly probe: () => Promise<string | null>,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  get state(): YouTubeState {
    return this.current;
  }

  setAlert(fn: YouTubeAlert): void {
    this.alert = fn;
  }

  /** Probe YouTube now. A check already under way is shared, not repeated. */
  check(): Promise<void> {
    this.running ??= this.runCheck().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** A song streamed from YouTube. */
  working(): Promise<void> {
    const was = this.current;
    this.current = 'ok';
    if (was !== 'blocked') return Promise.resolve();
    this.logger.info('YouTube works again.');
    return this.notify(RECOVERED_ALERT);
  }

  /** A song hit a bot check: the probe confirms it, at most every 5 minutes. */
  suspect(): void {
    const at = this.now();
    if (at - this.lastSuspect < SUSPECT_GAP_MS) return;
    this.lastSuspect = at;
    void this.check();
  }

  private async runCheck(): Promise<void> {
    let reason: string | null;
    try {
      reason = await this.probe();
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
    if (!reason) {
      this.logger.info('YouTube check: ok.');
      await this.working();
      return;
    }
    // A network blip or a yt-dlp break is no reason to renew the sign-in.
    if (!isBotCheck(reason)) {
      this.logger.warn(`YouTube check failed: ${reason}`);
      return;
    }
    this.logger.warn(`YouTube check: blocked — ${reason}`);
    if (this.current === 'blocked') return;
    this.current = 'blocked';
    await this.notify(blockedAlert(reason));
  }

  private async notify(text: string): Promise<void> {
    if (!this.alert) return;
    try {
      await this.alert(text);
    } catch (error) {
      this.logger.warn('Could not send the YouTube alert:', error);
    }
  }
}

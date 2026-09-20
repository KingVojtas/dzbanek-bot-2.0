import {
  AudioPlayerStatus,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
} from '@discordjs/voice';
import type { AudioPlayer, VoiceConnection } from '@discordjs/voice';
import type { Logger } from '../core/logger';
import { RADIO_KISS_NAME, RADIO_KISS_URL } from './station';

const RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;
const MAX_RECONNECT_ATTEMPTS = 5;

/**
 * One live Icecast session for a guild: voice connection, audio player, and
 * reconnect-on-drop. AudioPlayer has no destroy() — cleanup is stop + drop
 * listeners + connection.destroy().
 */
export class RadioSession {
  private readonly player: AudioPlayer;
  private destroyed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectFailures = 0;
  private reconnectScheduled = false;

  constructor(
    readonly connection: VoiceConnection,
    private readonly logger: Logger,
    private readonly onDestroy: () => void,
  ) {
    this.player = createAudioPlayer();
    this.connection.subscribe(this.player);
    this.attachListeners();
  }

  get channelId(): string | null {
    return this.connection.joinConfig.channelId;
  }

  get isLive(): boolean {
    const status = this.player.state.status;
    return status === AudioPlayerStatus.Playing || status === AudioPlayerStatus.Buffering;
  }

  start(): void {
    if (this.destroyed) return;
    this.playResource();
  }

  async waitForStart(timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.destroyed) {
        throw new Error(`${RADIO_KISS_NAME} stopped before audio started.`);
      }
      if (this.isLive) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    if (this.isLive) return;
    this.destroy();
    throw new Error(
      `Timed out waiting for ${RADIO_KISS_NAME} to start. Make sure FFmpeg is available.`,
    );
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearReconnectTimer();
    this.reconnectScheduled = false;

    try {
      this.player.stop(true);
    } catch {
      /* already stopped */
    }
    this.player.removeAllListeners();
    this.connection.removeAllListeners();

    if (this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      try {
        this.connection.destroy();
      } catch {
        /* already destroyed */
      }
    }

    this.onDestroy();
  }

  private attachListeners(): void {
    this.player.on('error', (error) => {
      if (this.destroyed) return;
      this.logger.error(`${RADIO_KISS_NAME} player error:`, error);
      this.scheduleReconnect();
    });

    this.player.on('stateChange', (_oldState, newState) => {
      if (this.destroyed) return;

      if (newState.status === AudioPlayerStatus.Playing) {
        this.reconnectFailures = 0;
        this.reconnectScheduled = false;
        this.clearReconnectTimer();
        return;
      }

      if (newState.status === AudioPlayerStatus.Idle) {
        this.scheduleReconnect();
      }
    });

    this.connection.on('stateChange', (oldState, newState) => {
      this.logger.info(
        `Radio voice ${this.connection.joinConfig.guildId}: ${oldState.status} → ${newState.status}`,
      );
    });

    this.connection.on('error', (error) => {
      this.logger.error(
        `Radio voice connection error ${this.connection.joinConfig.guildId}:`,
        error,
      );
    });

    this.connection.on(VoiceConnectionStatus.Disconnected, () => {
      void this.handleDisconnect();
    });
  }

  private playResource(): void {
    if (this.destroyed) return;
    const resource = createAudioResource(RADIO_KISS_URL, { inlineVolume: true });
    this.player.play(resource);
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectScheduled) return;

    if (this.reconnectFailures >= MAX_RECONNECT_ATTEMPTS) {
      this.logger.error(
        `${RADIO_KISS_NAME}: giving up after ${MAX_RECONNECT_ATTEMPTS} consecutive reconnect failures.`,
      );
      this.destroy();
      return;
    }

    const delay =
      RECONNECT_BACKOFF_MS[Math.min(this.reconnectFailures, RECONNECT_BACKOFF_MS.length - 1)]!;
    this.reconnectFailures += 1;
    this.reconnectScheduled = true;

    this.logger.warn(
      `${RADIO_KISS_NAME} stream interrupted — reconnecting in ${delay}ms (attempt ${this.reconnectFailures}/${MAX_RECONNECT_ATTEMPTS}).`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectScheduled = false;
      if (this.destroyed) return;
      try {
        this.playResource();
      } catch (error) {
        this.logger.error(`${RADIO_KISS_NAME} reconnect failed:`, error);
        this.scheduleReconnect();
      }
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private async handleDisconnect(): Promise<void> {
    if (this.destroyed) return;
    try {
      await Promise.race([
        entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      this.destroy();
    }
  }
}

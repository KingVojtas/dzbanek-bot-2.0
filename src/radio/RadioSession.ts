import {
  AudioPlayerStatus,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
} from '@discordjs/voice';
import type { AudioPlayer, VoiceConnection } from '@discordjs/voice';
import type { Message } from 'discord.js';
import type { Logger } from '../core/logger';
import type { RadioStation } from './station';

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
  /** Skip the Idle caused by swapping the current Icecast resource. */
  private ignoreIdle = false;
  private currentStation: RadioStation;
  private nowPlayingMessage: Message | null = null;

  constructor(
    readonly connection: VoiceConnection,
    station: RadioStation,
    private readonly logger: Logger,
    private readonly onDestroy: () => void,
  ) {
    this.currentStation = station;
    this.player = createAudioPlayer();
    this.connection.subscribe(this.player);
    this.attachListeners();
  }

  get station(): RadioStation {
    return this.currentStation;
  }

  getNowPlayingMessage(): Message | null {
    return this.nowPlayingMessage;
  }

  setNowPlayingMessage(message: Message | null): void {
    this.nowPlayingMessage = message;
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

  /** Swap Icecast URL in place — does not tear down the voice connection. */
  switchStation(station: RadioStation): void {
    if (this.destroyed) return;
    this.currentStation = station;
    this.reconnectFailures = 0;
    this.reconnectScheduled = false;
    this.clearReconnectTimer();
    this.ignoreIdle = true;
    try {
      this.player.stop(true);
    } catch {
      /* already idle */
    }
    this.playResource();
  }

  async waitForStart(timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.destroyed) {
        throw new Error(`${this.currentStation.name} stopped before audio started.`);
      }
      if (this.player.state.status === AudioPlayerStatus.Playing) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    if (this.player.state.status === AudioPlayerStatus.Playing) return;
    this.destroy();
    throw new Error(
      `Timed out waiting for ${this.currentStation.name} to start. Make sure FFmpeg is available.`,
    );
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearReconnectTimer();
    this.reconnectScheduled = false;
    this.deleteNowPlaying();

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
      this.logger.error(`${this.currentStation.name} player error:`, error);
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
        if (this.ignoreIdle) {
          this.ignoreIdle = false;
          return;
        }
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

  private deleteNowPlaying(): void {
    const old = this.nowPlayingMessage;
    this.nowPlayingMessage = null;
    if (!old) return;
    void old.delete().catch(() => {
      /* already deleted / missing access */
    });
  }

  private playResource(): void {
    if (this.destroyed) return;
    const resource = createAudioResource(this.currentStation.streamUrl, { inlineVolume: true });
    this.player.play(resource);
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectScheduled) return;

    if (this.reconnectFailures >= MAX_RECONNECT_ATTEMPTS) {
      this.logger.error(
        `${this.currentStation.name}: giving up after ${MAX_RECONNECT_ATTEMPTS} consecutive reconnect failures.`,
      );
      this.destroy();
      return;
    }

    const delay =
      RECONNECT_BACKOFF_MS[Math.min(this.reconnectFailures, RECONNECT_BACKOFF_MS.length - 1)]!;
    this.reconnectFailures += 1;
    this.reconnectScheduled = true;

    this.logger.warn(
      `${this.currentStation.name} stream interrupted — reconnecting in ${delay}ms (attempt ${this.reconnectFailures}/${MAX_RECONNECT_ATTEMPTS}).`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectScheduled = false;
      if (this.destroyed) return;
      try {
        this.playResource();
      } catch (error) {
        this.logger.error(`${this.currentStation.name} reconnect failed:`, error);
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

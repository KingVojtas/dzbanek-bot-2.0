import type { Readable } from 'node:stream';
import type { Track, TrackSource } from '../../core/types';
import { SpotifySource, isSpotifyUrl } from './spotify';
import { YouTubeSource, isYouTubeUrl } from './youtube';

/**
 * Routes queries to Spotify or YouTube. Audio is always streamed from YouTube
 * (Spotify is metadata-only).
 */
export class CompositeTrackSource implements TrackSource {
  readonly youtube: YouTubeSource;
  readonly spotify: SpotifySource;

  constructor(youtubeClients?: string | null) {
    this.youtube = new YouTubeSource(youtubeClients);
    this.spotify = new SpotifySource(this.youtube);
  }

  async resolve(input: string, requestedBy: string): Promise<Track[]> {
    if (isSpotifyUrl(input)) {
      return this.spotify.resolve(input, requestedBy);
    }
    return this.youtube.resolve(input, requestedBy);
  }

  /** Spotify albums/playlists arrive in ordered runs; anything else arrives at once. */
  resolveProgressive(
    input: string,
    requestedBy: string,
    onTracks: (tracks: Track[]) => void,
  ): Promise<{ total: number; matched: number }> {
    return this.spotify.resolveProgressive(input, requestedBy, onTracks);
  }

  /** Start audio for a YouTube video, or for a text search, while the title is still loading. */
  warm(input: string): void {
    const trimmed = input.trim();
    if (!trimmed || isSpotifyUrl(trimmed)) return;
    if (isYouTubeUrl(trimmed) && !/[?&]list=|\/playlist\?/i.test(trimmed)) {
      this.youtube.warm(trimmed);
      return;
    }
    if (!isYouTubeUrl(trimmed)) this.youtube.warmSearch(trimmed);
  }

  stream(track: Track): Promise<Readable> {
    return this.youtube.stream(track);
  }
}

export { isSpotifyAlbumUrl, isSpotifyPlaylistUrl, isSpotifyUrl } from './spotify';

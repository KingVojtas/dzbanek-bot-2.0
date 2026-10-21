import type { Readable } from 'node:stream';
import type { Track, TrackSource } from '../../core/types';
import { SpotifySource, isSpotifyUrl } from './spotify';
import { YouTubeSource, isYouTubeUrl } from './youtube';

/**
 * Routes queries to Spotify or YouTube. Audio is always streamed from YouTube
 * (Spotify is metadata-only).
 */
export class CompositeTrackSource implements TrackSource {
  readonly youtube = new YouTubeSource();
  readonly spotify = new SpotifySource(this.youtube);

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

  /** Start streaming a single YouTube video while its metadata resolves. */
  warm(input: string): void {
    if (isYouTubeUrl(input) && !/[?&]list=|\/playlist\?/i.test(input)) this.youtube.warm(input);
  }

  stream(track: Track): Promise<Readable> {
    return this.youtube.stream(track);
  }
}

export { isSpotifyAlbumUrl, isSpotifyPlaylistUrl, isSpotifyUrl } from './spotify';

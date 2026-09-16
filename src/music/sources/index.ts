import type { Readable } from 'node:stream';
import type { Track, TrackSource } from '../../core/types';
import { SpotifySource, isSpotifyUrl } from './spotify';
import { YouTubeSource } from './youtube';

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

  stream(track: Track): Promise<Readable> {
    return this.youtube.stream(track);
  }
}

export { isSpotifyAlbumUrl, isSpotifyPlaylistUrl, isSpotifyUrl } from './spotify';

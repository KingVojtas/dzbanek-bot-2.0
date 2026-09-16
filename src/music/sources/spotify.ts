import type { Track } from '../../core/types';
import { YouTubeSource } from './youtube';

const SPOTIFY_WEB = /open\.spotify\.com\/(track|album|playlist)\/([A-Za-z0-9]+)/i;
const SPOTIFY_URI = /spotify:(track|album|playlist):([A-Za-z0-9]+)/i;
const PLAYLIST_CAP = 50;
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_BASE = 'https://api.spotify.com/v1';

interface SpotifyToken {
  access_token: string;
  expires_at: number;
}

interface SpotifyArtist {
  name: string;
}

interface SpotifyImage {
  url: string;
}

interface SpotifyTrackPayload {
  id: string;
  name: string;
  duration_ms: number;
  artists: SpotifyArtist[];
  album?: { images?: SpotifyImage[]; name?: string };
  external_urls?: { spotify?: string };
}

interface SpotifyPaging<T> {
  items: T[];
  next: string | null;
}

let cachedToken: SpotifyToken | null = null;

export function isSpotifyUrl(input: string): boolean {
  return SPOTIFY_WEB.test(input) || SPOTIFY_URI.test(input);
}

export function isSpotifyAlbumUrl(input: string): boolean {
  const kind = parseSpotifyRef(input)?.kind;
  return kind === 'album';
}

export function isSpotifyPlaylistUrl(input: string): boolean {
  const kind = parseSpotifyRef(input)?.kind;
  return kind === 'playlist';
}

async function oembedTitle(spotifyUrl: string): Promise<string | null> {
  try {
    const response = await fetch(
      `https://open.spotify.com/oembed?url=${encodeURIComponent(spotifyUrl)}`,
    );
    if (!response.ok) return null;
    const json = (await response.json()) as { title?: string };
    return json.title?.trim() || null;
  } catch {
    return null;
  }
}

function parseSpotifyRef(input: string): { kind: 'track' | 'album' | 'playlist'; id: string } | null {
  const web = input.match(SPOTIFY_WEB);
  if (web?.[1] && web[2]) {
    return { kind: web[1].toLowerCase() as 'track' | 'album' | 'playlist', id: web[2] };
  }
  const uri = input.match(SPOTIFY_URI);
  if (uri?.[1] && uri[2]) {
    return { kind: uri[1].toLowerCase() as 'track' | 'album' | 'playlist', id: uri[2] };
  }
  return null;
}

function credentials(): { id: string; secret: string } | null {
  const id = process.env.SPOTIFY_CLIENT_ID?.trim();
  const secret = process.env.SPOTIFY_CLIENT_SECRET?.trim();
  if (!id || !secret) return null;
  return { id, secret };
}

async function getToken(): Promise<string> {
  const creds = credentials();
  if (!creds) {
    throw new Error(
      'SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET are required for Spotify playlists and albums.',
    );
  }

  if (cachedToken && Date.now() < cachedToken.expires_at) {
    return cachedToken.access_token;
  }

  const basic = Buffer.from(`${creds.id}:${creds.secret}`).toString('base64');
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!response.ok) {
    throw new Error(`Spotify auth failed (HTTP ${response.status}). Check SPOTIFY_CLIENT_ID / SECRET.`);
  }

  const json = (await response.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    access_token: json.access_token,
    expires_at: Date.now() + (json.expires_in - 60) * 1000,
  };
  return cachedToken.access_token;
}

async function spotifyGet<T>(path: string): Promise<T> {
  const token = await getToken();
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Spotify API HTTP ${response.status}: ${body.slice(0, 200) || response.statusText}`);
  }
  return (await response.json()) as T;
}

function artistNames(track: SpotifyTrackPayload): string {
  return (track.artists ?? []).map((a) => a.name).filter(Boolean).join(', ');
}

function spotifyPageUrl(track: SpotifyTrackPayload): string {
  return track.external_urls?.spotify || `https://open.spotify.com/track/${track.id}`;
}

export class SpotifySource {
  constructor(private readonly youtube: YouTubeSource) {}

  async resolve(input: string, requestedBy: string): Promise<Track[]> {
    const ref = parseSpotifyRef(input.trim());
    if (!ref) return [];

    if (!credentials()) {
      if (ref.kind === 'track') {
        const pageUrl = `https://open.spotify.com/track/${ref.id}`;
        const query = (await oembedTitle(pageUrl)) ?? input;
        const fallback = await this.youtube.searchOne(query, requestedBy, {
          source: 'spotify',
          sourceUrl: pageUrl,
        });
        return fallback ? [fallback] : [];
      }
      throw new Error(
        'SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET are required to resolve Spotify playlists and albums.',
      );
    }

    if (ref.kind === 'track') {
      const payload = await spotifyGet<SpotifyTrackPayload>(`/tracks/${ref.id}`);
      const track = await this.matchTrack(payload, requestedBy);
      return track ? [track] : [];
    }

    const payloads =
      ref.kind === 'album' ? await this.fetchAlbumTracks(ref.id) : await this.fetchPlaylistTracks(ref.id);

    const tracks: Track[] = [];
    for (const payload of payloads.slice(0, PLAYLIST_CAP)) {
      try {
        const matched = await this.matchTrack(payload, requestedBy);
        if (matched) tracks.push(matched);
      } catch {
        // Skip unmatchable items; keep the rest of the album/playlist.
      }
    }
    return tracks;
  }

  private async fetchAlbumTracks(id: string): Promise<SpotifyTrackPayload[]> {
    const album = await spotifyGet<{
      name: string;
      images?: SpotifyImage[];
      tracks: SpotifyPaging<SpotifyTrackPayload>;
    }>(`/albums/${id}?market=US`);

    const items: SpotifyTrackPayload[] = [...(album.tracks.items ?? [])];
    let next = album.tracks.next;
    while (next && items.length < PLAYLIST_CAP) {
      const page = await spotifyGet<SpotifyPaging<SpotifyTrackPayload>>(
        next.replace(API_BASE, ''),
      );
      items.push(...page.items);
      next = page.next;
    }

    return items.map((t) => ({
      ...t,
      album: { name: album.name, images: album.images },
    }));
  }

  private async fetchPlaylistTracks(id: string): Promise<SpotifyTrackPayload[]> {
    const items: SpotifyTrackPayload[] = [];
    let path: string | null = `/playlists/${id}/tracks?market=US&limit=50`;

    while (path && items.length < PLAYLIST_CAP) {
      const page: SpotifyPaging<{ track: SpotifyTrackPayload | null }> = await spotifyGet(path);
      for (const row of page.items) {
        if (row.track?.id && row.track.name) items.push(row.track);
        if (items.length >= PLAYLIST_CAP) break;
      }
      path = page.next ? page.next.replace(API_BASE, '') : null;
    }
    return items;
  }

  private async matchTrack(payload: SpotifyTrackPayload, requestedBy: string): Promise<Track | null> {
    const artists = artistNames(payload);
    const query = artists ? `${artists} - ${payload.name}` : payload.name;
    const thumbnail = payload.album?.images?.[0]?.url;

    const matched = await this.youtube.searchOne(query, requestedBy, {
      source: 'spotify',
      sourceUrl: spotifyPageUrl(payload),
    });
    if (!matched) return null;

    return {
      ...matched,
      title: payload.name || matched.title,
      durationSec:
        typeof payload.duration_ms === 'number' && payload.duration_ms > 0
          ? Math.round(payload.duration_ms / 1000)
          : matched.durationSec,
      uploader: artists || matched.uploader,
      thumbnail: thumbnail || matched.thumbnail,
      source: 'spotify',
      sourceUrl: spotifyPageUrl(payload),
    };
  }
}

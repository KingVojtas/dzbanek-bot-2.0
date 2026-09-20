export type StationId = 'kiss' | 'rock' | 'beat';

export interface RadioStation {
  id: StationId;
  /** Discord slash-choice label. */
  choiceName: string;
  name: string;
  slogan: string;
  streamUrl: string;
  websiteUrl: string;
  /** Embed accent matching the station brand. */
  color: number;
  /** Official square logo (thumbnail). */
  logoUrl: string;
  /** Official photo / social artwork (large embed image). */
  imageUrl: string;
}

/**
 * Live Icecast stations. Stream URLs are the station's published 128 kbps MP3 feeds.
 * Artwork is loaded from each station's official site (PNG/JPEG — Discord cannot render SVG).
 */
export const STATIONS: Record<StationId, RadioStation> = {
  kiss: {
    id: 'kiss',
    choiceName: 'Kiss',
    name: 'Radio Kiss',
    slogan: 'be happy!',
    streamUrl: 'https://icecast4.play.cz/kiss128.mp3',
    websiteUrl: 'https://www.kiss.cz/',
    color: 0xec008c,
    logoUrl: 'https://www.kiss.cz/data/download/Kiss_BeHappy.png',
    imageUrl: 'https://www.kiss.cz/assets/images/download/Tapeta_Kiss_4k_3840x2160_PC-TABLET.jpg',
  },
  rock: {
    id: 'rock',
    choiceName: 'Rock Radio',
    name: 'Rock Radio',
    slogan: 'Rock je slušná muzika',
    streamUrl: 'http://ice.abradio.cz/rockradio128.mp3',
    websiteUrl: 'https://rockovyradio.cz/',
    color: 0xc8102e,
    logoUrl: 'https://rockovyradio.cz/design/favicon/android-icon-192x192.png',
    imageUrl: 'https://rockovyradio.cz/design/img/img-social-networks-default.jpg',
  },
  beat: {
    id: 'beat',
    choiceName: 'Radio Beat',
    name: 'Radio Beat',
    slogan: 'První bigbít u nás',
    streamUrl: 'https://icecast3.play.cz/radiobeat128.mp3',
    websiteUrl: 'https://www.radiobeat.cz/',
    color: 0xf5c400,
    logoUrl: 'https://www.radiobeat.cz/img/logo.png',
    imageUrl: 'https://www.radiobeat.cz/img/logo@2x.png',
  },
};

export const STATION_LIST: RadioStation[] = Object.values(STATIONS);

export function getStation(id: string): RadioStation | undefined {
  if (id in STATIONS) return STATIONS[id as StationId];
  return undefined;
}

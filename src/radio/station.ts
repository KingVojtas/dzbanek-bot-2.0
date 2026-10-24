export type StationId = 'kiss' | 'rock' | 'beat' | 'frekvence1' | 'heart' | 'capital' | 'paradise';

export interface RadioStation {
  id: StationId;
  /** Discord slash-choice label. */
  choiceName: string;
  /** Short name on the Radio Night vote button and tally. */
  voteName: string;
  /** Radio Night vote button emoji. */
  emoji: string;
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
  /** Optional JSON now-playing endpoint (radia.cz). */
  nowPlayingUrl?: string;
  /** Optional Nette snippet URL that returns current on-air HTML. */
  nowPlayingSnippetUrl?: string;
  /** Optional Triton Digital mount with a public now-playing feed. */
  tritonMount?: string;
}

/**
 * Live Icecast stations. Stream URLs are the station's published 128 kbps MP3 feeds.
 * The order here is the order of /radio choices and the Radio Night vote buttons.
 * Artwork is loaded from each station's official site (PNG/JPEG — Discord cannot render SVG).
 */
export const STATIONS: Record<StationId, RadioStation> = {
  kiss: {
    id: 'kiss',
    choiceName: 'Kiss',
    voteName: 'Kiss',
    emoji: '💋',
    name: 'Kiss Radio',
    slogan: '...be happy!',
    streamUrl: 'https://icecast4.play.cz/kiss128.mp3',
    websiteUrl: 'https://www.kiss.cz/',
    color: 0xe30613,
    logoUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/9/9b/Logo_Radio_Kiss.svg/500px-Logo_Radio_Kiss.svg.png',
    imageUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/9/9b/Logo_Radio_Kiss.svg/960px-Logo_Radio_Kiss.svg.png',
    nowPlayingUrl: 'https://radia.cz/api/v1/radio/radio-kiss/songs/now.json',
  },
  rock: {
    id: 'rock',
    choiceName: 'Rock Radio',
    voteName: 'Rock',
    emoji: '🎸',
    name: 'Rock Radio',
    slogan: 'Rock je slušná muzika',
    streamUrl: 'http://ice.abradio.cz/rockradio128.mp3',
    websiteUrl: 'https://rockovyradio.cz/',
    color: 0xc8102e,
    // Favicon PNGs are a crossed-out glyph. This JPEG is the ROCK RADIO wordmark.
    logoUrl: 'https://rockovyradio.cz/design/img/img-social-networks-default.jpg',
    imageUrl: 'https://rockovyradio.cz/design/img/img-social-networks-default.jpg',
    nowPlayingUrl: 'https://radia.cz/api/v1/radio/rock-radio/songs/now.json',
  },
  beat: {
    id: 'beat',
    choiceName: 'Radio Beat',
    voteName: 'Beat',
    emoji: '🥁',
    name: 'Radio Beat',
    slogan: 'První bigbít u nás',
    streamUrl: 'https://icecast3.play.cz/radiobeat128.mp3',
    websiteUrl: 'https://www.radiobeat.cz/',
    color: 0xf5c400,
    logoUrl: 'https://www.radiobeat.cz/img/logo.png',
    imageUrl: 'https://www.radiobeat.cz/img/logo@2x.png',
    nowPlayingUrl: 'https://radia.cz/api/v1/radio/radio-beat/songs/now.json',
    nowPlayingSnippetUrl: 'https://www.radiobeat.cz/?do=broadcast-update',
  },
  frekvence1: {
    id: 'frekvence1',
    choiceName: 'Frekvence 1',
    voteName: 'F1',
    emoji: '1️⃣',
    name: 'Frekvence 1',
    slogan: 'Zapni rádio, vypni starosti',
    streamUrl: 'https://ice.actve.net/fm-frekvence1-128',
    websiteUrl: 'https://www.frekvence1.cz/',
    color: 0x0033a0,
    logoUrl: 'https://www.frekvence1.cz/img/favicons/apple-touch-icon.png',
    imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/e/e6/Frekvence_1.png',
    // ICY is blank on this stream. Triton carries the artist and title.
    tritonMount: 'FREKVENCE1',
  },
  heart: {
    id: 'heart',
    choiceName: 'Heart London',
    voteName: 'Heart',
    emoji: '❤️',
    name: 'Heart London',
    slogan: 'Turn up the feel good!',
    streamUrl: 'https://media-ssl.musicradio.com/HeartLondonMP3',
    websiteUrl: 'https://www.heart.co.uk/',
    color: 0xe2003b,
    logoUrl: 'https://assets.heart.co.uk/2024/44/heart-logo-1730829405-list-handheld-0.png',
    imageUrl: 'https://assets.heart.co.uk/2024/44/heart-logo-1730829405-list-handheld-0.png',
  },
  capital: {
    id: 'capital',
    choiceName: 'Capital London',
    voteName: 'Capital',
    emoji: '🎤',
    name: 'Capital London',
    slogan: 'The UK’s No.1 Hit Music Station',
    streamUrl: 'https://media-ssl.musicradio.com/CapitalMP3',
    websiteUrl: 'https://www.capitalfm.com/',
    color: 0x1472f5,
    logoUrl:
      'https://imgs.capitalfm.com/images/573609?format=png&signature=fxgDCsRPRQMvt-WaQM8YWFAMFa8=',
    imageUrl:
      'https://imgs.capitalfm.com/images/573609?format=png&signature=fxgDCsRPRQMvt-WaQM8YWFAMFa8=',
  },
  paradise: {
    id: 'paradise',
    choiceName: 'Radio Paradise',
    voteName: 'Paradise',
    emoji: '🌴',
    name: 'Radio Paradise',
    slogan: 'Human curated radio',
    streamUrl: 'https://stream.radioparadise.com/mp3-128',
    websiteUrl: 'https://radioparadise.com/',
    color: 0x356457,
    logoUrl: 'https://vsh-smedia.radioparadise.com/uploads/RP_Logo_Flat_HCR_Green_1_18a033c355.png',
    imageUrl:
      'https://vsh-smedia.radioparadise.com/uploads/RP_Logo_Flat_HCR_Green_1_18a033c355.png',
  },
};

export const STATION_LIST: RadioStation[] = Object.values(STATIONS);

export function getStation(id: string): RadioStation | undefined {
  if (id in STATIONS) return STATIONS[id as StationId];
  return undefined;
}

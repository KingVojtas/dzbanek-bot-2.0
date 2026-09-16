const REVIEWS_BASE = 'https://store.steampowered.com/appreviews';
const PASSING_SCORE = 8;
const MIN_POSITIVE_PCT = 80;
const MIN_REVIEWS = 10;

interface RawQuerySummary {
  num_reviews: number;
  review_score: number;
  review_score_desc: string;
  total_positive: number;
  total_negative: number;
  total_reviews: number;
}

interface RawReviewsResponse {
  success: 1 | 0;
  query_summary: RawQuerySummary;
}

export interface SteamReviewInfo {
  score: number;
  scoreDesc: string;
  totalReviews: number;
  positivePct: number;
}

export function isGoodReview(info: SteamReviewInfo): boolean {
  if (info.totalReviews < MIN_REVIEWS) return false;
  return info.score >= PASSING_SCORE || info.positivePct >= MIN_POSITIVE_PCT;
}

export async function fetchSteamReview(appId: string): Promise<SteamReviewInfo | null> {
  const url = `${REVIEWS_BASE}/${appId}?json=1&language=all&purchase_type=all`;

  let response: Response;
  try {
    response = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch {
    return null;
  }

  if (!response.ok) return null;

  let json: RawReviewsResponse;
  try {
    json = (await response.json()) as RawReviewsResponse;
  } catch {
    return null;
  }

  if (json.success !== 1) return null;

  const s = json.query_summary;
  const positivePct =
    s.total_reviews > 0 ? Math.round((s.total_positive / s.total_reviews) * 100) : 0;

  return {
    score: s.review_score,
    scoreDesc: s.review_score_desc,
    totalReviews: s.total_reviews,
    positivePct,
  };
}

export function formatReview(info: SteamReviewInfo): string {
  return `⭐ **${info.scoreDesc}** (${info.positivePct}%)`;
}

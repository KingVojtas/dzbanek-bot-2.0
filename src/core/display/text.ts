/** Square brackets would break the markdown link around a title. */
export function linkText(value: string, limit: number): string {
  return value.replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

export function linked(text: string, url: string | undefined): string {
  return url && /^https?:\/\//i.test(url) ? `[${text}](${url})` : text;
}

/** Discord timestamp: it ticks in every reader's own clock. Empty when unreadable. */
export function discordTime(iso: string | undefined, style: 'R' | 'D' | 'f' | 't'): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

/** "1.234,56€", "59,99€", "$19.99" → cents. Null when no number is there. */
export function moneyToCents(value: string | undefined): number | null {
  const digits = value?.replace(/[^\d.,]/g, '') ?? '';
  if (!/\d/.test(digits)) return null;
  const match = digits.match(/^(.*?)[.,](\d{2})$/);
  const whole = (match ? match[1]! : digits).replace(/[.,]/g, '');
  const cents = Number(whole || '0') * 100 + (match ? Number(match[2]) : 0);
  return Number.isFinite(cents) ? cents : null;
}

/** Steam's own euro style: `1.234,56€`. */
export function euros(cents: number): string {
  const whole = Math.floor(cents / 100).toLocaleString('de-DE');
  return `${whole},${String(cents % 100).padStart(2, '0')}€`;
}

export function plainBlurb(value: string | undefined, limit = 150): string {
  if (!value) return '';
  const text = value
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*_`[\]~|>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit - 1);
  const word = cut.lastIndexOf(' ');
  return `${(word > 80 ? cut.slice(0, word) : cut).trimEnd()}…`;
}

export function pragueDay(): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'Europe/Prague',
  }).format(new Date());
}

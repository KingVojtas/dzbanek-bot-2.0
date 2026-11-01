import { SITE_CLAY, buildSiteEmbed, type EmbedCard } from '../embeds';
import type { StatusRow } from '../host-status';

/**
 * The /status card. Rows are already filled in (host, bot, and any a later
 * part of the bot appended), so this only decides how they sit on the card.
 */
export function buildStatusDisplay(rows: readonly StatusRow[]): EmbedCard {
  return {
    embeds: [
      buildSiteEmbed({
        color: SITE_CLAY,
        author: '🖥️ Mac mini',
        title: 'How the kitchen’s machine is doing',
        fields: rows.map((row) => [row.name, row.value, true]),
        footer: 'Only you can see this',
        timestamp: Date.now(),
      }),
    ],
    components: [],
  };
}

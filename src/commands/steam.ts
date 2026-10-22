import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { buildWishlistRadarDisplay } from '../core/display';
import { buildReplyEmbed, type ReplyTone } from '../core/embeds';
import type { Command, Services } from '../core/types';
import { fetchWishlist, resolveSteamId } from '../deals/steam/SteamWishlist';

const PRIVATE_HELP =
  'Steam shows a wishlist only when it is public: Steam → **Edit Profile** → **Privacy Settings** → ' +
  '**Game details: Public**. Then run `/steam link` again.';

async function answer(
  interaction: ChatInputCommandInteraction,
  tone: ReplyTone,
  description: string,
): Promise<void> {
  await interaction.editReply({ embeds: [buildReplyEmbed(tone, description)] });
}

async function link(interaction: ChatInputCommandInteraction, services: Services): Promise<void> {
  const input = interaction.options.getString('profile', true);
  const steamId = await resolveSteamId(input);
  if (!steamId) {
    await answer(
      interaction,
      'warn',
      '🔍 I could not find that Steam profile. Paste your profile link, like ' +
        '`https://steamcommunity.com/id/yourname`.',
    );
    return;
  }
  const wishlist = await fetchWishlist(steamId);
  if (wishlist === null) {
    await answer(interaction, 'error', '❌ Steam did not answer. Try again in a minute.');
    return;
  }
  await services.steamLinks.set(interaction.user.id, steamId);
  if (wishlist.length === 0) {
    await answer(
      interaction,
      'warn',
      `🔗 Linked, but I see an empty wishlist. If yours has games, it is private.\n${PRIVATE_HELP}`,
    );
    return;
  }
  await answer(
    interaction,
    'success',
    `🎯 Linked. I am watching **${wishlist.length}** game(s) on your wishlist. When one goes on ` +
      'sale, the Steam channel pings you once. `/steam wishlist` shows what is on sale right now.',
  );
}

async function unlink(interaction: ChatInputCommandInteraction, services: Services): Promise<void> {
  const removed = await services.steamLinks.remove(interaction.user.id);
  await answer(
    interaction,
    removed ? 'success' : 'info',
    removed
      ? '👋 Unlinked. Wishlist Radar no longer watches your wishlist.'
      : 'Your Steam profile was not linked.',
  );
}

async function wishlist(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  const row = await services.steamLinks.get(interaction.user.id);
  if (!row) {
    await answer(interaction, 'warn', '🔗 Link your Steam profile first: `/steam link`.');
    return;
  }
  const hits = await services.wishlistRadar.scanOne(row.userId, row.steamId);
  if (hits === null) {
    await answer(interaction, 'error', '❌ Steam did not answer. Try again in a minute.');
    return;
  }
  if (hits.length === 0) {
    await answer(
      interaction,
      'info',
      `Nothing on your wishlist is on sale right now. If it has games, check that it is public.\n${PRIVATE_HELP}`,
    );
    return;
  }
  const display = buildWishlistRadarDisplay(
    { together: [], people: [{ userId: row.userId, games: hits }] },
    10,
  );
  await interaction.editReply({
    components: display.components,
    flags: display.flags,
    allowedMentions: { parse: [] },
  });
}

export const steam: Command = {
  data: new SlashCommandBuilder()
    .setName('steam')
    .setDescription('Wishlist Radar: get pinged when a game on your Steam wishlist goes on sale.')
    .addSubcommand((sub) =>
      sub
        .setName('link')
        .setDescription('Link your Steam profile so the radar can watch your wishlist.')
        .addStringOption((option) =>
          option
            .setName('profile')
            .setDescription('Your profile link, custom name, or 17-digit Steam ID')
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('unlink').setDescription('Stop watching your Steam wishlist.'),
    )
    .addSubcommand((sub) =>
      sub.setName('wishlist').setDescription('See what on your wishlist is on sale right now.'),
    ),

  async execute(interaction, services) {
    // Steam can take a few seconds; every answer is only for the caller.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const sub = interaction.options.getSubcommand();
    if (sub === 'link') await link(interaction, services);
    else if (sub === 'unlink') await unlink(interaction, services);
    else await wishlist(interaction, services);
  },
};

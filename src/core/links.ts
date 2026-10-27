import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  type MessageActionRowComponentBuilder,
} from 'discord.js';

export const SITE_URL = 'https://kingvojtas.github.io/dzbanek-bot-website/';
export const PRIVACY_URL = `${SITE_URL}privacy.html`;

/**
 * What the bot asks for on a new server: read and write, embed and attach
 * images, read back its own cards, react to deals, make rooms, and join voice.
 * The Developer Portal's install link asks for the same (3263568).
 */
export const INSTALL_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AddReactions,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.Speak,
].reduce((all, flag) => all | flag, 0n);

/** The link that adds Dzbanek to another server. */
export function installUrl(clientId: string): string {
  return (
    `https://discord.com/oauth2/authorize?client_id=${clientId}` +
    `&permissions=${INSTALL_PERMISSIONS}&scope=bot%20applications.commands`
  );
}

function linkButton(label: string, emoji: string, url: string): ButtonBuilder {
  return new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(label).setEmoji(emoji).setURL(url);
}

/** Website and "add to a server" buttons, for /help. */
export function shareRow(clientId: string): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    linkButton('Add to a server', '➕', installUrl(clientId)),
    linkButton('Website', '🌐', SITE_URL),
  );
}

/** Website and privacy buttons, for the hello card on a new server. */
export function aboutRow(): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    linkButton('Website', '🌐', SITE_URL),
    linkButton('Privacy', '🔒', PRIVACY_URL),
  );
}

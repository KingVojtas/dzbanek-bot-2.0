import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SectionBuilder,
  SeparatorBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
  type MessageActionRowComponentBuilder,
} from 'discord.js';

/** Discord's cap on components in one message, nested ones included. */
export const V2_COMPONENT_MAX = 40;

/** Components V2 message: Steam, Epic, the Kitchen Board, and the cards beside them. */
export interface V2Display {
  components: ContainerBuilder[];
  flags: typeof MessageFlags.IsComponentsV2;
}

/** Every node with a component type counts toward the cap: buttons, thumbnails, and all. */
export function countV2Components(containers: { toJSON(): unknown }[]): number {
  let count = 0;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const rec = node as Record<string, unknown>;
    if (typeof rec.type === 'number') count += 1;
    for (const value of Object.values(rec)) {
      if (value && typeof value === 'object') walk(value);
    }
  };
  walk(containers.map((container) => container.toJSON()));
  return count;
}

/** Discord's cap on all the text in one Components V2 message. */
export const V2_TEXT_MAX = 4000;

/** Every text display's content, added up. */
export function v2TextLength(containers: { toJSON(): unknown }[]): number {
  let length = 0;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const rec = node as Record<string, unknown>;
    if (typeof rec.content === 'string') length += rec.content.length;
    for (const value of Object.values(rec)) {
      if (value && typeof value === 'object') walk(value);
    }
  };
  walk(containers.map((container) => container.toJSON()));
  return length;
}

/** Inside both caps: the component count and the text. */
export function fitsV2(containers: { toJSON(): unknown }[]): boolean {
  return (
    countV2Components(containers) <= V2_COMPONENT_MAX && v2TextLength(containers) <= V2_TEXT_MAX
  );
}

export function thumbnailFor(url: string | undefined, alt: string): ThumbnailBuilder | null {
  if (!url || !/^(https?:\/\/|attachment:\/\/)/i.test(url)) return null;
  return new ThumbnailBuilder().setURL(url).setDescription(alt.slice(0, 100) || 'Artwork');
}

export function httpImage(url: string | undefined): string | undefined {
  if (!url || !/^https?:\/\//i.test(url)) return undefined;
  return url;
}

export function textBlock(lines: string[]): TextDisplayBuilder {
  return new TextDisplayBuilder().setContent(lines.filter(Boolean).join('\n').slice(0, 4000));
}

/**
 * A section has to carry a thumbnail or a button. Art wins; a store link
 * stands in when the art is missing, so a row never loses its shape.
 */
export function artSection(
  lines: string[],
  art: string | undefined,
  alt: string,
  fallback?: { label: string; url: string | undefined },
): SectionBuilder | TextDisplayBuilder {
  const text = textBlock(lines);
  const thumb = thumbnailFor(art, alt);
  if (thumb)
    return new SectionBuilder().addTextDisplayComponents(text).setThumbnailAccessory(thumb);
  if (fallback?.url && /^https?:\/\//i.test(fallback.url)) {
    return new SectionBuilder()
      .addTextDisplayComponents(text)
      .setButtonAccessory(
        new ButtonBuilder()
          .setStyle(ButtonStyle.Link)
          .setLabel(fallback.label)
          .setURL(fallback.url),
      );
  }
  return text;
}

export function addBlock(
  container: ContainerBuilder,
  block: SectionBuilder | TextDisplayBuilder,
): void {
  if (block instanceof SectionBuilder) container.addSectionComponents(block);
  else container.addTextDisplayComponents(block);
}

export function divider(): SeparatorBuilder {
  return new SeparatorBuilder().setDivider(true);
}

export function linkButton(label: string, url: string, emoji?: string): ButtonBuilder {
  const button = new ButtonBuilder()
    .setStyle(ButtonStyle.Link)
    .setLabel(label.length <= 80 ? label : `${label.slice(0, 79).trimEnd()}…`)
    .setURL(url);
  return emoji ? button.setEmoji(emoji) : button;
}

export function linkRow(
  buttons: ButtonBuilder[],
): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    buttons.slice(0, 5),
  );
}

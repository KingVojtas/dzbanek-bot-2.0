import {
  ChannelType,
  ContainerBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SectionBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
  type Guild,
  type TextChannel,
} from 'discord.js';
import type { V2Display } from '../core/display/v2';
import { aboutRow } from '../core/links';

/** Same amber as /help. */
const HELLO_COLOR = 0xc4783a;

const HELLO = [
  '## 🍪 Hi, I’m Dzbanek',
  'The kitchen’s stereo, now in yours. Here’s how to get cooking:',
  '',
  '**📻 Radio** · join a voice channel, type `/radio play`, and pick one of seven live stations.',
  '**🎵 Music** · `/play` a song name, or a YouTube or Spotify link.',
  '**🎙️ Kitchen FM** · after a few songs, `/radio play station:Kitchen FM` starts your server’s own station, with a DJ.',
  '**🍪 Kitchen Board** · an admin can hang a live board with `/setup kitchen`.',
  '**💸 Deals** · Steam deals and Epic freebies go to a channel named like #steam, #deals or #epic, or wherever `/setup steam` and `/setup epic` point.',
  '',
  '`/help` lists every command.',
].join('\n');

/** The card Dzbanek posts once, when it joins a server. */
export function buildHelloDisplay(avatarUrl?: string): V2Display {
  const text = new TextDisplayBuilder().setContent(HELLO);
  const container = new ContainerBuilder().setAccentColor(HELLO_COLOR);
  if (avatarUrl && /^https?:\/\//i.test(avatarUrl)) {
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(text)
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(avatarUrl)),
    );
  } else {
    container.addTextDisplayComponents(text);
  }
  container.addActionRowComponents(aboutRow());
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

/**
 * Where to say hello: the server's system channel when the bot may post there,
 * else the first text channel it can write in.
 */
export function helloChannel(guild: Guild): TextChannel | null {
  const me = guild.members.me;
  if (!me) return null;
  const canPost = (channel: TextChannel) =>
    channel
      .permissionsFor(me)
      .has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]);

  const system = guild.systemChannel;
  if (system && canPost(system)) return system;

  const texts = [...guild.channels.cache.values()]
    .filter((channel): channel is TextChannel => channel.type === ChannelType.GuildText)
    .sort((a, b) => a.rawPosition - b.rawPosition);
  return texts.find(canPost) ?? null;
}

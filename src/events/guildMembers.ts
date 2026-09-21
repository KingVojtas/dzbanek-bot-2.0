import { Events, type Client, type GuildMember, type PartialGuildMember } from 'discord.js';
import type { Services } from '../core/types';
import { goodbyeMessage, welcomeMessage } from '../greetings/messages';
import { resolveGreetingChannel } from '../greetings/resolve-channel';

export function registerGuildMemberEvents(client: Client, services: Services): void {
  client.on(Events.GuildMemberAdd, async (member) => {
    try {
      await sendWelcome(member, services);
    } catch (error) {
      services.logger.error('Welcome handler failed:', error);
    }
  });

  client.on(Events.GuildMemberRemove, async (member) => {
    try {
      await sendGoodbye(member, services);
    } catch (error) {
      services.logger.error('Goodbye handler failed:', error);
    }
  });
}

async function sendWelcome(member: GuildMember, services: Services): Promise<void> {
  if (member.user.bot) return;
  await services.kitchen.noteJoin(member.guild.id).catch((error) => {
    services.logger.debug('Kitchen join counter failed:', error);
  });
  const channel = await resolveGreetingChannel(
    member.client,
    member.guild,
    services.guildSettings,
    services.config,
    services.logger,
    'welcome',
  );
  if (!channel) return;
  await channel.send({ content: welcomeMessage(`<@${member.id}>`) });
}

async function sendGoodbye(
  member: GuildMember | PartialGuildMember,
  services: Services,
): Promise<void> {
  const user = member.user;
  if (user?.bot) return;
  const channel = await resolveGreetingChannel(
    member.client,
    member.guild,
    services.guildSettings,
    services.config,
    services.logger,
    'goodbye',
  );
  if (!channel) return;
  const name =
    ('displayName' in member && member.displayName) ||
    user?.globalName ||
    user?.username ||
    'Someone';
  await channel.send({ content: goodbyeMessage(name) });
}

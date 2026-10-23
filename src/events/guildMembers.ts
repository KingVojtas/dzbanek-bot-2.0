import { Events, type Client, type GuildMember, type PartialGuildMember } from 'discord.js';
import type { Services } from '../core/types';
import {
  buildGoodbyeEmbed,
  buildWelcomeEmbed,
  type GreetingPerson,
  type GreetingPlace,
} from '../greetings/messages';
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
  await channel.send({
    ...ping(member.id),
    embeds: [buildWelcomeEmbed(welcomePerson(member), greetingPlace(member))],
  });
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
  await channel.send({
    ...ping(member.id),
    embeds: [
      buildGoodbyeEmbed(
        {
          name,
          mention: `<@${member.id}>`,
          avatarUrl: user?.displayAvatarURL({ size: 256 }),
          createdTimestamp: user?.createdTimestamp,
          joinedTimestamp: member.joinedTimestamp,
        },
        greetingPlace(member),
      ),
    ],
  });
}

/** Tags inside an embed never ping, so the tag rides in the message text. */
function ping(userId: string): { content: string; allowedMentions: { users: string[] } } {
  return { content: `<@${userId}>`, allowedMentions: { users: [userId] } };
}

function welcomePerson(member: GuildMember): GreetingPerson {
  return {
    name: member.displayName,
    mention: `<@${member.id}>`,
    avatarUrl: member.displayAvatarURL({ size: 256 }),
    createdTimestamp: member.user.createdTimestamp,
    joinedTimestamp: member.joinedTimestamp,
  };
}

function greetingPlace(member: GuildMember | PartialGuildMember): GreetingPlace {
  return {
    name: member.guild.name,
    iconUrl: member.guild.iconURL({ size: 128 }),
    memberCount: member.guild.memberCount,
  };
}

import { Events, type Client } from 'discord.js';
import type { Services } from '../core/types';
import { buildHelloDisplay, helloChannel } from '../greetings/hello';

/** A hello card when Dzbanek joins a server, and a log line when it comes or goes. */
export function registerGuildJoinEvents(client: Client, services: Services): void {
  client.on(Events.GuildCreate, async (guild) => {
    services.logger.info(
      `Joined ${guild.name} (${guild.id}, ${guild.memberCount} members). Now in ${client.guilds.cache.size} servers.`,
    );
    try {
      const channel = helloChannel(guild);
      if (!channel) return;
      await channel.send(buildHelloDisplay(client.user?.displayAvatarURL({ size: 256 })));
    } catch (error) {
      services.logger.warn(`Could not say hello in ${guild.name}:`, error);
    }
  });

  client.on(Events.GuildDelete, (guild) => {
    // An outage takes a server away for a while; that is not leaving it.
    if (!guild.available) return;
    services.logger.info(
      `Left ${guild.name} (${guild.id}). Now in ${client.guilds.cache.size} servers.`,
    );
  });
}

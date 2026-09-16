import { Events, type Client, type Collection } from 'discord.js';
import type { Command, Services } from '../core/types';
import { registerGuildMemberEvents } from './guildMembers';
import { registerInteractionCreate } from './interactionCreate';

export function registerEvents(
  client: Client,
  commands: Collection<string, Command>,
  services: Services,
): void {
  client.once(Events.ClientReady, (readyClient) => {
    services.logger.info(`Logged in as ${readyClient.user.tag} (${readyClient.user.id}).`);
  });

  registerInteractionCreate(client, commands, services);
  registerGuildMemberEvents(client, services);
}

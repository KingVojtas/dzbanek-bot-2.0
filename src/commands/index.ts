import { Collection } from 'discord.js';
import type { Command } from '../core/types';
import { setup } from './admin/setup';
import { radio } from './radio';
import { play } from './music/play';
import { queue } from './music/queue';
import { remove } from './music/remove';
import { stop } from './music/stop';

const commandList: Command[] = [setup, radio, play, queue, stop, remove];

export function buildCommandCollection(): Collection<string, Command> {
  const commands = new Collection<string, Command>();
  for (const command of commandList) {
    commands.set(command.data.name, command);
  }
  return commands;
}

export { commandList };

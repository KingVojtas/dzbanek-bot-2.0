import { Collection } from 'discord.js';
import type { Command } from '../core/types';
import { setup } from './admin/setup';
import { textRoom, voiceRoom } from './rooms';
import { radio } from './radio';
import { play } from './music/play';
import { queue } from './music/queue';
import { remove } from './music/remove';
import { stop } from './music/stop';

const commandList: Command[] = [setup, textRoom, voiceRoom, radio, play, queue, stop, remove];

export function buildCommandCollection(): Collection<string, Command> {
  const commands = new Collection<string, Command>();
  for (const command of commandList) {
    commands.set(command.data.name, command);
  }
  return commands;
}

export { commandList };

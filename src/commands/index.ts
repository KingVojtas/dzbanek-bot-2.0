import { Collection } from 'discord.js';
import type { Command } from '../core/types';
import { setup } from './admin/setup';
import { buildHelpCommand } from './help';
import { textRoom, voiceRoom } from './rooms';
import { radio } from './radio';
import { nowPlaying } from './music/nowplaying';
import { pause } from './music/pause';
import { play } from './music/play';
import { queue } from './music/queue';
import { remove } from './music/remove';
import { skip } from './music/skip';
import { stop } from './music/stop';
import { volume } from './music/volume';

const commandList: Command[] = [
  setup,
  textRoom,
  voiceRoom,
  radio,
  play,
  queue,
  nowPlaying,
  skip,
  pause,
  volume,
  stop,
  remove,
];
commandList.push(buildHelpCommand(() => commandList));

export function buildCommandCollection(): Collection<string, Command> {
  const commands = new Collection<string, Command>();
  for (const command of commandList) {
    commands.set(command.data.name, command);
  }
  return commands;
}

export { commandList };

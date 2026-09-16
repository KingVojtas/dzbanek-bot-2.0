import { Collection } from 'discord.js';
import type { Command } from '../core/types';
import { setup } from './admin/setup';
import { loop } from './music/loop';
import { nowplaying } from './music/nowplaying';
import { pause } from './music/pause';
import { play } from './music/play';
import { queue } from './music/queue';
import { remove } from './music/remove';
import { resume } from './music/resume';
import { shuffle } from './music/shuffle';
import { skip } from './music/skip';
import { stop } from './music/stop';

const commandList: Command[] = [
  setup,
  play,
  skip,
  queue,
  stop,
  pause,
  resume,
  nowplaying,
  shuffle,
  loop,
  remove,
];

export function buildCommandCollection(): Collection<string, Command> {
  const commands = new Collection<string, Command>();
  for (const command of commandList) {
    commands.set(command.data.name, command);
  }
  return commands;
}

export { commandList };

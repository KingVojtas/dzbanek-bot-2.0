import { getVoiceConnections, VoiceConnectionStatus } from '@discordjs/voice';
import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder, type Client } from 'discord.js';
import { buildStatusDisplay } from '../../core/display/status';
import {
  NA,
  blankBotSample,
  collectHostSample,
  statusRowsFrom,
  type BotSample,
} from '../../core/host-status';
import type { Command } from '../../core/types';

export const status: Command = {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('How the Mac mini and the bot are doing. Only you can see it.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction, services) {
    const rows = statusRowsFrom(
      () => collectHostSample(),
      readBotSample(interaction.client, services.fm),
      [{ name: 'DJ voice', value: readVoiceStatus(services.fm) }],
    );
    const card = buildStatusDisplay(rows);
    await interaction.reply({ embeds: card.embeds, flags: MessageFlags.Ephemeral });
  },
};

/** Gateway, guilds, voice, and who has Kitchen FM on. Each miss is its own `n/a`. */
function readBotSample(client: Client, fm: { isOn(guildId: string): boolean }): BotSample {
  try {
    return {
      pingMs: readPing(client),
      guildCount: readGuildCount(client),
      voiceConnections: readVoiceConnections(),
      fmOnAir: readFmOnAir(client, fm),
    };
  } catch {
    return blankBotSample();
  }
}

/** Piper and its speed, or Edge and why. A miss is `n/a` like the other rows. */
function readVoiceStatus(fm: { voiceStatus(): string }): string {
  try {
    return fm.voiceStatus() || NA;
  } catch {
    return NA;
  }
}

function readPing(client: Client): number | null {
  try {
    const ping = client.ws.ping;
    return Number.isFinite(ping) && ping >= 0 ? ping : null;
  } catch {
    return null;
  }
}

function readGuildCount(client: Client): number | null {
  try {
    return client.guilds.cache.size;
  } catch {
    return null;
  }
}

/** Ready connections only. One that is still signalling is not up yet. */
function readVoiceConnections(): number | null {
  try {
    let up = 0;
    for (const connection of getVoiceConnections().values()) {
      if (connection.state.status === VoiceConnectionStatus.Ready) up += 1;
    }
    return up;
  } catch {
    return null;
  }
}

function readFmOnAir(client: Client, fm: { isOn(guildId: string): boolean }): string[] | null {
  try {
    const names: string[] = [];
    for (const guild of client.guilds.cache.values()) {
      try {
        if (fm.isOn(guild.id)) names.push(guild.name.trim() || guild.id);
      } catch {
        // One server's station must not hide the others.
      }
    }
    return names;
  } catch {
    return null;
  }
}

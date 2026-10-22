import {
  ApplicationCommandOptionType,
  ContainerBuilder,
  MessageFlags,
  SectionBuilder,
  SeparatorBuilder,
  SlashCommandBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
  type APIApplicationCommandOption,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import type { V2Display } from '../core/display';
import type { Command } from '../core/types';

type CommandJSON = RESTPostAPIChatInputApplicationCommandsJSONBody;

/** Same amber as the quiet Kitchen Board and the greetings. */
const HELP_COLOR = 0xc4783a;

/**
 * Which shelf each command sits on. A command missing here still shows up,
 * under "Other", so a new command is never hidden from /help.
 */
const GROUPS: { title: string; names: string[]; note?: string }[] = [
  {
    title: '🎵 Music',
    names: ['play', 'queue', 'nowplaying', 'skip', 'pause', 'volume', 'remove', 'stop'],
  },
  { title: '📻 Radio', names: ['radio'] },
  { title: '🎯 Steam wishlist', names: ['steam'] },
  { title: '🍪 Kitchen & setup', names: ['setup'], note: 'Manage Server' },
  { title: '🚪 Rooms', names: ['textroom', 'voiceroom'], note: 'Admin' },
  { title: '❓ Help', names: ['help'] },
];

const INTRO =
  '## 🍪 What’s cooking\n' +
  'Dzbanek plays YouTube and Spotify, streams Czech radio live, posts Steam deals and Epic ' +
  'freebies, pings you when your Steam wishlist goes on sale, and keeps the Kitchen Board up to date.';

const FOOTER =
  '-# Pause, skip, previous, volume, loop and shuffle also live as buttons on the Now Playing card.';

function isSubcommand(option: APIApplicationCommandOption): boolean {
  return (
    option.type === ApplicationCommandOptionType.Subcommand ||
    option.type === ApplicationCommandOptionType.SubcommandGroup
  );
}

/** One line per command, or one per subcommand: `` `/radio play` — … ``. */
function commandLines(command: CommandJSON): string[] {
  const subs = (command.options ?? []).filter(isSubcommand);
  if (subs.length === 0) return [`\`/${command.name}\` — ${command.description}`];
  return subs.map((sub) => `\`/${command.name} ${sub.name}\` — ${sub.description}`);
}

function optionLines(options: readonly APIApplicationCommandOption[] | undefined): string[] {
  return (options ?? []).map((option) => {
    const required = 'required' in option && option.required ? '' : ' *(optional)*';
    return `• \`${option.name}\`${required} — ${option.description}`;
  });
}

/** Everything about one command: what it does, then each option or subcommand. */
function detailText(command: CommandJSON): string {
  const lines = [`## \`/${command.name}\``, command.description];
  const subs = (command.options ?? []).filter(isSubcommand);
  if (subs.length > 0) {
    for (const sub of subs) {
      lines.push('', `**\`/${command.name} ${sub.name}\`** — ${sub.description}`);
      const subOptions = 'options' in sub ? sub.options : undefined;
      lines.push(...optionLines(subOptions as APIApplicationCommandOption[] | undefined));
    }
  } else {
    const options = optionLines(command.options);
    if (options.length > 0) lines.push('', '**Options**', ...options);
  }
  return lines.join('\n');
}

/** The /help card. With `focus`, only that command, with its options spelled out. */
export function buildHelpDisplay(
  commands: CommandJSON[],
  opts: { avatarUrl?: string; focus?: string } = {},
): V2Display {
  const container = new ContainerBuilder().setAccentColor(HELP_COLOR);
  const focused = opts.focus ? commands.find((command) => command.name === opts.focus) : undefined;
  const lead = focused ? detailText(focused) : INTRO;

  const leadText = new TextDisplayBuilder().setContent(lead.slice(0, 3800));
  if (opts.avatarUrl && /^https?:\/\//i.test(opts.avatarUrl)) {
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(leadText)
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(opts.avatarUrl)),
    );
  } else {
    container.addTextDisplayComponents(leadText);
  }

  if (!focused) {
    const byName = new Map(commands.map((command) => [command.name, command]));
    const shelved = new Set<string>();
    const shelves = GROUPS.map((group) => {
      const members = group.names.flatMap((name) => {
        const command = byName.get(name);
        if (!command) return [];
        shelved.add(name);
        return [command];
      });
      return { ...group, members };
    });
    const others = commands.filter((command) => !shelved.has(command.name));
    if (others.length > 0) shelves.push({ title: '🧩 Other', names: [], members: others });

    for (const shelf of shelves) {
      if (shelf.members.length === 0) continue;
      const heading = shelf.note ? `### ${shelf.title} · *${shelf.note}*` : `### ${shelf.title}`;
      const body = [heading, ...shelf.members.flatMap(commandLines)].join('\n');
      container
        .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(body.slice(0, 1800)));
    }
  }

  container
    .addSeparatorComponents(new SeparatorBuilder().setDivider(false))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        focused ? '-# Type `/help` on its own to see every command.' : FOOTER,
      ),
    );

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

/**
 * `list` is read when /help runs, so it can include /help itself without
 * commands/index.ts and this file importing each other.
 */
export function buildHelpCommand(list: () => Command[]): Command {
  const json = () => list().map((command) => command.data.toJSON() as CommandJSON);

  return {
    data: new SlashCommandBuilder()
      .setName('help')
      .setDescription('See every Dzbanek command, or the details of one.')
      .addStringOption((option) =>
        option
          .setName('command')
          .setDescription('Show the options for one command')
          .setAutocomplete(true),
      ),

    async execute(interaction) {
      const focus = interaction.options.getString('command')?.replace(/^\//, '').trim();
      const display = buildHelpDisplay(json(), {
        avatarUrl: interaction.client.user.displayAvatarURL({ size: 256 }),
        focus: focus || undefined,
      });
      await interaction.reply({
        components: display.components,
        flags: display.flags | MessageFlags.Ephemeral,
      });
    },

    async autocomplete(interaction) {
      const typed = interaction.options.getFocused().replace(/^\//, '').toLowerCase();
      const choices = json()
        .filter((command) => command.name.includes(typed))
        .slice(0, 25)
        .map((command) => ({ name: `/${command.name}`, value: command.name }));
      await interaction.respond(choices);
    },
  };
}

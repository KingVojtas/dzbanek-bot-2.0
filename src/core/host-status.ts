/**
 * What the Mac mini and this process can tell us, without Discord.
 * Parsing and formatting stay pure. `collectHostSample` is the only part that
 * reads the machine, so tests can hand it a fake probe.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Shown wherever a read failed. A missing value never throws. */
export const NA = 'n/a';

/** Boot line repeats on this interval. Low-resource DMs are checked on the same tick. */
export const HOST_REPORT_EVERY_MS = 60 * 60 * 1000;

/** Free space under this, where `data/` lives, is worth a DM. */
export const DISK_LOW_FREE_BYTES = 2 * 1024 ** 3;

/**
 * Available RAM is low when it is under this fraction of the total.
 * `RAM_LOW_FLOOR_BYTES` raises the bar on a small machine.
 */
export const RAM_LOW_FRACTION = 0.1;

/** The RAM alert never uses a threshold smaller than this. */
export const RAM_LOW_FLOOR_BYTES = 300 * 1024 ** 2;

/** One DM per condition per this long. A recovery does not send another. */
export const RESOURCE_ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const MEMINFO_PATH = '/proc/meminfo';
const OS_RELEASE_PATH = '/etc/os-release';
const CGROUP_V2_MAX = '/sys/fs/cgroup/memory.max';
const CGROUP_V1_LIMIT = '/sys/fs/cgroup/memory/memory.limit_in_bytes';

/** One row on the /status card. Later parts of the bot can append their own. */
export interface StatusRow {
  name: string;
  value: string;
}

/** Numbers already parsed. Null means that read failed. */
export interface HostSample {
  cpuModel: string | null;
  cores: number | null;
  /** One, five and fifteen minute load averages. */
  load: readonly [number, number, number] | null;
  memTotalBytes: number | null;
  memAvailableBytes: number | null;
  diskFreeBytes: number | null;
  diskTotalBytes: number | null;
  hostUptimeSec: number | null;
  /** `PRETTY_NAME`, or `os.type()` plus `os.release()` when that file is missing. */
  osName: string | null;
  /**
   * `glibc 2.36`, or `musl / unknown` when the report has no glibc.
   * Null when the report itself could not be read.
   */
  libc: string | null;
  /** A real cgroup cap below the host total. Null omits the card line. */
  containerLimitBytes: number | null;
  botUptimeSec: number | null;
  rssBytes: number | null;
  heapUsedBytes: number | null;
  nodeVersion: string | null;
}

/** Discord facts the command reads. Null means that read failed. */
export interface BotSample {
  pingMs: number | null;
  guildCount: number | null;
  voiceConnections: number | null;
  /** Guild names with Kitchen FM on air. An empty list is "none"; null is unreadable. */
  fmOnAir: readonly string[] | null;
}

/** When each low-resource DM last went out. Null has never sent. */
export interface ResourceAlertState {
  diskSentAt: number | null;
  ramSentAt: number | null;
}

export interface ResourceAlert {
  kind: 'disk' | 'ram';
  /** Owner DM text. The warn line uses it too. */
  text: string;
}

/**
 * Each method is one read. A throw becomes a null field, so one broken file
 * does not blank the rest of the snapshot.
 */
export interface HostProbe {
  cpus: () => { model: string }[];
  loadavg: () => number[];
  totalmem: () => number;
  freemem: () => number;
  hostUptime: () => number;
  osType: () => string;
  osRelease: () => string;
  meminfo: () => string | null;
  osReleaseText: () => string | null;
  cgroupV2: () => string | null;
  cgroupV1: () => string | null;
  disk: () => { freeBytes: number; totalBytes: number } | null;
  /** Null when glibc is absent. Throw when the report cannot be read. */
  glibcVersion: () => string | null;
  processUptime: () => number;
  memoryUsage: () => { rss: number; heapUsed: number };
  nodeVersion: () => string;
}

export function blankHostSample(): HostSample {
  return {
    cpuModel: null,
    cores: null,
    load: null,
    memTotalBytes: null,
    memAvailableBytes: null,
    diskFreeBytes: null,
    diskTotalBytes: null,
    hostUptimeSec: null,
    osName: null,
    libc: null,
    containerLimitBytes: null,
    botUptimeSec: null,
    rssBytes: null,
    heapUsedBytes: null,
    nodeVersion: null,
  };
}

export function blankBotSample(): BotSample {
  return { pingMs: null, guildCount: null, voiceConnections: null, fmOnAir: null };
}

/** Folder that holds `data/bot.db`. Free space is read here, never from the file. */
export function databaseDir(cwd = process.cwd()): string {
  return path.join(cwd, 'data');
}

/** `MemAvailable` in bytes. Null when the line is missing or not a number. */
export function parseMemAvailableBytes(text: string | null | undefined): number | null {
  if (!text) return null;
  const match = text.match(/^MemAvailable:\s*(\d+)\s*kB\s*$/m);
  if (!match?.[1]) return null;
  const kb = Number(match[1]);
  if (!Number.isSafeInteger(kb)) return null;
  return kb * 1024;
}

/**
 * Available bytes for new work. Linux `MemAvailable` counts reclaimable cache;
 * `freemem` is the fallback when that file cannot be read.
 */
export function memoryAvailableBytes(
  meminfo: string | null | undefined,
  freeMemBytes: number | null | undefined,
): number | null {
  const fromProc = parseMemAvailableBytes(meminfo);
  if (fromProc != null) return fromProc;
  return finiteNonNeg(freeMemBytes) ? freeMemBytes : null;
}

/** Bytes in use. Never negative when available is accounted above the total. */
export function memoryUsedBytes(
  totalBytes: number | null | undefined,
  availableBytes: number | null | undefined,
): number | null {
  if (!finiteNonNeg(totalBytes) || !finiteNonNeg(availableBytes)) return null;
  return Math.max(0, totalBytes - availableBytes);
}

/** `PRETTY_NAME` from `/etc/os-release`, quotes removed. Null when it is not there. */
export function parsePrettyName(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*PRETTY_NAME\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[1] ?? '';
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    value = value.replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim();
    return value || null;
  }
  return null;
}

/** Pretty name when the file has one, otherwise the type and release fallback. */
export function operatingSystemName(
  osReleaseText: string | null | undefined,
  fallback: string | null | undefined,
): string | null {
  return parsePrettyName(osReleaseText) ?? cleanText(fallback);
}

/**
 * A cgroup memory cap the container will actually hit.
 * `max`, a blank file, garbage, zero, and any value at or above the host total
 * are not a cap, so the card omits the line. v1 is used only when v2 is not there.
 */
export function containerMemoryLimit(
  v2Text: string | null | undefined,
  v1Text: string | null | undefined,
  hostTotalBytes: number | null | undefined,
): number | null {
  const v2 = readCgroup(v2Text);
  const chosen = v2.kind === 'missing' ? readCgroup(v1Text) : v2;
  if (chosen.kind !== 'limit') return null;
  if (!finiteNonNeg(hostTotalBytes) || hostTotalBytes === 0) return null;
  if (chosen.bytes >= hostTotalBytes) return null;
  return chosen.bytes;
}

/** `glibc 2.36`, or `musl / unknown` when the version is absent. */
export function formatLibc(version: string | null | undefined): string | null {
  // undefined: the report threw. null or blank: no glibc in the report.
  if (version === undefined) return null;
  const trimmed = version?.trim() ?? '';
  if (!trimmed) return 'musl / unknown';
  return /^glibc\b/i.test(trimmed) ? trimmed : `glibc ${trimmed}`;
}

/** `5.1 GB`, `182 MB`, `4 KB`, `12 B`. Binary units, labelled the way the log reads. */
export function formatBytes(bytes: number | null | undefined): string {
  if (!finiteNonNeg(bytes)) return NA;
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / 1024 ** 2;
  if (mb >= 1) return `${Math.round(mb)} MB`;
  const kb = bytes / 1024;
  if (kb >= 1) return `${Math.round(kb)} KB`;
  return `${Math.round(bytes)} B`;
}

/**
 * `12 d 4 h`, `2 h 10 min`, `45 s`.
 * Days keep the hours, hours keep the minutes, and under an hour only the
 * largest unit is shown.
 */
export function formatDuration(seconds: number | null | undefined): string {
  if (!finiteNonNeg(seconds)) return NA;
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const secs = total % 60;
  if (days > 0) return `${days} d ${hours} h`;
  if (hours > 0) return `${hours} h ${minutes} min`;
  if (minutes > 0) return `${minutes} min`;
  return `${secs} s`;
}

/** `0.42 / 0.40 / 0.38`, or `n/a` when the triple is missing. */
export function formatLoad(load: readonly number[] | null | undefined): string {
  if (!load || load.length < 3) return NA;
  const parts = [load[0], load[1], load[2]];
  if (!parts.every((value) => finiteNonNeg(value))) return NA;
  return parts.map((value) => value.toFixed(2)).join(' / ');
}

/** Each load average as a percent of the core count. `n/a` when cores are unknown. */
export function formatLoadPercents(
  load: readonly number[] | null | undefined,
  cores: number | null | undefined,
): string {
  if (!load || load.length < 3 || !finiteNonNeg(cores) || cores === 0) return NA;
  const parts = [load[0], load[1], load[2]];
  if (!parts.every((value) => finiteNonNeg(value))) return NA;
  return parts.map((value) => `${Math.round((value / cores) * 100)}%`).join(' / ');
}

/** The hourly info line. The shape stays put so a missing read is still `n/a`. */
export function hostLogLine(sample: HostSample): string {
  const model = cleanText(sample.cpuModel) ?? NA;
  const cores = finiteNonNeg(sample.cores) && sample.cores > 0 ? String(sample.cores) : NA;
  const host =
    `Host: ${model}, ${cores} cores, load ${formatLoad(sample.load)}, ` +
    `RAM ${formatBytes(sample.memAvailableBytes)} available of ${formatBytes(sample.memTotalBytes)}, ` +
    `disk ${formatBytes(sample.diskFreeBytes)} free of ${formatBytes(sample.diskTotalBytes)}, ` +
    `${cleanText(sample.libc) ?? NA}, up ${formatDuration(sample.hostUptimeSec)}`;
  const bot =
    `bot RSS ${formatBytes(sample.rssBytes)}, heap ${formatBytes(sample.heapUsedBytes)}, ` +
    `up ${formatDuration(sample.botUptimeSec)}`;
  return `${host}; ${bot}`;
}

/**
 * Card rows: the host, then the bot, then any extra lines another part of the
 * bot wants to add. The container line is left out unless the cap is real.
 */
export function hostStatusRows(
  sample: HostSample,
  bot: BotSample = blankBotSample(),
  extras: readonly StatusRow[] = [],
): StatusRow[] {
  const rows: StatusRow[] = [
    { name: 'CPU', value: cpuValue(sample) },
    { name: 'Load', value: loadValue(sample) },
    { name: 'RAM', value: ramValue(sample) },
    { name: 'Disk', value: diskValue(sample) },
    { name: 'Uptime', value: formatDuration(sample.hostUptimeSec) },
    { name: 'OS', value: cleanText(sample.osName) ?? NA },
    { name: 'C library', value: cleanText(sample.libc) ?? NA },
  ];
  if (finiteNonNeg(sample.containerLimitBytes) && sample.containerLimitBytes > 0) {
    rows.push({ name: 'Container', value: `${formatBytes(sample.containerLimitBytes)} limit` });
  }
  rows.push(
    { name: 'Bot', value: botValue(sample) },
    { name: 'Gateway', value: pingValue(bot.pingMs) },
    { name: 'Servers', value: countValue(bot.guildCount, 'server', 'servers') },
    { name: 'Voice', value: countValue(bot.voiceConnections, 'connection', 'connections') },
    { name: 'Kitchen FM', value: fmValue(bot.fmOnAir) },
  );
  for (const extra of extras) {
    const name = cleanText(extra?.name);
    const value = cleanText(extra?.value);
    if (!name || !value) continue;
    rows.push({ name, value });
  }
  return rows;
}

/**
 * Runs `collect` and builds the rows. A collector that throws still returns
 * a card of `n/a` host rows, so /status can always reply.
 */
export function statusRowsFrom(
  collect: () => HostSample,
  bot: BotSample = blankBotSample(),
  extras: readonly StatusRow[] = [],
): StatusRow[] {
  try {
    return hostStatusRows(collect(), bot, extras);
  } catch {
    return hostStatusRows(blankHostSample(), bot, extras);
  }
}

/**
 * Which low-resource DMs are due. Each condition remembers its own send time
 * for 24 h. Coming back up does not clear that, and does not send a DM.
 */
export function resourceAlerts(
  sample: Pick<HostSample, 'diskFreeBytes' | 'memAvailableBytes' | 'memTotalBytes'>,
  state: ResourceAlertState,
  nowMs: number,
): { state: ResourceAlertState; alerts: ResourceAlert[] } {
  const alerts: ResourceAlert[] = [];
  let diskSentAt = state.diskSentAt;
  let ramSentAt = state.ramSentAt;

  if (
    finiteNonNeg(sample.diskFreeBytes) &&
    sample.diskFreeBytes < DISK_LOW_FREE_BYTES &&
    cooledDown(diskSentAt, nowMs)
  ) {
    alerts.push({
      kind: 'disk',
      text: `Disk on the Mac mini is low: ${formatBytes(sample.diskFreeBytes)} free where data/ lives (below 2 GB).`,
    });
    diskSentAt = nowMs;
  }

  const threshold = finiteNonNeg(sample.memTotalBytes)
    ? ramLowThreshold(sample.memTotalBytes)
    : null;
  if (
    threshold != null &&
    finiteNonNeg(sample.memAvailableBytes) &&
    sample.memAvailableBytes < threshold &&
    cooledDown(ramSentAt, nowMs)
  ) {
    alerts.push({
      kind: 'ram',
      text:
        `Memory on the Mac mini is low: ${formatBytes(sample.memAvailableBytes)} available ` +
        `of ${formatBytes(sample.memTotalBytes)} (below ${formatBytes(threshold)}).`,
    });
    ramSentAt = nowMs;
  }

  return { state: { diskSentAt, ramSentAt }, alerts };
}

/** The larger of 10% of RAM and 300 MB. */
export function ramLowThreshold(totalBytes: number): number {
  return Math.max(totalBytes * RAM_LOW_FRACTION, RAM_LOW_FLOOR_BYTES);
}

/** Reads the host. Pass overrides in tests; anything that throws becomes null. */
export function collectHostSample(overrides: Partial<HostProbe> = {}): HostSample {
  const probe: HostProbe = { ...defaultProbe(), ...overrides };
  const cpus = call(probe.cpus, [] as { model: string }[]);
  const cpuList = Array.isArray(cpus) ? cpus : [];
  const memTotalBytes = readFinite(probe.totalmem);
  const memAvailableBytes = memoryAvailableBytes(
    call(probe.meminfo, null),
    readFinite(probe.freemem),
  );
  const disk = call(probe.disk, null);
  let libc: string | null;
  try {
    libc = formatLibc(probe.glibcVersion());
  } catch {
    libc = null;
  }
  const usage = call(probe.memoryUsage, null);
  const nodeVersion = cleanText(call(probe.nodeVersion, ''));

  return {
    cpuModel: cleanText(cpuList[0]?.model),
    cores: cpuList.length > 0 ? cpuList.length : null,
    load: parseLoad(call(probe.loadavg, [])),
    memTotalBytes,
    memAvailableBytes,
    diskFreeBytes: finiteNonNeg(disk?.freeBytes) ? disk.freeBytes : null,
    diskTotalBytes: finiteNonNeg(disk?.totalBytes) ? disk.totalBytes : null,
    hostUptimeSec: readFinite(probe.hostUptime),
    osName: operatingSystemName(call(probe.osReleaseText, null), readOsFallback(probe)),
    libc,
    containerLimitBytes: containerMemoryLimit(
      call(probe.cgroupV2, null),
      call(probe.cgroupV1, null),
      memTotalBytes,
    ),
    botUptimeSec: readFinite(probe.processUptime),
    rssBytes: finiteNonNeg(usage?.rss) ? usage.rss : null,
    heapUsedBytes: finiteNonNeg(usage?.heapUsed) ? usage.heapUsed : null,
    nodeVersion,
  };
}

function defaultProbe(): HostProbe {
  return {
    cpus: () => os.cpus(),
    loadavg: () => os.loadavg(),
    totalmem: () => os.totalmem(),
    freemem: () => os.freemem(),
    hostUptime: () => os.uptime(),
    osType: () => os.type(),
    osRelease: () => os.release(),
    meminfo: () => readText(MEMINFO_PATH),
    osReleaseText: () => readText(OS_RELEASE_PATH),
    cgroupV2: () => readText(CGROUP_V2_MAX),
    cgroupV1: () => readText(CGROUP_V1_LIMIT),
    disk: () => readDisk(databaseDir()),
    glibcVersion: defaultGlibc,
    processUptime: () => process.uptime(),
    memoryUsage: () => process.memoryUsage(),
    nodeVersion: () => process.version,
  };
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** `bavail` is the space this process can use. Root-reserved blocks are not counted. */
function readDisk(dir: string): { freeBytes: number; totalBytes: number } | null {
  const stats = fs.statfsSync(dir);
  const bsize = Number(stats.bsize);
  const blocks = Number(stats.blocks);
  const bavail = Number(stats.bavail);
  if (!finiteNonNeg(bsize) || bsize === 0 || !finiteNonNeg(blocks) || !finiteNonNeg(bavail)) {
    return null;
  }
  return { freeBytes: bavail * bsize, totalBytes: blocks * bsize };
}

function defaultGlibc(): string | null {
  if (!process.report?.getReport) return null;
  const report: unknown = process.report.getReport();
  if (!report || typeof report !== 'object') return null;
  const header = (report as { header?: unknown }).header;
  if (!header || typeof header !== 'object') return null;
  const version = (header as { glibcVersionRuntime?: unknown }).glibcVersionRuntime;
  if (typeof version !== 'string') return null;
  return version.trim() || null;
}

function readOsFallback(probe: HostProbe): string | null {
  try {
    return cleanText(`${probe.osType()} ${probe.osRelease()}`);
  } catch {
    return null;
  }
}

function readFinite(read: () => number): number | null {
  const value = call(read, Number.NaN);
  return finiteNonNeg(value) ? value : null;
}

function call<T>(fn: () => T, fallback: T): T {
  try {
    const value = fn();
    return value == null ? fallback : value;
  } catch {
    return fallback;
  }
}

function parseLoad(values: number[] | null | undefined): [number, number, number] | null {
  if (!values || values.length < 3) return null;
  const triple: [number, number, number] = [values[0], values[1], values[2]];
  if (!triple.every((value) => finiteNonNeg(value))) return null;
  return triple;
}

type CgroupRead = { kind: 'missing' } | { kind: 'unlimited' } | { kind: 'limit'; bytes: number };

function readCgroup(text: string | null | undefined): CgroupRead {
  if (text == null) return { kind: 'missing' };
  const trimmed = text.trim();
  if (!trimmed) return { kind: 'missing' };
  if (trimmed === 'max' || !/^\d+$/.test(trimmed)) return { kind: 'unlimited' };
  const bytes = Number(trimmed);
  if (!Number.isFinite(bytes) || bytes <= 0) return { kind: 'unlimited' };
  return { kind: 'limit', bytes };
}

function cooledDown(sentAt: number | null, nowMs: number): boolean {
  return sentAt == null || nowMs - sentAt >= RESOURCE_ALERT_COOLDOWN_MS;
}

function cpuValue(sample: HostSample): string {
  const model = cleanText(sample.cpuModel) ?? NA;
  const cores =
    finiteNonNeg(sample.cores) && sample.cores > 0
      ? `${sample.cores} ${sample.cores === 1 ? 'core' : 'cores'}`
      : NA;
  if (model === NA && cores === NA) return NA;
  return `${model} · ${cores}`;
}

function loadValue(sample: HostSample): string {
  const load = formatLoad(sample.load);
  if (load === NA) return NA;
  const percents = formatLoadPercents(sample.load, sample.cores);
  return percents === NA ? load : `${load} · ${percents} of the cores`;
}

function ramValue(sample: HostSample): string {
  const total = formatBytes(sample.memTotalBytes);
  const used = formatBytes(memoryUsedBytes(sample.memTotalBytes, sample.memAvailableBytes));
  const available = formatBytes(sample.memAvailableBytes);
  if (total === NA && used === NA && available === NA) return NA;
  return `${total} total · ${used} used · ${available} available`;
}

function diskValue(sample: HostSample): string {
  const free = formatBytes(sample.diskFreeBytes);
  const total = formatBytes(sample.diskTotalBytes);
  if (free === NA && total === NA) return NA;
  return `${free} free of ${total}`;
}

function botValue(sample: HostSample): string {
  const up = formatDuration(sample.botUptimeSec);
  const rss = formatBytes(sample.rssBytes);
  const heap = formatBytes(sample.heapUsedBytes);
  const node = cleanText(sample.nodeVersion) ?? NA;
  if (up === NA && rss === NA && heap === NA && node === NA) return NA;
  return `up ${up} · RSS ${rss} · heap ${heap} · Node ${node}`;
}

function pingValue(pingMs: number | null): string {
  if (!finiteNonNeg(pingMs)) return NA;
  return `${Math.round(pingMs)} ms`;
}

function countValue(value: number | null, singular: string, plural: string): string {
  if (!finiteNonNeg(value)) return NA;
  const count = Math.round(value);
  if (count === 0) return 'none';
  return `${count} ${count === 1 ? singular : plural}`;
}

function fmValue(names: readonly string[] | null): string {
  if (names == null) return NA;
  const onAir = names.map((name) => name.trim()).filter(Boolean);
  return onAir.length > 0 ? onAir.join(', ') : 'none';
}

function cleanText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\0/g, '').trim();
  return text || null;
}

function finiteNonNeg(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

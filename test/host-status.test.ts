import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  DISK_LOW_FREE_BYTES,
  HOST_REPORT_EVERY_MS,
  NA,
  RAM_LOW_FLOOR_BYTES,
  RAM_LOW_FRACTION,
  RESOURCE_ALERT_COOLDOWN_MS,
  blankBotSample,
  blankHostSample,
  collectHostSample,
  containerMemoryLimit,
  databaseDir,
  formatBytes,
  formatDuration,
  formatLibc,
  formatLoad,
  formatLoadPercents,
  hostLogLine,
  hostStatusRows,
  memoryAvailableBytes,
  memoryUsedBytes,
  operatingSystemName,
  parseMemAvailableBytes,
  parsePrettyName,
  ramLowThreshold,
  resourceAlerts,
  statusRowsFrom,
  type BotSample,
  type HostProbe,
  type HostSample,
  type ResourceAlertState,
} from '../src/core/host-status';

const GB = 1024 ** 3;
const MB = 1024 ** 2;

const quiet: ResourceAlertState = { diskSentAt: null, ramSentAt: null };

function sample(overrides: Partial<HostSample> = {}): HostSample {
  return { ...blankHostSample(), ...overrides };
}

function resources(overrides: Partial<HostSample> = {}): HostSample {
  return sample({
    diskFreeBytes: 40 * GB,
    memTotalBytes: 8 * GB,
    memAvailableBytes: 5 * GB,
    ...overrides,
  });
}

describe('parseMemAvailableBytes', () => {
  it('reads the kB line as bytes', () => {
    const text = 'MemTotal:       8000000 kB\nMemAvailable:    5242880 kB\nMemFree:  100 kB\n';
    assert.equal(parseMemAvailableBytes(text), 5242880 * 1024);
  });

  it('accepts zero and a trailing carriage return', () => {
    assert.equal(parseMemAvailableBytes('MemAvailable: 0 kB'), 0);
    assert.equal(parseMemAvailableBytes('MemAvailable:\t12 kB\r\n'), 12 * 1024);
  });

  it('returns null for missing, empty, and garbage input', () => {
    assert.equal(parseMemAvailableBytes(null), null);
    assert.equal(parseMemAvailableBytes(undefined), null);
    assert.equal(parseMemAvailableBytes(''), null);
    assert.equal(parseMemAvailableBytes('MemTotal: 100 kB\n'), null);
    assert.equal(parseMemAvailableBytes('MemAvailable: nope kB'), null);
    assert.equal(parseMemAvailableBytes('MemAvailable: -5 kB'), null);
    assert.equal(parseMemAvailableBytes('MemAvailable: 10 MB'), null);
    assert.equal(parseMemAvailableBytes('MemAvailable: 10 kB extra'), null);
  });
});

describe('memoryAvailableBytes', () => {
  it('prefers MemAvailable and falls back to freemem', () => {
    assert.equal(memoryAvailableBytes('MemAvailable: 2048 kB\n', 10), 2048 * 1024);
    assert.equal(memoryAvailableBytes('garbage', 1234), 1234);
    assert.equal(memoryAvailableBytes(null, 50), 50);
    assert.equal(memoryAvailableBytes('MemAvailable: 0 kB', 50), 0);
  });

  it('returns null when neither source can be read', () => {
    assert.equal(memoryAvailableBytes(null, null), null);
    assert.equal(memoryAvailableBytes('nope', Number.NaN), null);
    assert.equal(memoryAvailableBytes('nope', -1), null);
  });
});

describe('memoryUsedBytes', () => {
  it('is total minus available, and never negative', () => {
    assert.equal(memoryUsedBytes(100, 40), 60);
    assert.equal(memoryUsedBytes(100, 150), 0);
    assert.equal(memoryUsedBytes(null, 40), null);
    assert.equal(memoryUsedBytes(100, null), null);
  });
});

describe('parsePrettyName', () => {
  it('reads a quoted or bare PRETTY_NAME', () => {
    assert.equal(
      parsePrettyName('NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 22.04.3 LTS"\n'),
      'Ubuntu 22.04.3 LTS',
    );
    assert.equal(parsePrettyName("PRETTY_NAME='Alpine Linux'"), 'Alpine Linux');
    assert.equal(parsePrettyName('PRETTY_NAME=Alpine'), 'Alpine');
  });

  it('returns null for missing, empty, and garbage input', () => {
    assert.equal(parsePrettyName(null), null);
    assert.equal(parsePrettyName(''), null);
    assert.equal(parsePrettyName('NAME="Ubuntu"\nVERSION_ID="22.04"\n'), null);
    assert.equal(parsePrettyName('# PRETTY_NAME="not this"'), null);
    assert.equal(parsePrettyName('PRETTY_NAME=""'), null);
    assert.equal(parsePrettyName('PRETTY_NAME='), null);
    assert.equal(parsePrettyName('not an os-release file'), null);
  });

  it('uses the type and release only when pretty name is missing', () => {
    assert.equal(operatingSystemName('PRETTY_NAME="Ubuntu"', 'Linux 6.8.0'), 'Ubuntu');
    assert.equal(operatingSystemName('garbage', 'Linux 6.8.0'), 'Linux 6.8.0');
    assert.equal(operatingSystemName(null, '   '), null);
    assert.equal(operatingSystemName(null, null), null);
  });
});

describe('containerMemoryLimit', () => {
  const host = 8 * GB;

  it('keeps a real limit below the host total', () => {
    assert.equal(containerMemoryLimit('536870912\n', null, host), 536870912);
    assert.equal(containerMemoryLimit('  4096  ', null, 10_000), 4096);
  });

  it('treats max, zero, garbage, and a huge number as no limit', () => {
    assert.equal(containerMemoryLimit('max', '536870912', host), null);
    assert.equal(containerMemoryLimit('max\n', null, host), null);
    assert.equal(containerMemoryLimit('0', null, host), null);
    assert.equal(containerMemoryLimit('nope', '536870912', host), null);
    assert.equal(containerMemoryLimit('9223372036854771712', null, host), null);
    assert.equal(containerMemoryLimit(String(host), null, host), null);
    assert.equal(containerMemoryLimit(String(host + 1), null, host), null);
  });

  it('reads v1 only when v2 is missing, and skips the line without a host total', () => {
    assert.equal(containerMemoryLimit(null, '536870912', host), 536870912);
    assert.equal(containerMemoryLimit('', '536870912', host), 536870912);
    assert.equal(containerMemoryLimit('   ', '536870912', host), 536870912);
    assert.equal(containerMemoryLimit('536870912', null, null), null);
    assert.equal(containerMemoryLimit('536870912', null, 0), null);
  });
});

describe('formatLibc', () => {
  it('names glibc, and musl when the version is absent', () => {
    assert.equal(formatLibc('2.36'), 'glibc 2.36');
    assert.equal(formatLibc(' glibc 2.36 '), 'glibc 2.36');
    assert.equal(formatLibc(null), 'musl / unknown');
    assert.equal(formatLibc(''), 'musl / unknown');
  });

  it('returns null when the report could not be read', () => {
    assert.equal(formatLibc(undefined), null);
  });
});

describe('formatBytes', () => {
  it('uses one decimal for GB and whole MB', () => {
    assert.equal(formatBytes(5.1 * GB), '5.1 GB');
    assert.equal(formatBytes(8 * GB), '8.0 GB');
    assert.equal(formatBytes(41.2 * GB), '41.2 GB');
    assert.equal(formatBytes(112 * GB), '112.0 GB');
    assert.equal(formatBytes(182 * MB), '182 MB');
    assert.equal(formatBytes(64 * MB), '64 MB');
    assert.equal(formatBytes(MB), '1 MB');
  });

  it('steps down to KB and bytes', () => {
    assert.equal(formatBytes(2048), '2 KB');
    assert.equal(formatBytes(12), '12 B');
    assert.equal(formatBytes(0), '0 B');
  });

  it('returns n/a for missing or nonsense values', () => {
    assert.equal(formatBytes(null), NA);
    assert.equal(formatBytes(undefined), NA);
    assert.equal(formatBytes(Number.NaN), NA);
    assert.equal(formatBytes(Number.POSITIVE_INFINITY), NA);
    assert.equal(formatBytes(-1), NA);
  });
});

describe('formatDuration', () => {
  it('matches the log shapes', () => {
    assert.equal(formatDuration(12 * 86_400 + 4 * 3_600), '12 d 4 h');
    assert.equal(formatDuration(2 * 3_600 + 10 * 60), '2 h 10 min');
    assert.equal(formatDuration(45), '45 s');
  });

  it('keeps a zero remainder and drops seconds once a minute shows', () => {
    assert.equal(formatDuration(86_400), '1 d 0 h');
    assert.equal(formatDuration(3_600), '1 h 0 min');
    assert.equal(formatDuration(90), '1 min');
    assert.equal(formatDuration(60), '1 min');
    assert.equal(formatDuration(0), '0 s');
  });

  it('returns n/a for missing or negative values', () => {
    assert.equal(formatDuration(null), NA);
    assert.equal(formatDuration(Number.NaN), NA);
    assert.equal(formatDuration(-1), NA);
  });
});

describe('formatLoad', () => {
  it('prints two decimals and the percent of the cores', () => {
    assert.equal(formatLoad([0.42, 0.4, 0.38]), '0.42 / 0.40 / 0.38');
    assert.equal(formatLoadPercents([0.42, 0.4, 0.38], 4), '11% / 10% / 10%');
    assert.equal(formatLoadPercents([1, 0, 0], 1), '100% / 0% / 0%');
  });

  it('returns n/a for a short triple, bad numbers, or no cores', () => {
    assert.equal(formatLoad(null), NA);
    assert.equal(formatLoad([1, 2]), NA);
    assert.equal(formatLoad([1, Number.NaN, 0]), NA);
    assert.equal(formatLoad([-1, 0, 0]), NA);
    assert.equal(formatLoadPercents([0.42, 0.4, 0.38], 0), NA);
    assert.equal(formatLoadPercents([0.42, 0.4, 0.38], null), NA);
  });
});

describe('hostLogLine', () => {
  it('matches the boot line', () => {
    const line = hostLogLine(
      sample({
        cpuModel: 'Intel(R) Core(TM) i5-4278U',
        cores: 4,
        load: [0.42, 0.4, 0.38],
        memTotalBytes: 8 * GB,
        memAvailableBytes: 5.1 * GB,
        diskFreeBytes: 41.2 * GB,
        diskTotalBytes: 112 * GB,
        hostUptimeSec: 12 * 86_400 + 4 * 3_600,
        libc: 'glibc 2.36',
        botUptimeSec: 2 * 3_600 + 10 * 60,
        rssBytes: 182 * MB,
        heapUsedBytes: 64 * MB,
      }),
    );
    assert.equal(
      line,
      'Host: Intel(R) Core(TM) i5-4278U, 4 cores, load 0.42 / 0.40 / 0.38, ' +
        'RAM 5.1 GB available of 8.0 GB, disk 41.2 GB free of 112.0 GB, glibc 2.36, ' +
        'up 12 d 4 h; bot RSS 182 MB, heap 64 MB, up 2 h 10 min',
    );
  });

  it('keeps the shape when nothing could be read', () => {
    assert.equal(
      hostLogLine(blankHostSample()),
      'Host: n/a, n/a cores, load n/a, RAM n/a available of n/a, disk n/a free of n/a, ' +
        'n/a, up n/a; bot RSS n/a, heap n/a, up n/a',
    );
  });
});

describe('hostStatusRows', () => {
  const full = sample({
    cpuModel: 'Intel(R) Core(TM) i5-4278U',
    cores: 4,
    load: [0.42, 0.4, 0.38],
    memTotalBytes: 8 * GB,
    memAvailableBytes: 5.1 * GB,
    diskFreeBytes: 41.2 * GB,
    diskTotalBytes: 112 * GB,
    hostUptimeSec: 12 * 86_400 + 4 * 3_600,
    osName: 'Ubuntu 22.04.3 LTS',
    libc: 'glibc 2.36',
    containerLimitBytes: 512 * MB,
    botUptimeSec: 2 * 3_600 + 10 * 60,
    rssBytes: 182 * MB,
    heapUsedBytes: 64 * MB,
    nodeVersion: 'v22.14.0',
  });
  const bot: BotSample = {
    pingMs: 42,
    guildCount: 2,
    voiceConnections: 1,
    fmOnAir: ['Late Kitchen', 'Other'],
  };

  it('lists the host, the bot, and extra rows', () => {
    const rows = hostStatusRows(full, bot, [{ name: 'DJ voice', value: 'quiet' }]);
    const value = (name: string) => rows.find((row) => row.name === name)?.value;
    assert.equal(value('CPU'), 'Intel(R) Core(TM) i5-4278U · 4 cores');
    assert.equal(value('Load'), '0.42 / 0.40 / 0.38 · 11% / 10% / 10% of the cores');
    assert.equal(value('RAM'), '8.0 GB total · 2.9 GB used · 5.1 GB available');
    assert.equal(value('Disk'), '41.2 GB free of 112.0 GB');
    assert.equal(value('Uptime'), '12 d 4 h');
    assert.equal(value('OS'), 'Ubuntu 22.04.3 LTS');
    assert.equal(value('C library'), 'glibc 2.36');
    assert.equal(value('Container'), '512 MB limit');
    assert.equal(value('Bot'), 'up 2 h 10 min · RSS 182 MB · heap 64 MB · Node v22.14.0');
    assert.equal(value('Gateway'), '42 ms');
    assert.equal(value('Servers'), '2 servers');
    assert.equal(value('Voice'), '1 connection');
    assert.equal(value('Kitchen FM'), 'Late Kitchen, Other');
    assert.equal(value('DJ voice'), 'quiet');
    assert.equal(rows.at(-1)?.name, 'DJ voice');
  });

  it('omits the container line and says none when FM and voice are idle', () => {
    const rows = hostStatusRows(sample({ libc: 'musl / unknown' }), {
      pingMs: -1,
      guildCount: 0,
      voiceConnections: 0,
      fmOnAir: [],
    });
    assert.equal(
      rows.some((row) => row.name === 'Container'),
      false,
    );
    assert.equal(rows.find((row) => row.name === 'Kitchen FM')?.value, 'none');
    assert.equal(rows.find((row) => row.name === 'Voice')?.value, 'none');
    assert.equal(rows.find((row) => row.name === 'Servers')?.value, 'none');
    assert.equal(rows.find((row) => row.name === 'Gateway')?.value, NA);
    assert.equal(rows.find((row) => row.name === 'C library')?.value, 'musl / unknown');
  });

  it('uses n/a for a read that failed, including a blank extra', () => {
    const rows = hostStatusRows(blankHostSample(), blankBotSample(), [
      { name: ' ', value: 'skipped' },
      { name: 'DJ voice', value: '  ' },
    ]);
    for (const row of rows) assert.equal(row.value, NA);
    assert.equal(
      rows.some((row) => row.name === 'DJ voice'),
      false,
    );
  });

  it('says one core and one server in the singular', () => {
    const rows = hostStatusRows(sample({ cpuModel: 'Test', cores: 1, load: [1, 0, 0] }), {
      ...blankBotSample(),
      guildCount: 1,
      voiceConnections: 2,
      fmOnAir: ['  ', 'Kitchen'],
    });
    assert.equal(rows.find((row) => row.name === 'CPU')?.value, 'Test · 1 core');
    assert.equal(rows.find((row) => row.name === 'Servers')?.value, '1 server');
    assert.equal(rows.find((row) => row.name === 'Voice')?.value, '2 connections');
    assert.equal(rows.find((row) => row.name === 'Kitchen FM')?.value, 'Kitchen');
  });
});

describe('resourceAlerts', () => {
  it('pins the thresholds', () => {
    assert.equal(DISK_LOW_FREE_BYTES, 2 * GB);
    assert.equal(RAM_LOW_FLOOR_BYTES, 300 * MB);
    assert.equal(RAM_LOW_FRACTION, 0.1);
    assert.equal(RESOURCE_ALERT_COOLDOWN_MS, 24 * 60 * 60 * 1000);
    assert.equal(HOST_REPORT_EVERY_MS, 60 * 60 * 1000);
    assert.equal(ramLowThreshold(8 * GB), 8 * GB * RAM_LOW_FRACTION);
    assert.ok(ramLowThreshold(8 * GB) > RAM_LOW_FLOOR_BYTES);
    assert.equal(ramLowThreshold(1 * GB), RAM_LOW_FLOOR_BYTES);
  });

  it('alerts under 2 GB free, not at 2 GB, and not when the disk could not be read', () => {
    const under = resourceAlerts(resources({ diskFreeBytes: DISK_LOW_FREE_BYTES - 1 }), quiet, 0);
    assert.deepEqual(
      under.alerts.map((alert) => alert.kind),
      ['disk'],
    );
    assert.match(under.alerts[0]!.text, /below 2 GB/);

    const exact = resourceAlerts(resources({ diskFreeBytes: DISK_LOW_FREE_BYTES }), quiet, 0);
    assert.equal(exact.alerts.length, 0);

    const unread = resourceAlerts(resources({ diskFreeBytes: null }), quiet, 0);
    assert.equal(unread.alerts.length, 0);
  });

  it('uses the larger of 10% and 300 MB', () => {
    const big = resourceAlerts(
      resources({ memTotalBytes: 8 * GB, memAvailableBytes: 500 * MB }),
      quiet,
      0,
    );
    assert.deepEqual(
      big.alerts.map((alert) => alert.kind),
      ['ram'],
    );
    assert.match(big.alerts[0]!.text, /available/);

    const bigLine = ramLowThreshold(8 * GB);
    const bigOk = resourceAlerts(
      resources({ memTotalBytes: 8 * GB, memAvailableBytes: bigLine }),
      quiet,
      0,
    );
    assert.equal(bigOk.alerts.length, 0);

    const small = resourceAlerts(
      resources({ memTotalBytes: 1 * GB, memAvailableBytes: 200 * MB }),
      quiet,
      0,
    );
    assert.equal(small.alerts[0]?.kind, 'ram');

    const smallOk = resourceAlerts(
      resources({ memTotalBytes: 1 * GB, memAvailableBytes: 300 * MB }),
      quiet,
      0,
    );
    assert.equal(smallOk.alerts.length, 0);

    const unread = resourceAlerts(
      resources({ memAvailableBytes: null, memTotalBytes: null }),
      quiet,
      0,
    );
    assert.equal(unread.alerts.length, 0);
  });

  it('sends at most one DM per condition per 24 h', () => {
    const low = resources({
      diskFreeBytes: GB,
      memAvailableBytes: 100 * MB,
      memTotalBytes: 8 * GB,
    });
    const first = resourceAlerts(low, quiet, 1_000);
    assert.deepEqual(
      first.alerts.map((alert) => alert.kind),
      ['disk', 'ram'],
    );

    const again = resourceAlerts(low, first.state, 1_000 + RESOURCE_ALERT_COOLDOWN_MS - 1);
    assert.equal(again.alerts.length, 0);
    assert.equal(again.state.diskSentAt, 1_000);
    assert.equal(again.state.ramSentAt, 1_000);

    const later = resourceAlerts(low, first.state, 1_000 + RESOURCE_ALERT_COOLDOWN_MS);
    assert.deepEqual(
      later.alerts.map((alert) => alert.kind),
      ['disk', 'ram'],
    );
  });

  it('does not DM on recovery, and a dip inside the window stays quiet', () => {
    const lowDisk = resources({ diskFreeBytes: GB });
    const sent = resourceAlerts(lowDisk, quiet, 5_000);
    assert.equal(sent.alerts.length, 1);

    const recovered = resourceAlerts(resources(), sent.state, 6_000);
    assert.equal(recovered.alerts.length, 0);
    assert.equal(recovered.state.diskSentAt, 5_000);

    const dipped = resourceAlerts(lowDisk, recovered.state, 7_000);
    assert.equal(dipped.alerts.length, 0);
  });

  it('lets a new condition through while the other is still in its window', () => {
    const diskOnly = resourceAlerts(resources({ diskFreeBytes: GB }), quiet, 10);
    const thenRam = resourceAlerts(
      resources({ diskFreeBytes: GB, memAvailableBytes: 100 * MB }),
      diskOnly.state,
      20,
    );
    assert.deepEqual(
      thenRam.alerts.map((alert) => alert.kind),
      ['ram'],
    );
    assert.equal(thenRam.state.diskSentAt, 10);
    assert.equal(thenRam.state.ramSentAt, 20);
  });
});

describe('collectHostSample', () => {
  function probe(overrides: Partial<HostProbe> = {}) {
    return collectHostSample({
      cpus: () => [{ model: 'Test CPU ' }, { model: 'Test CPU ' }],
      loadavg: () => [0.5, 0.25, 0.125],
      totalmem: () => 8 * GB,
      freemem: () => GB,
      hostUptime: () => 90,
      osType: () => 'Linux',
      osRelease: () => '6.8.0',
      meminfo: () => null,
      osReleaseText: () => null,
      cgroupV2: () => null,
      cgroupV1: () => null,
      disk: () => ({ freeBytes: 10 * GB, totalBytes: 20 * GB }),
      glibcVersion: () => '2.36',
      processUptime: () => 45,
      memoryUsage: () => ({ rss: 182 * MB, heapUsed: 64 * MB }),
      nodeVersion: () => 'v22.14.0',
      ...overrides,
    });
  }

  it('prefers MemAvailable, pretty name, and a real cgroup cap', () => {
    const got = probe({
      meminfo: () => 'MemAvailable: 5242880 kB\n',
      osReleaseText: () => 'PRETTY_NAME="Ubuntu 22.04.3 LTS"\n',
      cgroupV2: () => `${GB}\n`,
    });
    assert.equal(got.cpuModel, 'Test CPU');
    assert.equal(got.cores, 2);
    assert.deepEqual(got.load, [0.5, 0.25, 0.125]);
    assert.equal(got.memAvailableBytes, 5 * GB);
    assert.equal(got.osName, 'Ubuntu 22.04.3 LTS');
    assert.equal(got.containerLimitBytes, GB);
    assert.equal(got.libc, 'glibc 2.36');
    assert.equal(got.diskFreeBytes, 10 * GB);
  });

  it('falls back when meminfo, os-release, and glibc are missing', () => {
    const got = probe({
      meminfo: () => 'this is not meminfo',
      glibcVersion: () => null,
    });
    assert.equal(got.memAvailableBytes, GB);
    assert.equal(got.osName, 'Linux 6.8.0');
    assert.equal(got.libc, 'musl / unknown');
    assert.equal(got.containerLimitBytes, null);
  });

  it('turns one throwing read into null and keeps the rest', () => {
    const got = probe({
      disk: () => {
        throw new Error('statfs failed');
      },
      cgroupV2: () => {
        throw new Error('cgroup unreadable');
      },
      loadavg: () => {
        throw new Error('load');
      },
    });
    assert.equal(got.diskFreeBytes, null);
    assert.equal(got.diskTotalBytes, null);
    assert.equal(got.containerLimitBytes, null);
    assert.equal(got.load, null);
    assert.equal(got.cpuModel, 'Test CPU');
    assert.equal(got.rssBytes, 182 * MB);
  });

  it('treats a throwing glibc report as unreadable', () => {
    const got = probe({
      glibcVersion: () => {
        throw new Error('report failed');
      },
    });
    assert.equal(got.libc, null);
  });

  it('does not throw on this machine, and the database path is the data folder', () => {
    const live = collectHostSample();
    assert.equal(typeof live.nodeVersion, 'string');
    assert.equal(databaseDir('/app'), path.join('/app', 'data'));
    assert.equal(databaseDir('/app').endsWith(`${path.sep}bot.db`), false);
  });
});

describe('statusRowsFrom', () => {
  it('turns a collector failure into n/a rows instead of throwing', () => {
    const rows = statusRowsFrom(
      () => {
        throw new Error('statfs exploded');
      },
      { pingMs: 20, guildCount: 1, voiceConnections: 0, fmOnAir: [] },
      [{ name: 'DJ voice', value: 'still here' }],
    );
    assert.equal(rows.find((row) => row.name === 'CPU')?.value, NA);
    assert.equal(rows.find((row) => row.name === 'RAM')?.value, NA);
    assert.equal(rows.find((row) => row.name === 'Disk')?.value, NA);
    assert.equal(rows.find((row) => row.name === 'Bot')?.value, NA);
    assert.equal(
      rows.some((row) => row.name === 'Container'),
      false,
    );
    assert.equal(rows.find((row) => row.name === 'Gateway')?.value, '20 ms');
    assert.equal(rows.find((row) => row.name === 'Kitchen FM')?.value, 'none');
    assert.equal(rows.find((row) => row.name === 'DJ voice')?.value, 'still here');
  });
});

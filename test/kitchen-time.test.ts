import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  chartWeek,
  isRadioVoteOpen,
  kitchenDateLabel,
  monthToDate,
  nextRadioNight,
  previousMonth,
  previousYear,
  radioNightWeekKey,
  zonedDateTimeToUtc,
} from '../src/kitchen/time';

const TZ = 'Europe/Prague';

/** A Prague wall-clock time as a UTC instant. */
function prague(dateKey: string, hour: number, minute = 0): Date {
  return zonedDateTimeToUtc(TZ, dateKey, hour, minute);
}

describe('zonedDateTimeToUtc', () => {
  it('is UTC+2 in summer and UTC+1 in winter', () => {
    assert.equal(prague('2026-10-23', 20).toISOString(), '2026-10-23T18:00:00.000Z');
    assert.equal(prague('2026-10-30', 20).toISOString(), '2026-10-30T19:00:00.000Z');
    assert.equal(prague('2027-03-26', 20).toISOString(), '2027-03-26T19:00:00.000Z');
    assert.equal(prague('2027-04-02', 20).toISOString(), '2027-04-02T18:00:00.000Z');
  });
});

describe('isRadioVoteOpen', () => {
  it('is open Friday 12:00 to 19:59 Prague time', () => {
    assert.equal(isRadioVoteOpen(TZ, prague('2026-10-23', 11, 59)), false);
    assert.equal(isRadioVoteOpen(TZ, prague('2026-10-23', 12, 0)), true);
    assert.equal(isRadioVoteOpen(TZ, prague('2026-10-23', 19, 59)), true);
    assert.equal(isRadioVoteOpen(TZ, prague('2026-10-23', 20, 0)), false);
  });

  it('is closed on other days', () => {
    assert.equal(isRadioVoteOpen(TZ, prague('2026-10-22', 15)), false);
    assert.equal(isRadioVoteOpen(TZ, prague('2026-10-24', 15)), false);
  });

  it('follows Prague time, not UTC, after the clocks change', () => {
    // Friday 30 Oct 2026 is the first Friday on winter time: 12:00 Prague is 11:00 UTC.
    assert.equal(isRadioVoteOpen(TZ, new Date('2026-10-30T11:00:00Z')), true);
    assert.equal(isRadioVoteOpen(TZ, new Date('2026-10-30T10:59:00Z')), false);
  });
});

describe('radioNightWeekKey', () => {
  it('is the Prague calendar date', () => {
    // 23:30 UTC on Thursday is already Friday in Prague.
    assert.equal(radioNightWeekKey(TZ, new Date('2026-10-22T23:30:00Z')), '2026-10-23');
  });
});

describe('nextRadioNight', () => {
  it('is this Friday while 20:00 is still ahead', () => {
    const { voteOpens, starts } = nextRadioNight(TZ, prague('2026-10-21', 9));
    assert.equal(voteOpens.toISOString(), prague('2026-10-23', 12).toISOString());
    assert.equal(starts.toISOString(), prague('2026-10-23', 20).toISOString());
  });

  it('is today on Friday before 20:00', () => {
    const { starts } = nextRadioNight(TZ, prague('2026-10-23', 19, 30));
    assert.equal(starts.toISOString(), prague('2026-10-23', 20).toISOString());
  });

  it('moves to next Friday at 20:00, across the clock change', () => {
    const { starts } = nextRadioNight(TZ, prague('2026-10-23', 20));
    assert.equal(starts.toISOString(), '2026-10-30T19:00:00.000Z');
  });

  it('counts from Saturday to the next Friday', () => {
    const { starts } = nextRadioNight(TZ, prague('2026-10-24', 10));
    assert.equal(starts.toISOString(), prague('2026-10-30', 20).toISOString());
  });
});

describe('chartWeek', () => {
  it('runs Monday 00:00 to Sunday 18:00 across the October clock change', () => {
    const week = chartWeek(TZ, prague('2026-10-24', 15));
    assert.equal(week.mondayKey, '2026-10-19');
    assert.equal(week.fridayKey, '2026-10-23');
    assert.equal(week.sundayKey, '2026-10-25');
    assert.equal(week.from.toISOString(), '2026-10-18T22:00:00.000Z');
    assert.equal(week.to.toISOString(), '2026-10-25T17:00:00.000Z');
    assert.equal(week.label, '19–25 Oct');
  });

  it('treats Sunday as the end of the week, not the start', () => {
    assert.equal(chartWeek(TZ, prague('2026-10-25', 18)).mondayKey, '2026-10-19');
  });

  it('runs across the March clock change', () => {
    const week = chartWeek(TZ, prague('2027-03-24', 12));
    assert.equal(week.from.toISOString(), '2027-03-21T23:00:00.000Z');
    assert.equal(week.to.toISOString(), '2027-03-28T16:00:00.000Z');
  });

  it('labels a week that spans two months', () => {
    assert.equal(chartWeek(TZ, prague('2026-11-01', 12)).label, '26 Oct – 1 Nov');
  });
});

describe('previousMonth', () => {
  it('is October when November opens, across the clock change', () => {
    const period = previousMonth(TZ, prague('2026-11-01', 12));
    assert.equal(period.key, '2026-10');
    assert.equal(period.label, 'October 2026');
    assert.equal(period.startKey, '2026-10-01');
    assert.equal(period.yearly, false);
    assert.equal(period.from.toISOString(), '2026-09-30T22:00:00.000Z');
    assert.equal(period.to.toISOString(), '2026-10-31T22:59:59.999Z');
  });

  it('is December of the previous year on 1 January', () => {
    const period = previousMonth(TZ, prague('2026-01-01', 18));
    assert.equal(period.key, '2025-12');
    assert.equal(period.label, 'December 2025');
    assert.equal(period.from.toISOString(), '2025-11-30T23:00:00.000Z');
    assert.equal(period.to.toISOString(), '2025-12-31T22:59:59.999Z');
  });

  it('ends February on the 28th in a common year', () => {
    const period = previousMonth(TZ, prague('2026-03-02', 9));
    assert.equal(period.key, '2026-02');
    assert.equal(period.label, 'February 2026');
    assert.equal(period.to.toISOString(), '2026-02-28T22:59:59.999Z');
  });
});

describe('previousYear', () => {
  it('is the previous calendar year, midnight to the last millisecond', () => {
    const period = previousYear(TZ, prague('2026-10-27', 15));
    assert.equal(period.key, '2025');
    assert.equal(period.label, '2025');
    assert.equal(period.startKey, '2025-01-01');
    assert.equal(period.yearly, true);
    assert.equal(period.from.toISOString(), '2024-12-31T23:00:00.000Z');
    assert.equal(period.to.toISOString(), '2025-12-31T22:59:59.999Z');
  });
});

describe('monthToDate', () => {
  it('runs from the 1st through the given instant', () => {
    const now = prague('2026-10-27', 15, 30);
    const period = monthToDate(TZ, now);
    assert.equal(period.key, '2026-10');
    assert.equal(period.label, 'October 2026');
    assert.equal(period.startKey, '2026-10-01');
    assert.equal(period.yearly, false);
    assert.equal(period.from.toISOString(), '2026-09-30T22:00:00.000Z');
    assert.equal(period.to.toISOString(), now.toISOString());
  });
});

describe('kitchenDateLabel', () => {
  it('names the Prague day, with the year only when asked', () => {
    const instant = prague('2026-10-27', 0, 30);
    assert.equal(kitchenDateLabel(TZ, instant, false), '27 October');
    assert.equal(kitchenDateLabel(TZ, instant, true), '27 October 2026');
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { playLogKind } from '../src/fm/KitchenFm';

describe('playLogKind', () => {
  it('files a new find, a station pick, a dedication, then an ordinary play', () => {
    assert.equal(playLogKind({ stationPick: true }, { how: 'new', dedicated: true }), 'find');
    assert.equal(playLogKind({ stationPick: true }, { how: 'play', dedicated: false }), 'fm');
    assert.equal(playLogKind({ stationPick: true }, { how: 'catch', dedicated: true }), 'fm');
    assert.equal(playLogKind({}, { how: 'play', dedicated: true }), 'dedication');
    assert.equal(playLogKind({}, null), 'play');
  });
});

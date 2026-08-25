import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadFrom,
  saveTo,
  clearStorage,
  buildSaveFromSnapshot,
  emptySave,
  defaultStorage,
  STORAGE_KEY,
  STORAGE_VERSION
} from '../src/sim/storage.js';
import { SPECIES } from '../src/sim/fishing.js';

function mem() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    get length() { return m.size; }
  };
}

test('emptySave returns a fresh, valid shell', () => {
  const s = emptySave();
  assert.equal(s.v, STORAGE_VERSION);
  assert.deepEqual(s.dex, {});
  assert.deepEqual(s.log, {});
  assert.deepEqual(s.stats, { catches: 0, escaped: 0, bestScore: 0 });
  assert.equal(s.bait, 'worm');
  assert.equal(s.savedAt, 0);
});

test('loadFrom returns emptySave on missing key', () => {
  const s = loadFrom(mem());
  assert.deepEqual(s, emptySave());
});

test('loadFrom returns emptySave on corrupted JSON', () => {
  const storage = mem();
  storage.setItem(STORAGE_KEY, '{not-json');
  assert.deepEqual(loadFrom(storage), emptySave());
});

test('loadFrom returns emptySave on wrong schema version', () => {
  const storage = mem();
  storage.setItem(STORAGE_KEY, JSON.stringify({ v: 999, dex: {} }));
  assert.deepEqual(loadFrom(storage), emptySave());
});

test('saveTo then loadFrom roundtrips a populated save', () => {
  const storage = mem();
  const save = emptySave();
  save.dex.koi = { count: 4, best: 65 };
  save.dex.trout = { count: 17, best: 41 };
  save.log.koi = [
    { speciesId: 'koi', bait: 'berry', castPower: 0.62, hookDelayMs: 480,
      peakTension: 0.7, success: true, sizeCm: 55, ts: 1234 }
  ];
  save.stats.catches = 5;
  save.stats.bestScore = 320;
  save.bait = 'berry';
  save.savedAt = 1234567;

  assert.equal(saveTo(storage, save), true);
  const loaded = loadFrom(storage);
  assert.deepEqual(loaded.dex, save.dex);
  assert.equal(loaded.log.koi.length, 1);
  assert.equal(loaded.stats.catches, 5);
  assert.equal(loaded.stats.bestScore, 320);
  assert.equal(loaded.bait, 'berry');
});

test('loadFrom drops orphan dex entries whose species no longer exist', () => {
  const storage = mem();
  storage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      v: 1,
      dex: { koi: { count: 1, best: 50 }, ghost_species: { count: 9, best: 99 } },
      log: {},
      stats: {},
      bait: 'worm',
      savedAt: 0
    })
  );
  const loaded = loadFrom(storage);
  assert.ok(loaded.dex.koi, 'kept known species');
  assert.ok(!loaded.dex.ghost_species, 'dropped unknown species');
});

test('loadFrom clamps invalid stat values', () => {
  const storage = mem();
  storage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      v: 1,
      dex: {},
      log: {},
      stats: { catches: 'oops', escaped: -3, bestScore: 'NaN' },
      bait: 42,
      savedAt: 'now'
    })
  );
  const loaded = loadFrom(storage);
  assert.equal(loaded.stats.catches, 0);
  assert.equal(loaded.stats.escaped, 0);
  assert.equal(loaded.stats.bestScore, 0);
  assert.equal(loaded.bait, 'worm'); // falls back to default
  assert.equal(loaded.savedAt, 0);
});

test('saveTo returns false on a throwing storage', () => {
  const broken = { setItem() { throw new Error('quota'); } };
  assert.equal(saveTo(broken, emptySave()), false);
});

test('loadFrom returns emptySave on a throwing storage', () => {
  const broken = { getItem() { throw new Error('blocked'); } };
  assert.deepEqual(loadFrom(broken), emptySave());
});

test('clearStorage removes the key', () => {
  const storage = mem();
  saveTo(storage, emptySave());
  assert.ok(storage.getItem(STORAGE_KEY));
  assert.equal(clearStorage(storage), true);
  assert.equal(storage.getItem(STORAGE_KEY), null);
});

test('buildSaveFromSnapshot copies dex, log, stats, bait, and timestamps', () => {
  const snap = {
    bait: 'beet',
    stats: { catches: 7, escaped: 2, bestScore: 250 },
    dex: { perch: { count: 3, best: 38 } }
  };
  const log = { perch: [{ speciesId: 'perch', bait: 'worm', success: true, sizeCm: 38 }] };
  const t0 = Date.now();
  const save = buildSaveFromSnapshot(snap, { log });
  assert.equal(save.bait, 'beet');
  assert.equal(save.stats.catches, 7);
  assert.equal(save.dex.perch.count, 3);
  assert.equal(save.log.perch.length, 1);
  assert.ok(save.savedAt >= t0, 'timestamp is recent');
});

test('defaultStorage is callable and survives a missing global localStorage', () => {
  // We don't tear down the real localStorage here (Node already has no DOM),
  // but we exercise the constructor path that private-mode Safari uses.
  const storage = defaultStorage();
  assert.equal(typeof storage.getItem, 'function');
  assert.equal(typeof storage.setItem, 'function');
  // A round-trip via the default adapter.
  saveTo(storage, emptySave());
  assert.ok(loadFrom(storage).v === STORAGE_VERSION);
});

test('every species id in SPECIES is loadable with an empty entry', () => {
  // Build a save that pretends to know every species; loading it should keep
  // them all even with empty values.
  const storage = mem();
  const dex = {};
  for (const sp of SPECIES) dex[sp.id] = { count: 0, best: 0 };
  storage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, dex, log: {}, stats: {}, bait: 'worm', savedAt: 0 }));
  const loaded = loadFrom(storage);
  for (const sp of SPECIES) {
    assert.ok(loaded.dex[sp.id], `${sp.id} kept in loadFrom`);
    assert.equal(loaded.dex[sp.id].count, 0);
  }
});

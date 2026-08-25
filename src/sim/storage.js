// Persistent storage for the dex, delegate log, and progress counters.
//
// The module is pure: it takes a Storage-like object (anything with getItem /
// setItem / removeItem, plus optional length/key for diagnostics) and never
// touches the DOM or localStorage directly. That makes it trivially testable
// with an in-memory map and reusable outside the browser if we ever want a
// Node-side importer.
//
// Schema version: bump and add a migration step when the on-disk shape
// changes. Old saves are dropped cleanly on unknown versions — the worst case
// is "your dex reset to zero", which is fine for a free game.

import { SPECIES } from './fishing.js';

export const STORAGE_VERSION = 1;
export const STORAGE_KEY = 'luminous-lake/save/v1';

// A clean, empty save. Returned on first run, on a missing key, and on
// unparseable / wrong-version blobs. The shape MUST stay backwards
// compatible — fields may be added but not removed.
export function emptySave() {
  return {
    v: STORAGE_VERSION,
    dex: {}, // species id -> { count, best }
    log: {}, // species id -> [{ bait, castPower, hookDelayMs, peakTension, success, sizeCm, ts }]
    stats: { catches: 0, escaped: 0, bestScore: 0 },
    bait: 'worm',
    savedAt: 0
  };
}

// Coerce a loaded record into the shape we expect. Drops entries for
// species that no longer exist (id was removed) so old saves from before a
// dex shrink don't carry orphans.
function normalize(rec) {
  const base = emptySave();
  if (!rec || typeof rec !== 'object') return base;
  if (rec.v !== STORAGE_VERSION) return base; // unknown / future schema

  // Merge defensively — every field defaults if missing.
  base.v = STORAGE_VERSION;
  base.dex = {};
  if (rec.dex && typeof rec.dex === 'object') {
    const knownIds = new Set(SPECIES.map((s) => s.id));
    for (const [id, d] of Object.entries(rec.dex)) {
      if (!knownIds.has(id)) continue;
      if (!d || typeof d !== 'object') continue;
      base.dex[id] = {
        count: Number.isFinite(d.count) && d.count >= 0 ? d.count : 0,
        best: Number.isFinite(d.best) && d.best >= 0 ? d.best : 0
      };
    }
  }
  base.log = {};
  if (rec.log && typeof rec.log === 'object') {
    for (const [id, entries] of Object.entries(rec.log)) {
      if (!Array.isArray(entries)) continue;
      const cleaned = [];
      for (const e of entries) {
        if (!e || typeof e !== 'object') continue;
        if (typeof e.speciesId !== 'string' && typeof e.species !== 'string') continue;
        cleaned.push({
          speciesId: e.speciesId || (e.species && e.species.id),
          bait: typeof e.bait === 'string' ? e.bait : 'worm',
          castPower: Number.isFinite(e.castPower) ? e.castPower : 0,
          hookDelayMs: Number.isFinite(e.hookDelayMs) ? e.hookDelayMs : 0,
          peakTension: Number.isFinite(e.peakTension) ? e.peakTension : 0,
          success: !!e.success,
          sizeCm: Number.isFinite(e.sizeCm) ? e.sizeCm : null,
          ts: Number.isFinite(e.ts) ? e.ts : Date.now()
        });
      }
      if (cleaned.length) base.log[id] = cleaned;
    }
  }
  if (rec.stats && typeof rec.stats === 'object') {
    base.stats.catches = Number.isFinite(rec.stats.catches) ? Math.max(0, rec.stats.catches) : 0;
    base.stats.escaped = Number.isFinite(rec.stats.escaped) ? Math.max(0, rec.stats.escaped) : 0;
    base.stats.bestScore = Number.isFinite(rec.stats.bestScore) ? Math.max(0, rec.stats.bestScore) : 0;
  }
  base.bait = typeof rec.bait === 'string' ? rec.bait : 'worm';
  base.savedAt = Number.isFinite(rec.savedAt) ? rec.savedAt : 0;
  return base;
}

// Strip entries that we don't want to persist (e.g. live UI state) from a
// runtime dex/log before serializing. Today the snapshot shapes already match
// what we save, so this is mostly a hook for the future.
export function buildSaveFromSnapshot(snapshot, opts = {}) {
  const save = emptySave();
  save.dex = JSON.parse(JSON.stringify(snapshot.dex || {}));
  save.log = JSON.parse(JSON.stringify(opts.log || {}));
  save.stats = {
    catches: snapshot.stats?.catches || 0,
    escaped: snapshot.stats?.escaped || 0,
    bestScore: snapshot.stats?.bestScore || 0
  };
  save.bait = snapshot.bait || 'worm';
  save.savedAt = Date.now();
  return save;
}

// ---- Storage I/O -------------------------------------------------------

// Read the saved blob. Returns a normalized save or emptySave() on any
// failure (missing key, bad JSON, wrong version, etc.). Never throws.
export function loadFrom(storage, key = STORAGE_KEY) {
  if (!storage) return emptySave();
  let raw;
  try {
    raw = storage.getItem(key);
  } catch {
    return emptySave();
  }
  if (!raw) return emptySave();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptySave();
  }
  return normalize(parsed);
}

// Write a save. Returns true on success, false on quota or serialisation
// errors (quota errors are silently dropped — a corrupt write is worse than
// a missing one).
export function saveTo(storage, save, key = STORAGE_KEY) {
  if (!storage) return false;
  const payload = JSON.stringify(save);
  try {
    storage.setItem(key, payload);
    return true;
  } catch {
    return false;
  }
}

export function clearStorage(storage, key = STORAGE_KEY) {
  if (!storage) return false;
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

// A safe adapter that picks localStorage when available and falls back to
// an in-memory shim in private-mode browsers or non-browser environments.
export function defaultStorage() {
  try {
    if (typeof localStorage !== 'undefined') {
      // Touch it once to surface the SecurityError Safari throws in private mode.
      const probe = '__ll_probe__';
      localStorage.setItem(probe, probe);
      localStorage.removeItem(probe);
      return localStorage;
    }
  } catch {
    /* fall through to shim */
  }
  return new InMemoryStorage();
}

class InMemoryStorage {
  constructor() { this._map = new Map(); }
  getItem(k) { return this._map.has(k) ? this._map.get(k) : null; }
  setItem(k, v) { this._map.set(k, String(v)); }
  removeItem(k) { this._map.delete(k); }
  get length() { return this._map.size; }
  key(i) { return Array.from(this._map.keys())[i] || null; }
}

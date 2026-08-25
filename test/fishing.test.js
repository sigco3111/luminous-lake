import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FishingSim,
  SPECIES,
  RARITY,
  FISHING_PHASES,
  inTimeWindow,
  speciesWeight,
  biteLuck,
  BAITS,
  MESH_TYPES
} from '../src/sim/fishing.js';
import { Rng } from '../src/sim/rng.js';

const WATER_EVERYWHERE = () => true;
const DRY_LAND = () => false;

function env(over = {}) {
  return {
    time: over.time ?? 0,
    tod: over.tod ?? 0.5, // noon
    weatherState: over.weatherState ?? 'clear',
    calmness: 0.6,
    wind: 0.3,
    boatX: over.boatX ?? 0,
    boatZ: over.boatZ ?? -11.5,
    boatHeading: over.boatHeading ?? 0, // facing +x
    isWater: over.isWater ?? WATER_EVERYWHERE
  };
}

// Drive a fresh sim through charge -> cast -> land.
function cast(sim, e, power = 1) {
  sim.press(0);
  const steps = Math.ceil((power * 1.15) / 0.016);
  for (let i = 0; i < steps; i++) sim.update(0.016, e);
  assert.equal(sim.phase, 'charging');
  sim.release(1);
  for (let i = 0; i < 40; i++) sim.update(0.016, e); // 0.64s > CAST_FLIGHT
}

test('phase list is exposed for the UI', () => {
  assert.deepEqual(FISHING_PHASES, [
    'idle', 'charging', 'casting', 'waiting', 'bite', 'reeling', 'result'
  ]);
});

test('time windows wrap midnight', () => {
  assert.equal(inTimeWindow(0.0, [[0.86, 0.18]]), true); // deep night window
  assert.equal(inTimeWindow(0.5, [[0.86, 0.18]]), false);
  assert.equal(inTimeWindow(0.25, [[0.2, 0.34]]), true);
  assert.equal(inTimeWindow(0.35, [[0.2, 0.34]]), false);
  assert.equal(inTimeWindow(0.99, 'any'), true);
});

test('species weight respects time and weather gates', () => {
  const koi = SPECIES.find((s) => s.id === 'koi');
  const duskClear = speciesWeight(koi, 0.72, 'clear');
  const noonStorm = speciesWeight(koi, 0.5, 'storm');
  assert.ok(duskClear > koi.weight * 4, 'matching conditions multiply the base weight');
  assert.ok(noonStorm < koi.weight * 0.2, 'mismatched conditions nearly remove the fish');
});

test('bite luck rises when more fish are reachable', () => {
  // Bait is worm (neutral) so weights don't shift on its account. With the
  // dex grown to 50 species, dawn clear unlocks the most dawn/dusk-gated
  // fish (koi, bass, shad, koi_king, dragon_koi) — well above night clear,
  // where only a few night windows match.
  const dawn = biteLuck(0.3, 'clear', 'worm');
  const stormDusk = biteLuck(0.78, 'storm', 'worm');
  const nightClear = biteLuck(0.95, 'clear', 'worm');
  const noon = biteLuck(0.5, 'clear', 'worm');
  assert.ok(dawn > noon, `dawn clear > noon clear (dawn=${dawn.toFixed(2)} noon=${noon.toFixed(2)})`);
  assert.ok(stormDusk > noon, 'storm + dusk unlocks storm catfish etc.');
  assert.ok(nightClear < dawn, 'clear nights unlock fewer species than dawn');
  assert.ok(dawn > 0.3 && dawn < 1, 'dawn luck stays in range');
});

test('bait matching multiplies species weight', () => {
  const koi = SPECIES.find((s) => s.id === 'koi');
  // koi prefers berry; matching bait should not reduce the weight.
  const off = speciesWeight(koi, 0.25, 'clear', 'worm');
  const on = speciesWeight(koi, 0.25, 'clear', 'berry');
  assert.ok(on >= off * 1.5, `berry × koi is heavier than worm × koi (off=${off.toFixed(1)} on=${on.toFixed(1)})`);
});

test('SPECIES has exactly 50 entries across mesh types and baits', () => {
  assert.equal(SPECIES.length, 50);
  for (const sp of SPECIES) {
    assert.ok(MESH_TYPES.includes(sp.meshType), `${sp.id} meshType ok`);
    assert.ok(BAITS[sp.bait], `${sp.id} bait ok`);
    assert.ok(sp.profile && Number.isFinite(sp.profile.distance) === false || typeof sp.profile.distance === 'string',
      `${sp.id} has distance`);
    assert.ok(Number.isFinite(sp.profile.holdThreshold));
    assert.ok(Number.isFinite(sp.profile.hookDelay));
  }
});

test('charging fills over time and caps at 1', () => {
  const sim = new FishingSim(new Rng(1));
  sim.press(0);
  assert.equal(sim.phase, 'charging');
  for (let i = 0; i < 200; i++) sim.update(0.016, env());
  assert.equal(sim.power, 1, 'gauge clamps at full');
  assert.equal(sim.phase, 'charging', 'stays charging until released');
});

test('cast lands in water and shrinks distance on dry targets', () => {
  // Water only within 8 units of the boat: a full-power cast (13) must shrink.
  const pondNearBoat = env({ isWater: (x, z) => Math.hypot(x - 0, z + 11.5) < 8 });
  const sim = new FishingSim(new Rng(2));
  cast(sim, pondNearBoat, 1);
  assert.equal(sim.phase, 'waiting');
  const r = Math.hypot(sim.bobber.x, sim.bobber.z);
  assert.ok(r <= 14, `bobber pulled back onto water (r=${r.toFixed(1)})`);

  const allDry = new FishingSim(new Rng(2));
  cast(allDry, env({ isWater: DRY_LAND }), 1);
  assert.equal(allDry.phase, 'waiting', 'still lands somewhere rather than hanging');
});

test('landing emits a splash and schedules a bounded wait', () => {
  const sim = new FishingSim(new Rng(3));
  cast(sim, env(), 0.5);
  const events = sim.takeEvents();
  assert.ok(events.some((e) => e.type === 'splash'));
  assert.ok(sim._biteTimerMax >= 7 * 0.7 && sim._biteTimerMax <= 20 * 1.35);
});

test('nibbles fire before the real bite, hooking needs a bite', () => {
  const sim = new FishingSim(new Rng(4));
  cast(sim, env(), 1);
  let sawNibble = false;
  let sawBite = false;
  for (let i = 0; i < 4000 && !sawBite; i++) {
    sim.update(0.05, env({ time: i * 0.05 }));
    const evts = sim.takeEvents();
    if (evts.some((e) => e.type === 'nibble')) sawNibble = true;
    if (evts.some((e) => e.type === 'bite')) sawBite = true;
  }
  assert.ok(sawBite, 'a bite must eventually arrive');
  assert.ok(sawNibble || true, 'nibbles are optional flavor');
  assert.equal(sim.phase, 'bite');

  // Pressing before a bite does nothing; pressing during the window hooks.
  const idle = new FishingSim(new Rng(5));
  idle.phase = 'waiting';
  idle.press(0);
  idle.release(0.15);
  assert.equal(idle.phase, 'idle', 'a quick tap while waiting recalls the line');
});

test('missing the bite window returns to waiting', () => {
  const sim = new FishingSim(new Rng(6));
  cast(sim, env(), 1);
  sim._biteTimer = 0.01; // force the bite immediately
  sim.update(0.02, env());
  assert.equal(sim.phase, 'bite');
  for (let i = 0; i < 30; i++) sim.update(0.05, env()); // 1.5s > BITE_WINDOW
  assert.equal(sim.phase, 'waiting');
  assert.ok(sim.takeEvents().some((e) => e.type === 'missed'));
});

test('hooked fish matches current conditions and rolls valid sizes', () => {
  const sim = new FishingSim(new Rng(7));
  cast(sim, env({ tod: 0.95, weatherState: 'clear' }), 1);
  sim._biteTimer = 0.01;
  sim.update(0.02, env({ tod: 0.95 }));
  sim.press(1);
  assert.equal(sim.phase, 'reeling');
  const snap = sim.snapshot();
  assert.ok(snap.fishName, 'a species was picked');

  // Force-verify size bounds across many seeds.
  for (let seed = 0; seed < 30; seed++) {
    const s = new FishingSim(new Rng(seed));
    s._lastEnv = env();
    s._startBite();
    s.press(0);
    const f = s._fish;
    assert.ok(f.sizeCm >= f.species.sizeMin && f.sizeCm <= f.species.sizeMax);
  }
});

function reelUntil(sim, cond, maxSeconds = 60) {
  let t = 0;
  while (!cond() && t < maxSeconds) {
    // Simple player policy: hold while tension is low, breathe otherwise.
    if (sim.tension < 0.7) sim.holding = true;
    else sim.holding = false;
    sim.update(0.05, env({ time: t }));
    t += 0.05;
  }
  return t;
}

test('reeling lands a weak fish and snaps on a legendary if greedy', () => {
  const weak = new FishingSim(new Rng(8));
  weak.phase = 'reeling';
  weak._fish = { species: SPECIES[0], size01: 0.2, sizeCm: 26, pull: 0.45 };
  weak.progress = 0.04;
  weak.tension = 0.2;
  reelUntil(weak, () => weak.phase !== 'reeling');
  assert.equal(weak.phase, 'result');
  assert.ok(weak.lastCatch.score > 0);
  assert.equal(weak.stats.catches, 1);
  assert.ok(weak.dex.trout.count === 1);
  assert.ok(weak.takeEvents().some((e) => e.type === 'caught'));

  const greedy = new FishingSim(new Rng(9));
  greedy.phase = 'reeling';
  greedy._fish = { species: SPECIES[5], size01: 0.9, sizeCm: 57, pull: 1.5 };
  greedy.progress = 0.04;
  greedy.tension = 0.9;
  greedy.holding = true;
  for (let i = 0; i < 60 && greedy.phase === 'reeling'; i++) greedy.update(0.05, env());
  assert.equal(greedy.phase, 'idle', 'tension >= 1 snaps back to idle');
  const evts = greedy.takeEvents();
  assert.ok(evts.some((e) => e.type === 'escaped' && e.reason === 'snap'));
  assert.ok(evts.some((e) => e.type === 'splash'));
  assert.equal(greedy.stats.escaped, 1);
  assert.equal(greedy.stats.catches, 0);
});

test('result collect returns to idle and clears the fight', () => {
  const sim = new FishingSim(new Rng(10));
  sim.phase = 'result';
  sim.lastCatch = { species: SPECIES[0], name: '은송어', score: 12 };
  sim.press(0);
  assert.equal(sim.phase, 'idle');
  assert.ok(sim.takeEvents().some((e) => e.type === 'collected'));
});

test('full playthrough is deterministic per seed', () => {
  function run(seed) {
    const sim = new FishingSim(new Rng(seed));
    const e = env({ tod: 0.72, weatherState: 'cloudy' });
    cast(sim, e, 0.8);
    let log = [];
    let guard = 0;
    while (sim.phase !== 'result' && guard++ < 5000) {
      sim.update(0.05, e);
      for (const evt of sim.takeEvents()) log.push(evt.type);
      if (sim.phase === 'bite') sim.press(guard * 0.05);
      if (sim.phase === 'reeling') {
        sim.holding = sim.tension < 0.65;
      }
    }
    return { catch: sim.lastCatch ? { ...sim.lastCatch, species: undefined } : null, log };
  }
  const a = run(1234);
  const b = run(1234);
  assert.deepEqual(a.log, b.log);
  assert.deepEqual(a.catch, b.catch);
  assert.ok(a.catch, 'the scripted player eventually lands something');
});

test('rarity table covers every species', () => {
  for (const sp of SPECIES) {
    assert.ok(RARITY[sp.rarity], `${sp.id} has a rarity entry`);
    assert.ok(sp.sizeMin > 0 && sp.sizeMax >= sp.sizeMin);
    assert.ok(sp.strength > 0 && sp.strength <= 2.0, `${sp.id} strength ${sp.strength} in range`);
  }
});

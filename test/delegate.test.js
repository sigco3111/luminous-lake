import test from 'node:test';
import assert from 'node:assert/strict';
import { DelegateAgent, DelegateLog } from '../src/sim/delegate.js';
import { FishingSim, SPECIES, BAITS } from '../src/sim/fishing.js';
import { Rng } from '../src/sim/rng.js';

function env(over = {}) {
  return {
    time: over.time ?? 0,
    tod: over.tod ?? 0.3,
    weatherState: over.weatherState ?? 'clear',
    calmness: 0.6,
    wind: 0.3,
    boatX: over.boatX ?? 0,
    boatZ: over.boatZ ?? -11.5,
    boatHeading: over.boatHeading ?? 0,
    isWater: over.isWater ?? (() => true)
  };
}

test('DelegateAgent picks a reachable target and bait', () => {
  const sim = new FishingSim(new Rng(1));
  const agent = new DelegateAgent(new Rng(2), sim);
  const target = agent.pickTarget(env({ tod: 0.3, weatherState: 'clear' }));
  assert.ok(target, 'target exists');
  assert.ok(SPECIES.includes(target), 'target is a real species');
  const bait = agent.pickBait(env({ tod: 0.3 }));
  assert.ok(BAITS[bait], 'bait is one of the registered baits');
});

test('DelegateAgent picks a berry bait at dawn (koi window opens)', () => {
  const sim = new FishingSim(new Rng(3));
  const agent = new DelegateAgent(new Rng(3), sim);
  // Dawn clear unlocks koi, koi_king, dragon_koi — berry is the bait that
  // multiplies their weight, so the agent should pick berry here.
  const dawn = agent.pickBait(env({ tod: 0.27, weatherState: 'clear' }));
  const noon = agent.pickBait(env({ tod: 0.5, weatherState: 'clear' }));
  assert.equal(dawn, 'berry');
  assert.ok(['worm', 'berry', 'beet'].includes(noon));
});

test('DelegateAgent charges based on the target distance profile', () => {
  const sim = new FishingSim(new Rng(4));
  const agent = new DelegateAgent(new Rng(4), sim);
  // Force a near-target and check power is low.
  const near = SPECIES.find((s) => s.profile.distance === 'near');
  const far = SPECIES.find((s) => s.profile.distance === 'far');
  agent._target = near;
  const pNear = agent.planPower(env());
  agent._target = far;
  const pFar = agent.planPower(env());
  assert.ok(pNear < pFar, `near power ${pNear.toFixed(2)} < far power ${pFar.toFixed(2)}`);
  assert.ok(pNear >= 0.18 && pNear <= 0.55);
  assert.ok(pFar >= 0.75);
});

test('DelegateAgent drives a full cast→land cycle deterministically', () => {
  const sim = new FishingSim(new Rng(5));
  const agent = new DelegateAgent(new Rng(5), sim);
  const e = env({ tod: 0.3, weatherState: 'clear' });

  // Step the whole loop using the agent + sim. The first iteration kicks the
  // sim out of idle (press); subsequent iterations run until we either catch
  // a fish or bail out at the iteration cap.
  const log = [];
  let phaseBefore = sim.phase;
  for (let i = 0; i < 800; i++) {
    agent.tick(e);
    sim.update(0.05, e);
    if (sim.phase !== phaseBefore) {
      log.push(`${i}:${phaseBefore}->${sim.phase}`);
      phaseBefore = sim.phase;
    }
    if (sim.phase === 'bite' && sim._biteWindow <= 0.15) sim.press(e.time);
    if (sim.phase === 'result') {
      const rec = agent.describeFight();
      sim.press(e.time);
      sim.update(0.05, e);
      log.push(`${i}:result -> rec=${rec.species ? rec.species.id : 'null'}`);
      break;
    }
  }
  const last = log[log.length - 1];
  assert.ok(last && last.includes('rec='), `a fight was recorded (got: ${JSON.stringify(log)})`);
  const recId = last.split('rec=')[1];
  assert.ok(SPECIES.find((s) => s.id === recId), `${recId} is a real species`);
});

test('DelegateAgent turns bite into a hook within its window', () => {
  const sim = new FishingSim(new Rng(6));
  const agent = new DelegateAgent(new Rng(6), sim);
  // Force a near target with a short hookDelay to validate hook timing.
  const target = SPECIES.find((s) => s.id === 'smelt'); // hookDelay 0.3 s
  agent._target = target;
  // Jump straight to bite phase with a full window.
  sim.phase = 'bite';
  sim._biteWindow = 1.15; // brand new bite
  const e = env();
  // Tick the sim a few times with small dt to age the bite within window.
  for (let i = 0; i < 10 && sim.phase === 'bite'; i++) {
    agent.tick(e);
    sim.update(0.05, e);
  }
  assert.equal(sim.phase, 'reeling', 'agent hooked the bite within the window');
});

test('DelegateAgent releases tension when near the hold threshold', () => {
  const sim = new FishingSim(new Rng(7));
  const agent = new DelegateAgent(new Rng(7), sim);
  sim.phase = 'reeling';
  sim._fish = {
    species: SPECIES.find((s) => s.id === 'trout'),
    size01: 0.5, sizeCm: 34, pull: 0.55,
    hookDelay: 0.35, holdThreshold: 0.62, startedAt: 0
  };
  sim.tension = 0.4;
  sim.progress = 0.5;
  assert.equal(agent.planHold(env()), true);
  sim.tension = 0.7;
  assert.equal(agent.planHold(env()), false);
});

test('DelegateLog records catches and produces a tip', () => {
  const log = new DelegateLog();
  const sp = SPECIES.find((s) => s.id === 'koi');
  log.record({ species: sp, bait: 'berry', castPower: 0.65, hookDelayMs: 480, peakTension: 0.7, success: true, sizeCm: 55 });
  log.record({ species: sp, bait: 'worm', castPower: 0.6, hookDelayMs: 480, peakTension: 0.9, success: false });
  const tip = log.tip('koi');
  assert.ok(tip);
  assert.equal(tip.attempts, 2);
  assert.equal(tip.successes, 1);
  assert.equal(tip.bait, 'berry', 'tip uses the last successful bait');
  assert.equal(tip.sizeCm, 55);
  const list = log.snapshot();
  assert.equal(list.koi.length, 2);
});

test('DelegateLog caps entries per species', () => {
  const log = new DelegateLog();
  const sp = SPECIES.find((s) => s.id === 'trout');
  for (let i = 0; i < 12; i++) {
    log.record({ species: sp, bait: 'worm', castPower: 0.5, hookDelayMs: 350, peakTension: 0.6, success: true, sizeCm: 30 + i });
  }
  assert.equal(log.entries.trout.length, 6, 'keeps last 6');
  assert.equal(log.entries.trout[5].sizeCm, 41, 'newest entry is the last');
});

test('DelegateLog tip returns null for unknown species', () => {
  const log = new DelegateLog();
  assert.equal(log.tip('ghost'), null);
});

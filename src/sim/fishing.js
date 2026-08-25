// Fishing simulation — pure module (no three imports).
// Deterministic given its Rng and delta-time driven, matching the other sim
// modules. The view layer reads plain-data state (bobber xz, dip, tension...)
// and drains the event queue each frame.
//
// Phase flow:
//   idle -> charging -> casting -> waiting -> bite -> reeling -> result -> idle
//   waiting --(quick tap)--> idle  (recall)
//   bite timeout -> waiting        (missed)
//   reeling: tension >= 1 -> escaped(snap), progress >= 1 -> caught

import { clamp01, lerp, wrapTime } from './controls.js';

export const FISHING_PHASES = ['idle', 'charging', 'casting', 'waiting', 'bite', 'reeling', 'result'];

// -------------------------------------------------------------- species ----
// time: 'any' | array of [from, to] windows in time-of-day space (wrap-aware).
// weather: 'any' | array of weather state names. Off-condition fish can still
// bite but at a heavily reduced weight instead of never.
export const SPECIES = [
  {
    id: 'trout', name: '은송어', rarity: 'common', weight: 100,
    sizeMin: 22, sizeMax: 46, strength: 0.55, time: 'any', weather: 'any',
    note: '호수 어디든 만나는 기본 물고기'
  },
  {
    id: 'dace', name: '달빛피라미', rarity: 'common', weight: 70,
    sizeMin: 14, sizeMax: 30, strength: 0.42, time: [[0.78, 0.3]], weather: 'any',
    note: '밤이면 수면 가까이 올라온다'
  },
  {
    id: 'perch', name: '황혼우럭', rarity: 'uncommon', weight: 45,
    sizeMin: 26, sizeMax: 52, strength: 0.72, time: [[0.2, 0.34], [0.66, 0.82]], weather: 'any',
    note: '해 무렵 얕은 여울을 오간다'
  },
  {
    id: 'koi', name: '금잉어', rarity: 'rare', weight: 24,
    sizeMin: 40, sizeMax: 78, strength: 0.95, time: [[0.22, 0.36], [0.68, 0.8]], weather: ['clear', 'cloudy'],
    note: '맑은 날 황금빛 시간대에만 모습을 드러낸다'
  },
  {
    id: 'catfish', name: '폭풍메기', rarity: 'epic', weight: 12,
    sizeMin: 55, sizeMax: 110, strength: 1.15, time: 'any', weather: ['rain', 'storm'],
    note: '비와 천둥이 몰아칠 때 바닥에서 깨어난다'
  },
  {
    id: 'ghost', name: '유령은어', rarity: 'legendary', weight: 4,
    sizeMin: 30, sizeMax: 60, strength: 1.35, time: [[0.86, 0.18]], weather: ['clear'],
    note: '달이 밝고 잔잔한 한밤중에만 눈에 닿는다'
  }
];

export const RARITY = {
  common:    { label: '흔함',   score: 10,  color: '#cfe3f2' },
  uncommon:  { label: '보통',   score: 25,  color: '#8fe0a8' },
  rare:      { label: '희귀',   score: 60,  color: '#7fb8ff' },
  epic:      { label: '영웅',   score: 150, color: '#c99bff' },
  legendary: { label: '전설',   score: 400, color: '#ffd166' }
};

// Time-of-day windows are circular; a window like [0.86, 0.18] wraps midnight.
export function inTimeWindow(t, win) {
  if (!win || win === 'any') return true;
  const w = wrapTime(t);
  for (const [a, b] of win) {
    const lo = wrapTime(a);
    const hi = wrapTime(b);
    if (lo <= hi ? w >= lo && w <= hi : w >= lo || w <= hi) return true;
  }
  return false;
}

export function speciesWeight(sp, tod, weatherState) {
  let k = 1;
  k *= inTimeWindow(tod, sp.time) ? 3 : 0.12;
  k *= sp.weather === 'any' || sp.weather.includes(weatherState) ? 3 : 0.12;
  return sp.weight * k;
}

// How good the current conditions are: the summed base weight of species that
// are FULLY active (time AND weather matched) over the whole dex. Drives how
// long the player waits for a bite. Roughly 0.45..0.78 across real conditions.
const TOTAL_WEIGHT = SPECIES.reduce((s, sp) => s + sp.weight, 0);

export function biteLuck(tod, weatherState) {
  let active = 0;
  for (const sp of SPECIES) {
    const tOk = inTimeWindow(tod, sp.time);
    const wOk = sp.weather === 'any' || sp.weather.includes(weatherState);
    if (tOk && wOk) active += sp.weight;
  }
  return clamp01((active / TOTAL_WEIGHT) * 1.15);
}

const BITE_WINDOW = 1.15; // seconds to hook after the float goes down
const CAST_FLIGHT = 0.55; // seconds of bobber arc

export class FishingSim {
  constructor(rng) {
    this.rng = rng;
    this.phase = 'idle';
    this.events = []; // drained by the world each frame

    this.power = 0; // charging gauge 0..1
    this.castT = 0; // casting flight progress 0..1
    this.bobber = { x: 0, z: 0, dip: 0 }; // world position + visual dip amount
    this.tension = 0; // reeling minigame 0..1 (>=1 snaps)
    this.progress = 0; // reeling minigame 0..1 (>=1 lands the fish)

    this.pressTime = -1; // wall-clock-ish accumulation for tap detection
    this.heldTime = 0;
    this.holding = false;

    this.lastCatch = null;
    this.stats = { catches: 0, bestScore: 0, escaped: 0 };
    this.dex = {}; // id -> { count, best }

    this._biteTimer = 0;
    this._nibbles = [];
    this._biteTimerMax = 1;
    this._fish = null; // { species, size01, pull } while fighting
  }

  // ------------------------------------------------------------ input ----
  press(now) {
    switch (this.phase) {
      case 'idle':
        this.phase = 'charging';
        this.power = 0;
        break;
      case 'bite':
        this._hook();
        break;
      case 'result':
        this._collect();
        break;
      case 'reeling':
        this.holding = true;
        break;
      case 'waiting':
        this.pressTime = now;
        break;
      default:
        break;
    }
  }

  release(now) {
    switch (this.phase) {
      case 'charging': {
        const power = Math.max(0.15, this.power);
        this.phase = 'casting';
        this.castT = 0;
        this._pendingPower = power;
        break;
      }
      case 'reeling':
        this.holding = false;
        break;
      case 'waiting':
        // Quick tap while waiting reels the line back in.
        if (this.pressTime >= 0 && now - this.pressTime < 0.3) this.recall();
        this.pressTime = -1;
        break;
      default:
        break;
    }
  }

  recall() {
    if (this.phase !== 'waiting' && this.phase !== 'bite') return;
    this.events.push({ type: 'recall', x: this.bobber.x, z: this.bobber.z });
    this._toIdle();
  }

  _toIdle() {
    this.phase = 'idle';
    this.power = 0;
    this.tension = 0;
    this.progress = 0;
    this.holding = false;
    this.pressTime = -1;
    this._fish = null;
    this.bobber.dip = 0;
  }

  // ----------------------------------------------------------- update ----
  update(dt, env) {
    // env: { time, tod, weatherState, calmness, wind, boatX, boatZ, boatHeading, isWater }
    dt = Math.min(dt, 0.1);
    this._lastEnv = env;

    switch (this.phase) {
      case 'charging':
        this.power = clamp01(this.power + dt / 1.15);
        break;

      case 'casting': {
        this.castT += dt / CAST_FLIGHT;
        const d = lerp(5, 13, this._pendingPower);
        const fx = Math.cos(env.boatHeading);
        const fz = Math.sin(env.boatHeading);
        // Walk the landing point inward until it sits over water.
        let dist = d;
        if (env.isWater) {
          for (let i = 0; i < 8; i++) {
            const x = env.boatX + fx * dist;
            const z = env.boatZ + fz * dist;
            if (env.isWater(x, z)) break;
            dist *= 0.72;
          }
        }
        this._castFrom = { x: env.boatX + fx * 1.6, z: env.boatZ + fz * 1.6 };
        this._castTo = { x: env.boatX + fx * dist, z: env.boatZ + fz * dist };
        if (this.castT >= 1) {
          this.bobber.x = this._castTo.x;
          this.bobber.z = this._castTo.z;
          this._land();
        }
        break;
      }

      case 'waiting': {
        this._biteTimer -= dt;
        // Fake nibbles keep the player honest before the real bite.
        while (this._nibbles.length && this._biteTimer <= this._nibbles[0] * this._biteTimerMax) {
          this._nibbles.shift();
          this.events.push({ type: 'nibble', x: this.bobber.x, z: this.bobber.z });
        }
        // Dip envelope: soft pulses during waiting, hard when close to biting.
        const nearBite = this._biteTimer < BITE_WINDOW * 1.5;
        const pulse = Math.sin(env.time * (nearBite ? 11 : 4.2));
        this.bobber.dip = nearBite ? Math.max(0, pulse) * 0.55 : Math.max(0, pulse) * 0.16;
        if (this._biteTimer <= 0) this._startBite();
        break;
      }

      case 'bite': {
        this._biteWindow -= dt;
        this.bobber.dip = 0.6 + 0.4 * Math.abs(Math.sin(env.time * 17));
        if (this._biteWindow <= 0) {
          this.events.push({ type: 'missed', x: this.bobber.x, z: this.bobber.z });
          this._scheduleBites(env);
          this.phase = 'waiting';
          this.bobber.dip = 0;
        }
        break;
      }

      case 'reeling': {
        const pull = this._fish.pull;
        if (this.holding) {
          this.tension += dt * pull * 1.15;
          this.progress += dt * Math.max(0.08, 0.34 - pull * 0.13);
        } else {
          this.tension -= dt * 0.85;
          this.progress -= dt * 0.05; // the fish takes line back slowly
        }
        this.tension = clamp01(this.tension);
        this.progress = clamp01(this.progress);
        // Fish drags the bobber sideways while fighting.
        const drag = Math.sin(env.time * 2.3 + pull * 9) * 0.35 * pull * dt;
        const bx = this.bobber.x - env.boatX;
        const bz = this.bobber.z - env.boatZ;
        const bl = Math.hypot(bx, bz) || 1;
        this.bobber.x += (-bz / bl) * drag;
        this.bobber.z += (bx / bl) * drag;
        // Bobber closes in as the fight is won.
        const wantR = lerp(2.2, bl, this.progress);
        const shrink = lerp(bl, wantR, Math.min(1, dt * 0.5));
        if (bl > 0.001) {
          this.bobber.x = env.boatX + (bx / bl) * shrink;
          this.bobber.z = env.boatZ + (bz / bl) * shrink;
        }
        this.bobber.dip = this.holding ? 0.25 : 0.05;

        if (this.progress >= 1) this._landFish();
        else if (this.tension >= 1) this._snapLine();
        break;
      }

      default:
        break;
    }
  }

  // ---------------------------------------------------------- private ----
  _land() {
    this.phase = 'waiting';
    this.events.push({ type: 'splash', x: this.bobber.x, z: this.bobber.z, big: false });
    this._scheduleBites(this._lastEnv);
  }

  _scheduleBites(env) {
    const luck = biteLuck(env.tod, env.weatherState);
    this._biteTimerMax = lerp(20, 7, luck) * this.rng.float(0.7, 1.35);
    this._biteTimer = this._biteTimerMax;
    const count = this.rng.int(0, 3); // 0..2 fake nibbles first
    this._nibbles = [];
    for (let i = 0; i < count; i++) {
      this._nibbles.push(this.rng.float(0.3, 0.95));
    }
    this._nibbles.sort((a, b) => b - a); // soonest last so shift() pops it first
  }

  _startBite() {
    this.phase = 'bite';
    this._biteWindow = BITE_WINDOW;
    this.events.push({ type: 'splash', x: this.bobber.x, z: this.bobber.z, big: true });
    this.events.push({ type: 'bite', x: this.bobber.x, z: this.bobber.z });
  }

  _hook() {
    const env = this._lastEnv;
    const pool = [];
    for (const sp of SPECIES) {
      const w = speciesWeight(sp, env.tod, env.weatherState);
      if (w > 0) pool.push([sp, w]);
    }
    let sum = 0;
    for (const [, w] of pool) sum += w;
    let roll = this.rng.float(0, sum);
    let picked = pool[0][0];
    for (const [sp, w] of pool) {
      roll -= w;
      if (roll <= 0) {
        picked = sp;
        break;
      }
    }
    // Size biased toward the small end; big ones are genuinely rare.
    const size01 = Math.pow(this.rng.float(), 1.7);
    this._fish = {
      species: picked,
      size01,
      sizeCm: Math.round(lerp(picked.sizeMin, picked.sizeMax, size01)),
      pull: picked.strength * (0.75 + size01 * 0.5)
    };
    this.phase = 'reeling';
    this.tension = 0.25;
    this.progress = 0.04;
    this.holding = false;
    this.events.push({ type: 'hooked', x: this.bobber.x, z: this.bobber.z });
  }

  _finishFight() {
    const f = this._fish;
    const r = RARITY[f.species.rarity];
    const score = Math.round(r.score * (0.6 + f.size01 * 0.8));
    return { ...f, rarityLabel: r.label, score };
  }

  _landFish() {
    const c = this._finishFight();
    this.lastCatch = c;
    this.stats.catches += 1;
    this.stats.bestScore = Math.max(this.stats.bestScore, c.score);
    const d = this.dex[c.species.id] || (this.dex[c.species.id] = { count: 0, best: 0 });
    d.count += 1;
    d.best = Math.max(d.best, c.sizeCm);
    this.events.push({ type: 'caught', catch: c, x: this.bobber.x, z: this.bobber.z });
    this.phase = 'result';
    this.tension = 0;
    this._fish = null;
  }

  _snapLine() {
    const f = this._fish;
    this.stats.escaped += 1;
    this.events.push({
      type: 'escaped',
      reason: 'snap',
      name: f.species.name,
      rarity: f.species.rarity,
      x: this.bobber.x,
      z: this.bobber.z
    });
    this.events.push({ type: 'splash', x: this.bobber.x, z: this.bobber.z, big: true });
    this._toIdle();
  }

  _collect() {
    this.events.push({ type: 'collected' });
    this._toIdle();
  }

  // ------------------------------------------------------------- read ----
  takeEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }

  snapshot() {
    return {
      phase: this.phase,
      power: this.power,
      castT: this.castT,
      castFrom: this._castFrom || null,
      castTo: this._castTo || null,
      bobber: { ...this.bobber },
      tension: this.tension,
      progress: this.progress,
      holding: this.holding,
      fishName: this._fish ? this._fish.species.name : null,
      lastCatch: this.lastCatch,
      stats: { ...this.stats },
      dex: this.dex
    };
  }
}

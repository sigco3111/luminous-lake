// Delegate agent + per-species learning log — pure module.
//
// DelegateAgent reads the FishingSim's plain state and decides inputs that a
// player would otherwise make (when to cast, which bait, how hard to charge,
// when to hook a bite, when to hold the reel). It is "auto-angler" mode — the
// player turns it on and watches; the agent handles the rest deterministically.
//
// DelegateLog records HOW each catch was made (bait, cast power, hook delay,
// max tension observed, success/escape). The UI surfaces the most recent
// recipe per species in the dex as a "learned tip", so manually fishing later
// benefits from the agent's discoveries.

import { clamp01 } from './controls.js';
import {
  SPECIES,
  speciesWeight,
  speciesTimeOk,
  speciesWeatherOk,
  BAITS
} from './fishing.js';

const BITE_WINDOW_DEFAULT = 1.15; // mirrors FishingSim
const RARITY_BONUS = { common: 1, uncommon: 1.5, rare: 2.5, epic: 4, legendary: 6 };
// Bait switch threshold — difference between preferred bait and worm baseline
// summed over reachable species (rarity-weighted). Above this, the bait is
// worth switching to.
const BAIT_SWITCH_THRESHOLD = 30;

function powerForDistance(distance) {
  switch (distance) {
    case 'near': return 0.32;
    case 'mid':  return 0.62;
    case 'far':  return 0.92;
    default:     return 0.55;
  }
}

export class DelegateAgent {
  constructor(rng, fishingSim, opts = {}) {
    this.rng = rng;
    this.sim = fishingSim;
    this._target = null;
    this.chooseBait = opts.chooseBait !== false;
    this.autoCollect = opts.autoCollect !== false;
    this.chargeJitter = 0.06;
  }

  // Highest-weight species reachable with the current bait.
  pickTarget(env) {
    const bait = this.sim.bait;
    let best = null;
    let bestW = -1;
    for (const sp of SPECIES) {
      const w = speciesWeight(sp, env.tod, env.weatherState, bait);
      if (w > bestW) {
        bestW = w;
        best = sp;
      }
    }
    return best;
  }

  pickBait(env) {
    const tod = env.tod;
    const wx = env.weatherState;
    let best = 'worm';
    let bestBonus = 0;
    for (const bait of ['berry', 'beet']) {
      let bonus = 0;
      for (const sp of SPECIES) {
        if (sp.bait !== bait) continue;
        if (!speciesTimeOk(sp, tod) || !speciesWeatherOk(sp, wx)) continue;
        const diff =
          speciesWeight(sp, tod, wx, bait) -
          speciesWeight(sp, tod, wx, 'worm');
        bonus += diff * RARITY_BONUS[sp.rarity];
      }
      if (bonus > bestBonus) {
        bestBonus = bonus;
        best = bait;
      }
    }
    return bestBonus > BAIT_SWITCH_THRESHOLD ? best : 'worm';
  }

  planPower(env) {
    if (!this._target) this._target = this.pickTarget(env);
    const base = powerForDistance(this._target.profile.distance);
    const jitter = this.rng.float(-this.chargeJitter, this.chargeJitter);
    return clamp01(base + jitter);
  }

  planBait(env) {
    if (!this.chooseBait) return this.sim.bait;
    return this.pickBait(env);
  }

  planHookDelayMs(env) {
    if (!this._target) this._target = this.pickTarget(env);
    return Math.max(0.18, this._target.profile.hookDelay * 0.92) * 1000;
  }

  planHold(/* env */) {
    if (!this.sim._fish) return false;
    const threshold = this.sim._fish.holdThreshold;
    const eff = threshold - 0.05;
    return this.sim.tension < eff;
  }

  // Returns a string describing what was decided (UI / debug only).
  tick(env) {
    const sim = this.sim;
    const now = env.time;
    const out = { phase: sim.phase, actions: [] };

    switch (sim.phase) {
      case 'idle': {
        this._target = this.pickTarget(env);
        const bait = this.planBait(env);
        if (bait !== sim.bait) {
          sim.setBait(bait);
          out.actions.push(`bait:${bait}`);
        }
        sim.press(now);
        this._lastCastPower = 0;
        out.actions.push('press');
        break;
      }

      case 'charging': {
        const target = this.planPower(env);
        if (sim.power >= target) {
          this._lastCastPower = sim.power;
          sim.release(now);
          out.actions.push(`release@${sim.power.toFixed(2)}`);
        } else {
          out.actions.push(`charge:${(sim.power * 100).toFixed(0)}%`);
        }
        break;
      }

      case 'casting':
      case 'waiting':
        break;

      case 'bite': {
        // sim._biteWindow counts down from BITE_WINDOW_DEFAULT. Elapsed = max - current.
        const elapsed = Math.max(0, BITE_WINDOW_DEFAULT - (sim._biteWindow || BITE_WINDOW_DEFAULT));
        const hookAt = this.planHookDelayMs(env) / 1000;
        if (elapsed >= hookAt) {
          sim.press(now);
          out.actions.push('hook');
          this._reelLog = { peak: sim.tension };
        }
        break;
      }

      case 'reeling': {
        const hold = this.planHold(env);
        sim.holding = hold;
        out.actions.push(hold ? 'hold' : 'release');
        if (!this._reelLog) this._reelLog = { peak: sim.tension };
        this._reelLog.peak = Math.max(this._reelLog.peak, sim.tension);
        break;
      }

      case 'result':
        if (this.autoCollect) {
          sim.press(now);
          out.actions.push('collect');
        }
        break;
    }
    return out;
  }

  describeFight() {
    const f = this.sim._fish;
    const last = this.sim.lastCatch;
    return {
      species: f ? f.species : last ? last.species : null,
      bait: this.sim.bait,
      castPower: this._lastCastPower || 0,
      hookDelayMs: f ? f.hookDelay * 1000 : null,
      peakTension: this._reelLog ? this._reelLog.peak : 0,
      success: Boolean(last),
      sizeCm: last ? last.sizeCm : null
    };
  }

  resetFightLog() {
    this._reelLog = null;
  }
}

// ----------------------------------------------------------- delegate log ----
// A tiny per-species memory of "how the agent caught it" so the dex can
// surface a tip to manual players.

export class DelegateLog {
  constructor() {
    this.entries = {}; // id -> [{ bait, castPower, hookDelayMs, peakTension, success, sizeCm, ts }]
  }

  record(rec) {
    if (!rec || !rec.species) return;
    const id = rec.species.id;
    const list = this.entries[id] || (this.entries[id] = []);
    list.push({ ...rec, ts: Date.now() });
    if (list.length > 6) list.shift();
  }

  tip(id) {
    const list = this.entries[id];
    if (!list || list.length === 0) return null;
    const success = list.filter((e) => e.success);
    const ref = success.length ? success[success.length - 1] : list[list.length - 1];
    const bait = BAITS[ref.bait];
    return {
      bait: ref.bait,
      baitLabel: bait ? bait.label : ref.bait,
      castPower: ref.castPower,
      hookDelayMs: ref.hookDelayMs,
      peakTension: ref.peakTension,
      sizeCm: ref.sizeCm,
      attempts: list.length,
      successes: success.length
    };
  }

  snapshot() {
    const out = {};
    for (const id of Object.keys(this.entries)) out[id] = this.entries[id].slice();
    return out;
  }

  // Bulk-load from a previously snapshotted form. Used when restoring a
  // saved game so the tip text is immediately accurate.
  replaceFromSnapshot(snap) {
    this.entries = {};
    if (!snap || typeof snap !== 'object') return;
    for (const [id, list] of Object.entries(snap)) {
      if (!Array.isArray(list)) continue;
      this.entries[id] = list.slice(-6).map((e) => ({ ...e }));
    }
  }

  clear() {
    this.entries = {};
  }
}

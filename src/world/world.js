// World orchestrator — owns the scene graph, simulation state, quality
// scaling, and the per-frame update pipeline.
import * as THREE from 'three';
import { Rng } from '../sim/rng.js';
import { clamp01 } from '../sim/controls.js';
import { TimeCycle, fireflyVisibility, dawnFactor, nightFactor } from '../sim/timecycle.js';
import { WeatherMachine } from '../sim/weather.js';
import { QualityScaler, FpsMeter } from '../sim/quality.js';
import { FishingSim } from '../sim/fishing.js';
import { DelegateAgent, DelegateLog } from '../sim/delegate.js';
import { createTerrain } from './terrain.js';
import { createWater } from './water.js';
import { createForest } from './forest.js';
import { createSky } from './sky.js';
import { createRain, createMist } from './weatherView.js';
import { createAnimalsView } from './animalsView.js';
import { createFishingBoat } from './boat.js';
import { createFishingView } from './fishingView.js';
import { CameraDirector } from './cameras.js';
import { loadFrom, saveTo, clearStorage, emptySave, defaultStorage } from '../sim/storage.js';

export function createWorld({ renderer, isMobile = false, storage = null } = {}) {
  // Persistent storage for the dex + delegate log. A null/undefined storage
  // is treated as "no persistence" — saving becomes a no-op and we always
  // start with an empty dex. The browser entrypoint hands in defaultStorage()
  // which auto-falls-back to an in-memory shim in private-mode browsers.
  const storageBackend = storage || (typeof window === 'undefined' ? null : defaultStorage());

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 900);
  // Azimuth chosen so the low night moon sits inside the default orbit frame.
  camera.position.set(16, 14, 60);
  camera.lookAt(0, 1, 0);

  const rng = new Rng(4242);

  // --- subsystems ---
  const terrain = createTerrain();
  scene.add(terrain.mesh);

  const water = createWater({ isMobile });
  scene.add(water.mesh);
  scene.add(water.cubeCamera);

  const forest = createForest({ heightAt: terrain.heightAt });
  scene.add(forest.group);

  const sky = createSky({});
  scene.add(sky.group);
  scene.environment = sky.envTexture;
  scene.fog = sky.fog;

  const rain = createRain({});
  scene.add(rain.points);
  const mist = createMist({});
  scene.add(mist.group);

  const animals = createAnimalsView({ heightAt: terrain.heightAt });
  scene.add(animals.group);

  const boat = createFishingBoat();
  scene.add(boat.group);

  // Fishing game: pure sim + view, wired through the world update loop.
  const fishing = new FishingSim(new Rng(777));
  const delegateAgent = new DelegateAgent(new Rng(8800), fishing, { autoCollect: true });
  const delegateLog = new DelegateLog();
  const fishingView = createFishingView({ boat });
  scene.add(fishingView.group);

  // Apply any persisted save. Stats and the delegate log are restored
  // wholesale; the dex is merged in by setting each species entry directly.
  const initialSave = loadFrom(storageBackend);
  fishing.stats.catches = initialSave.stats.catches;
  fishing.stats.escaped = initialSave.stats.escaped;
  fishing.stats.bestScore = initialSave.stats.bestScore;
  fishing.dex = JSON.parse(JSON.stringify(initialSave.dex));
  fishing.setBait(initialSave.bait);
  delegateLog.replaceFromSnapshot(initialSave.log);

  // Mist banks, cloud sprites, the moon's additive halo, and firefly points
  // all smear soft blobs/streaks across the cube-map reflection (worst at
  // night) — exclude them from the cube camera. The moon DISC stays in, so
  // the water keeps a crisp moonlight streak.
  water.hiddenFromReflection = [mist.group, sky.cloudGroup, sky.moonHalo, sky.stars, animals.fireflyPoints];

  // --- simulation state ---
  const cycle = new TimeCycle(0.36);
  const weather = new WeatherMachine(rng);
  const state = {
    wind: 0.45,
    wildlife: 0.65,
    calmness: 0.55,
    mist: 0.35
  };

  // --- quality ---
  const scaler = new QualityScaler({ startTier: isMobile ? 1 : 0 });
  const fps = new FpsMeter(1.2);
  let pixelRatio = 1;

  function applyTier() {
    const t = scaler.tier;
    water.refreshInterval = t.cubeInterval;
    water.normalEvery = t.normalMapEvery ?? t.normalEvery ?? 1;
    sky.sunLight.castShadow = t.shadows && !isMobile;
    return t;
  }

  // --- cameras ---
  const director = new CameraDirector(camera, renderer.domElement);

  // --- lighting/shadows ---
  renderer.shadowMap.enabled = !isMobile;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  applyTier();

  let worldTime = 0;
  let forceSkyRefresh = true;

  const api = {
    scene,
    camera,
    director,
    terrain,
    weather,
    water,
    sky,
    boat,

    // ---- setters (wired to UI + debug handle) ----
    setTimeOfDay(v) {
      cycle.set(clamp01(v));
      cycle.auto = false;
      forceSkyRefresh = true;
    },
    setWeather(v) {
      weather.setSlider(v);
    },
    setWind(v) {
      state.wind = clamp01(v);
    },
    setWildlife(v) {
      state.wildlife = clamp01(v);
    },
    setCalmness(v) {
      state.calmness = clamp01(v);
    },
    setMist(v) {
      state.mist = clamp01(v);
    },
    setCameraMode(mode) {
      director.setMode(mode);
    },

    // ---- fishing game ----
    // press/release drive every phase: charge+cast, hook on bite, reel hold,
    // collect on result. `now` is seconds for tap-vs-hold detection.
    fishingPress(now) {
      if (api._delegateMode) return; // delegate owns inputs in this mode
      fishing.press(now);
    },
    fishingRelease(now) {
      if (api._delegateMode) return;
      fishing.release(now);
    },
    getFishingSnapshot() {
      return fishing.snapshot();
    },
    fishingSim: fishing, // debug/e2e handle
    _delegateAgent: delegateAgent, // debug/e2e handle
    _delegateLog: delegateLog, // debug/e2e handle
    setDelegateMode(on) {
      api._delegateMode = !!on;
    },
    getDelegateLog() {
      return delegateLog.snapshot();
    },
    getDelegateTip(speciesId) {
      return delegateLog.tip(speciesId);
    },

    // ---- persistence ----
    // Persist immediately. Returns true on a successful write. Cheap enough
    // to call from a UI button or after each catch; for batch callers we also
    // expose last-saved metadata.
    saveProgress() {
      return persistNow();
    },
    getSaveInfo() {
      return {
        savedAt: api._lastSavedAt || 0,
        catches: fishing.stats.catches,
        knownSpecies: Object.keys(fishing.dex).length
      };
    },
    // Wipe the persistent save and reset the in-memory sim state to a fresh
    // run. The next frame's UI sees an empty dex + zero stats.
    resetProgress() {
      clearStorage(storageBackend);
      fishing.stats.catches = 0;
      fishing.stats.escaped = 0;
      fishing.stats.bestScore = 0;
      fishing.dex = {};
      delegateLog.clear();
      api._lastSavedAt = 0;
    },

    getState() {
      return {
        timeOfDay: cycle.t,
        weather: weather.slider,
        weatherState: weather.state,
        wind: state.wind,
        wildlife: state.wildlife,
        calmness: state.calmness,
        mist: state.mist,
        cameraMode: director.mode,
        qualityTier: scaler.tierName,
        fps: Math.round(fps.avg),
        rainCount: rain.activeCount,
        treeCount: forest.count,
        boat: { x: boat.group.position.x, z: boat.group.position.z },
        fishing: { phase: fishing.phase, catches: fishing.stats.catches },
        pixelRatio
      };
    },

    update(dt) {
      worldTime += dt;
      cycle.update(dt);
      weather.update(dt);

      const tod = cycle.t;
      const tier = scaler.tier;

      sky.setFlash(weather.lightningFlash);
      sky.update(tod, weather.cloudCover, weather.darkness, dt, state.wind, forceSkyRefresh);
      forceSkyRefresh = false;

      water.setCalmLook(state.calmness);
      water.setNightLook(nightFactor(tod));
      water.update(worldTime, state.calmness, state.wind);
      water.updateReflection(renderer, scene);

      forest.setWind(state.wind);
      forest.update(worldTime);

      boat.update(dt, worldTime, state.calmness, state.wind);

      // Fishing sim: conditions + boat pose in, plain events out.
      if (!api._freezeFishing) {
        const fishEnv = {
          time: worldTime,
          tod,
          weatherState: weather.state,
          calmness: state.calmness,
          wind: state.wind,
          boatX: boat.group.position.x,
          boatZ: boat.group.position.z,
          boatHeading: boat.heading,
          isWater: (x, z) => terrain.heightAt(x, z) < -0.25
        };
        if (api._delegateMode) {
          // Agent drives the inputs each frame; sim still ticks normally.
          delegateAgent.tick(fishEnv);
        }
        fishing.update(dt, fishEnv);
      }
      const fishEvents = fishing.takeEvents();
      let dirty = false;
      for (const evt of fishEvents) {
        if (evt.type === 'splash') animals.spawnSplash(evt.x, evt.z, evt.big);
        if (evt.type === 'caught' || evt.type === 'escaped') {
          // Record into the delegate log so the dex can surface learned tips.
          delegateLog.record(delegateAgent.describeFight());
          delegateAgent.resetFightLog();
          dirty = true;
          if (api.onFishingEvent) api.onFishingEvent(evt);
        }
      }
      if (dirty) persistNow();
      if (!api._freezeFishing) fishingView.update(fishing.snapshot(), worldTime, state.calmness, state.wind);

      const mistLevel = clamp01(
        state.mist * (0.45 + dawnFactor(tod) * 0.9) * (1 - nightFactor(tod) * 0.7) +
          weather.rainIntensity * 0.1
      );
      animals.update(dt, worldTime, {
        density: state.wildlife,
        calmness: state.calmness,
        wind: state.wind,
        fireflyVis: fireflyVisibility(tod) * (1 - weather.cloudCover * 0.35),
        fireflyCap: tier.fireflyMax
      });

      rain.update(dt, weather.rainIntensity, state.wind, tier.rainMax);
      mist.update(dt, worldTime, mistLevel, camera.position);

      director.update(dt, worldTime);

      // Adaptive quality
      const avg = fps.sample(dt);
      const action = scaler.update(dt, avg);
      if (action) applyTier();
      const targetPR = Math.min(globalThis.devicePixelRatio || 1, scaler.tier.pixelRatioCap);
      if (Math.abs(targetPR - pixelRatio) > 0.01) {
        pixelRatio = targetPR;
        renderer.setPixelRatio(pixelRatio);
      }

      renderer.render(scene, camera);
    },

    resize(width, height) {
      camera.aspect = width / height;
      // Portrait: widen the view so the lake keeps a visible band.
      const portrait = camera.aspect < 0.8;
      camera.fov = portrait ? 72 : 55;
      camera.updateProjectionMatrix();
      director.setPortrait(portrait);
      renderer.setSize(width, height, false);
    }
  };

  // Persist the current dex + delegate log + stats to the storage backend.
  // Cheap enough to call after every fight — the data is a couple of KB.
  function persistNow() {
    if (!storageBackend) return false;
    const save = emptySave();
    save.dex = JSON.parse(JSON.stringify(fishing.dex || {}));
    save.log = delegateLog.snapshot();
    save.stats = {
      catches: fishing.stats.catches,
      escaped: fishing.stats.escaped,
      bestScore: fishing.stats.bestScore
    };
    save.bait = fishing.bait;
    save.savedAt = Date.now();
    const ok = saveTo(storageBackend, save);
    if (ok) api._lastSavedAt = save.savedAt;
    return ok;
  }

  director.onUserExit(() => {
    api.setCameraMode('orbit');
    if (api.onCameraExit) api.onCameraExit();
  });

  return api;
}

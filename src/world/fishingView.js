// Fishing view layer — bobber, fishing line curve, and rod bending.
// Reads plain data from the FishingSim snapshot; owns no game logic.
import * as THREE from 'three';
import { waveHeight } from '../sim/waves.js';
import { lerp } from '../sim/controls.js';

const LINE_POINTS = 14;

export function createFishingView({ boat }) {
  const group = new THREE.Group();
  group.name = 'fishing';

  // ------------------------------------------------------------ bobber ---
  const bobber = new THREE.Group();
  const redMat = new THREE.MeshStandardMaterial({
    color: 0xe04838, roughness: 0.35, metalness: 0.05,
    emissive: 0x581008, emissiveIntensity: 0.55
  });
  const whiteMat = new THREE.MeshStandardMaterial({ color: 0xf4f7f5, roughness: 0.4 });
  const top = new THREE.Mesh(
    new THREE.SphereGeometry(0.085, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), redMat
  );
  const bottom = new THREE.Mesh(
    new THREE.SphereGeometry(0.085, 10, 6, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), whiteMat
  );
  const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.22, 5), whiteMat);
  antenna.position.y = 0.17;
  const antennaTip = new THREE.Mesh(new THREE.SphereGeometry(0.02, 6, 5), redMat);
  antennaTip.position.y = 0.29;
  bobber.add(top, bottom, antenna, antennaTip);
  bobber.visible = false;
  group.add(bobber);

  // ------------------------------------------------------- fishing line ---
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(LINE_POINTS * 3), 3));
  const line = new THREE.Line(
    lineGeo,
    new THREE.LineBasicMaterial({ color: 0xdfeef5, transparent: true, opacity: 0.55 })
  );
  line.frustumCulled = false;
  line.visible = false;
  group.add(line);

  // Reusable scratch vectors (single render thread — safe module-level).
  const tipWorld = new THREE.Vector3();

  let visibleLine = false;

  function updateLine(fromX, fromY, fromZ, toX, toY, toZ, sag) {
    const posAttr = line.geometry.attributes.position;
    for (let i = 0; i < LINE_POINTS; i++) {
      const t = i / (LINE_POINTS - 1);
      // Quadratic bezier through a drooping midpoint for honest slack.
      const mx = (fromX + toX) / 2;
      const my = (fromY + toY) / 2 - sag;
      const mz = (fromZ + toZ) / 2;
      const it = 1 - t;
      posAttr.setXYZ(
        i,
        it * it * fromX + 2 * it * t * mx + t * t * toX,
        it * it * fromY + 2 * it * t * my + t * t * toY,
        it * it * fromZ + 2 * it * t * mz + t * t * toZ
      );
    }
    posAttr.needsUpdate = true;
    line.visible = visibleLine;
  }

  return {
    group,

    update(snap, time, calmness, wind) {
      const phase = snap.phase;

      // Rod bend: forward flick while casting, strained dip while reeling.
      let bend = 0;
      if (phase === 'casting') {
        const k = Math.sin(Math.min(1, snap.castT) * Math.PI);
        bend = -k * 0.85;
      } else if (phase === 'reeling') {
        bend = 0.25 + snap.tension * 1.15 + Math.sin(time * 9) * snap.tension * 0.12;
      } else if (phase === 'waiting' || phase === 'bite') {
        bend = 0.06 + snap.bobber.dip * 0.5;
      }
      boat.rodPivot.rotation.z = -0.95 + bend * 0.45;
      boat.rodPivot.rotation.x = 0.15 - Math.abs(bend) * 0.18;

      if (phase === 'idle' || phase === 'charging' || phase === 'result') {
        visibleLine = false;
        bobber.visible = false;
        line.visible = false;
        return;
      }

      boat.rodTip.getWorldPosition(tipWorld);

      // Bobber position: arc during flight, wave-riding afterwards.
      if (phase === 'casting' && snap.castFrom && snap.castTo) {
        const t = Math.min(1, snap.castT);
        bobber.visible = true;
        visibleLine = true;
        const bx = lerp(snap.castFrom.x, snap.castTo.x, t);
        const bz = lerp(snap.castFrom.z, snap.castTo.z, t);
        const surface = waveHeight(bx, bz, time, calmness, wind);
        const arc = Math.sin(t * Math.PI) * lerp(1.2, 3.2, 0.7);
        bobber.position.set(bx, surface + arc + 0.09, bz);
        updateLine(tipWorld.x, tipWorld.y, tipWorld.z, bx, surface + arc, bz, 0.05);
        return;
      }

      const { x, z } = snap.bobber;
      const surface = waveHeight(x, z, time, calmness, wind);
      bobber.visible = true;
      visibleLine = true;

      const biteJiggle =
        phase === 'bite'
          ? Math.sin(time * 22) * 0.06
          : 0;
      bobber.position.set(
        x + Math.sin(time * 13) * snap.bobber.dip * 0.05,
        surface + 0.09 - snap.bobber.dip * 0.16 + biteJiggle,
        z + Math.cos(time * 11) * snap.bobber.dip * 0.05
      );
      bobber.rotation.z = Math.sin(time * 9) * snap.bobber.dip * 0.35;

      // Slack line drifts with ripples; taut line barely sags.
      const sag = phase === 'reeling' ? 0.03 : 0.28 + snap.bobber.dip * 0.3;
      updateLine(tipWorld.x, tipWorld.y, tipWorld.z, x, surface + 0.12, z, sag);
    }
  };
}

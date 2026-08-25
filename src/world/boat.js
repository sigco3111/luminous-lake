// Small wooden fishing boat — drifts slowly across the lake, rides the same
// wave field as the water mesh and ducks, and leaves a soft foam wake.
import * as THREE from 'three';
import { waveHeight } from '../sim/waves.js';

function wood(color, opts = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.82, metalness: 0.02, ...opts });
}

export function createFishingBoat() {
  const group = new THREE.Group();
  group.name = 'fishing-boat';

  const hullMat = wood(0x6b4a2f);
  const darkMat = wood(0x4a3322);
  const trimMat = wood(0x8a6a45);

  const hull = new THREE.Mesh(new THREE.CapsuleGeometry(0.55, 2.6, 4, 10), hullMat);
  hull.geometry.rotateZ(Math.PI / 2); // length along +x (bow forward)
  hull.scale.set(1, 0.5, 0.74);
  hull.position.y = 0.28;
  group.add(hull);

  const floor = new THREE.Mesh(new THREE.BoxGeometry(2.55, 0.08, 0.78), darkMat);
  floor.position.y = 0.44;
  group.add(floor);

  for (const x of [-0.95, 0.05, 0.95]) {
    const bench = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.09, 0.95), trimMat);
    bench.position.set(x, 0.58, 0);
    group.add(bench);
  }

  for (const z of [-0.58, 0.58]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(3.05, 0.1, 0.12), trimMat);
    rail.position.set(0.05, 0.62, z);
    group.add(rail);
  }

  // Little outboard motor on the stern (-x).
  const motor = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.42, 0.32), wood(0x2e3136, { roughness: 0.55 }));
  motor.position.set(-1.82, 0.52, 0);
  group.add(motor);
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.7, 6), wood(0x3a3f45, { roughness: 0.5 }));
  shaft.position.set(-1.9, 0.1, 0);
  shaft.rotation.z = 0.25;
  group.add(shaft);

  // Fishing rod leaning over the bow. It lives in its own pivot group so the
  // fishing view can bend it during casts and fights; the old decorative
  // line stub is gone — the real fishing line is drawn by the fishing view.
  const rodPivot = new THREE.Group();
  rodPivot.position.set(1.35, 1.05, 0.18);
  rodPivot.rotation.z = -0.95;
  rodPivot.rotation.x = 0.15;
  const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.022, 1.8, 5), darkMat);
  rod.position.y = 0.9; // pivot at the butt end
  rodPivot.add(rod);
  const tipAnchor = new THREE.Object3D();
  tipAnchor.position.y = 1.8; // the rod's tip in pivot space
  rodPivot.add(tipAnchor);
  group.add(rodPivot);

  // Warm lantern so the boat reads at dusk/night.
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.75, 5), darkMat);
  pole.position.set(-0.35, 0.85, -0.3);
  group.add(pole);
  const lantern = new THREE.Mesh(
    new THREE.SphereGeometry(0.11, 8, 6),
    new THREE.MeshStandardMaterial({ color: 0xffd9a0, emissive: 0xff9c3c, emissiveIntensity: 1.4, roughness: 0.4 })
  );
  lantern.position.set(-0.35, 1.25, -0.3);
  group.add(lantern);

  // Soft tapered wake trailing behind the stern (no hard rectangle edges).
  const wakeMat = new THREE.MeshBasicMaterial({
    color: 0xe4f6ff,
    transparent: true,
    opacity: 0.12,
    depthWrite: false,
    side: THREE.DoubleSide
  });
  const wakeShape = new THREE.Shape();
  wakeShape.moveTo(-1.55, 0);
  wakeShape.lineTo(-4.4, 0.95);
  wakeShape.lineTo(-4.4, -0.95);
  wakeShape.closePath();
  const wake = new THREE.Mesh(new THREE.ShapeGeometry(wakeShape), wakeMat);
  wake.geometry.rotateX(-Math.PI / 2);
  wake.position.y = 0.05;
  wake.renderOrder = 3;
  group.add(wake);

  group.traverse((o) => {
    if (o.isMesh && o !== wake) o.castShadow = true;
  });

  let angle = 0.7;

  return {
    group,
    rodPivot,
    rodTip: tipAnchor,
    heading: angle + Math.PI / 2, // updated each frame; bow direction
    update(dt, time, calmness, wind) {
      angle += dt * (0.032 + wind * 0.03);
      const r = 11.5 + Math.sin(time * 0.11) * 1.6;
      const x = Math.cos(angle) * r;
      const z = Math.sin(angle) * r;
      const heading = angle + Math.PI / 2;
      const surface = waveHeight(x, z, time, calmness, wind);

      group.position.set(x, surface * 0.85 + 0.16 + Math.sin(time * 0.8) * 0.025, z);
      group.rotation.y = -heading;
      this.heading = heading;

      // Pitch/roll from the local wave slope so the hull rides swells honestly.
      const e = 1.2;
      const sx = (waveHeight(x + e, z, time, calmness, wind) - waveHeight(x - e, z, time, calmness, wind)) / (2 * e);
      const sz = (waveHeight(x, z + e, time, calmness, wind) - waveHeight(x, z - e, time, calmness, wind)) / (2 * e);
      group.rotation.x = THREE.MathUtils.clamp(sz * 0.5, -0.16, 0.16);
      group.rotation.z = THREE.MathUtils.clamp(-sx * 0.5, -0.16, 0.16);

      const pulse = 0.5 + 0.5 * Math.sin(time * 1.7);
      wake.scale.set(1 + pulse * 0.2 + wind * 0.35, 1, 1 + pulse * 0.12);
      wakeMat.opacity = 0.07 + wind * 0.1 + pulse * 0.04;
    }
  };
}

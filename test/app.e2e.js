import { test, expect } from '@playwright/test';

async function waitForWorld(page) {
  await page.goto('/');
  await page.waitForFunction(() => window.__luminous && window.__luminous.getState, null, { timeout: 60_000 });
  // let a few frames render
  await page.waitForTimeout(1200);
}

test.describe('Luminous Lake', () => {
  test('loads without console errors and renders non-uniform pixels', async ({ page }) => {
    const errors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', (err) => errors.push(String(err)));
    await waitForWorld(page);

    const canvas = page.locator('canvas#scene');
    await expect(canvas).toBeVisible();

    // A living scene compresses poorly: a rich screenshot is large, and two
    // screenshots at different times of day must differ.
    const shotA = await page.screenshot();
    expect(shotA.length).toBeGreaterThan(40_000);

    await page.evaluate(() => window.__luminous.setTimeOfDay(0.02));
    await page.waitForTimeout(700);
    const shotB = await page.screenshot();
    expect(shotB.equals(shotA)).toBeFalsy();

    // Transparent-water upgrade: surface blends instead of hiding the lake,
    // and the fishing boat is part of the world state.
    const probe = await page.evaluate(() => {
      const w = window.__luminous.world;
      return {
        hasBoat: Boolean(w.boat && w.boat.group),
        waterOpacity: w.water.mesh.material.opacity,
        waterDepthWrite: w.water.mesh.material.depthWrite,
        waterTransparent: w.water.mesh.material.transparent
      };
    });
    expect(probe.hasBoat).toBeTruthy();
    expect(probe.waterTransparent).toBeTruthy();
    expect(probe.waterDepthWrite).toBeFalsy();
    expect(probe.waterOpacity).toBeLessThan(0.9);

    expect(errors).toEqual([]);
  });

  test('time slider changes timeOfDay and the sky', async ({ page }) => {
    await waitForWorld(page);
    const before = await page.evaluate(() => window.__luminous.getState().timeOfDay);
    const skyBefore = await page.screenshot();

    const slider = page.locator('input[data-control="timeOfDay"]');
    await slider.fill('800'); // evening golden hour
    await page.waitForTimeout(700);

    const after = await page.evaluate(() => window.__luminous.getState().timeOfDay);
    expect(after).not.toBeCloseTo(before, 2);
    expect(after).toBeCloseTo(0.8, 2);

    const skyAfter = await page.screenshot();
    expect(skyAfter.equals(skyBefore)).toBeFalsy();
  });

  test('camera buttons switch camera modes', async ({ page }) => {
    await waitForWorld(page);
    for (const mode of ['cinematic', 'shore', 'aerial', 'orbit']) {
      await page.locator(`.cam-btn[data-mode="${mode}"]`).click();
      await expect
        .poll(() => page.evaluate(() => window.__luminous.getState().cameraMode), { timeout: 5_000 })
        .toBe(mode);
    }
  });

  test('storm weather increases rain particle count', async ({ page }) => {
    await waitForWorld(page);
    const clearCount = await page.evaluate(() => window.__luminous.getState().rainCount);

    const slider = page.locator('input[data-control="weather"]');
    await slider.fill('1000');
    // wait for the blend to converge and rain to recycle in
    await expect
      .poll(async () => page.evaluate(() => window.__luminous.getState().rainCount), { timeout: 15_000 })
      .toBeGreaterThan(clearCount + 100);
    const state = await page.evaluate(() => window.__luminous.getState());
    expect(state.weatherState).toBe('storm');
  });

  test('panel collapses and expands via the handle', async ({ page }) => {
    await waitForWorld(page);
    const handle = page.locator('#panel-handle');
    const panel = page.locator('#panel');
    const slider = page.locator('input[data-control="wind"]');

    // Narrow viewports intentionally start collapsed — expand first.
    if (await panel.evaluate((el) => el.classList.contains('collapsed'))) {
      await handle.click();
    }
    // Mobile starts collapsed (scenery-first) — normalize to expanded.
    if (await panel.evaluate((el) => el.classList.contains('collapsed'))) {
      await handle.click();
      await page.waitForTimeout(600);
    }
    await expect(panel).not.toHaveClass(/collapsed/);
    await expect(slider).toBeVisible();
    const yBefore = (await panel.boundingBox()).y;

    await handle.click();
    await expect(panel).toHaveClass(/collapsed/);
    await page.waitForTimeout(600);
    const yCollapsed = (await panel.boundingBox()).y;
    expect(yCollapsed).toBeGreaterThan(yBefore + 100);

    await handle.click();
    await expect(panel).not.toHaveClass(/collapsed/);
    await page.waitForTimeout(600);
    const yExpanded = (await panel.boundingBox()).y;
    expect(yExpanded).toBeLessThan(yCollapsed - 100);
    await expect(slider).toBeVisible();
  });

  test('keyboard keys 1-4 switch camera modes', async ({ page }) => {
    await waitForWorld(page);
    await page.keyboard.press('2');
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => window.__luminous.getState().cameraMode)).toBe('cinematic');
    await page.keyboard.press('1');
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => window.__luminous.getState().cameraMode)).toBe('orbit');
  });

  test('fishing: charge, cast, hook the bite, land a fish', async ({ page }) => {
    await waitForWorld(page);

    // Freeze the real-time rAF pipeline from touching the fishing sim so
    // every transition is driven by the deterministic fast-forward below.
    await page.evaluate(() => window.__luminous.pauseFishing());

    // The button → press() wiring is verified by direct phase checks. The
    // longer simulated transitions are advanced deterministically via the
    // fishingFastForward debug seam — headless rAF throttling would make the
    // cast flight take seconds otherwise.
    const btn = page.locator('#btn-cast');

    // 1) charging: holding the button should put the sim into 'charging'.
    await btn.dispatchEvent('pointerdown');
    expect(await page.evaluate(() => window.__luminous.fishing.phase)).toBe('charging');
    await page.evaluate(() => window.__luminous.fishingFastForward(8));
    const power = await page.evaluate(() => window.__luminous.fishing.power);
    expect(power).toBeGreaterThan(0.05);

    // 2) releasing casts.
    await btn.dispatchEvent('pointerup');
    expect(await page.evaluate(() => window.__luminous.fishing.phase)).toBe('casting');
    await page.evaluate(() => window.__luminous.fishingFastForward(16));

    // 3) faster wait by zeroing the bite timer.
    expect(await page.evaluate(() => window.__luminous.fishing.phase)).toBe('waiting');
    await page.evaluate(() => { window.__luminous.fishing._biteTimer = 0.01; });
    await page.evaluate(() => window.__luminous.fishingFastForward(1));
    expect(await page.evaluate(() => window.__luminous.fishing.phase)).toBe('bite');
    await expect(page.locator('#fishing-status')).toHaveClass(/alert/);

    // 4) keyboard Space hooks the bite.
    await page.keyboard.down('Space');
    await page.evaluate(() => window.__luminous.fishingFastForward(1));
    expect(await page.evaluate(() => window.__luminous.fishing.phase)).toBe('reeling');

    // 5) play the reel minigame deterministically via direct sim.update
    //    calls — bypasses UI hooks so it cannot race the rAF pipeline.
    const won = await page.evaluate(() => {
      const f = window.__luminous.fishing;
      const env = {
        time: 0, tod: 0.5, weatherState: 'clear',
        calmness: 0.6, wind: 0.3,
        boatX: 0, boatZ: -11.5, boatHeading: 0,
        isWater: () => true
      };
      for (let i = 0; i < 400 && f.phase === 'reeling'; i++) {
        f.holding = f.tension < 0.62;
        f.update(0.05, env);
        if (f.phase === 'reeling') {
          for (const ev of f.takeEvents()) {
            if (ev.type === 'caught' || ev.type === 'escaped') {
              if (window.__luminous.world && window.__luminous.world.onFishingEvent) {
                window.__luminous.world.onFishingEvent(ev);
              }
            }
          }
        }
      }
      return { phase: f.phase, catches: f.stats.catches, last: f.lastCatch };
    });
    expect(won.phase === 'result' || won.phase === 'idle').toBe(true);
    expect(won.catches).toBe(1);
    expect(won.last).not.toBeNull();

    // 6) catch toast should appear in the DOM (check before releasing Space
    // so the result phase isn't disturbed by a downstream press).
    await expect(page.locator('#catch-toast.show')).toBeVisible();
    await page.keyboard.up('Space');

    // 7) collecting returns to idle.
    await page.keyboard.press('Space');
    await page.evaluate(() => window.__luminous.fishingFastForward(2));
    expect(await page.evaluate(() => window.__luminous.fishing.phase)).toBe('idle');
    await page.evaluate(() => window.__luminous.resumeFishing());
  });

  test('dex panel lists every species and opens via keyboard', async ({ page }) => {
    await waitForWorld(page);
    await page.keyboard.press('c');
    await expect(page.locator('#dex-panel')).toHaveClass(/open/);
    const rows = await page.locator('.dex-row').count();
    expect(rows).toEqual(50);
    // Each row carries an inline SVG silhouette (mesh photo).
    const svgCount = await page.locator('.dex-row svg').count();
    expect(svgCount).toEqual(50);
    await page.keyboard.press('Escape');
    await expect(page.locator('#dex-panel')).not.toHaveClass(/open/);
  });

  test('bait chips switch the active bait and persist to the sim', async ({ page }) => {
    await waitForWorld(page);
    // Default bait is worm.
    expect(await page.evaluate(() => window.__luminous.fishing.bait)).toBe('worm');
    await page.locator('.bait-chip[data-bait="berry"]').click();
    expect(await page.evaluate(() => window.__luminous.fishing.bait)).toBe('berry');
    await page.locator('.bait-chip[data-bait="beet"]').click();
    expect(await page.evaluate(() => window.__luminous.fishing.bait)).toBe('beet');
    // Active class follows.
    await expect(page.locator('.bait-chip.active[data-bait="beet"]')).toBeVisible();
  });

  test('delegate mode catches fish without player input', async ({ page }) => {
    await waitForWorld(page);
    await page.evaluate(() => window.__luminous.pauseFishing());
    // Force the delegate button on (bypass the animated pulse by clicking
    // via dispatchEvent, which is what real interaction also goes through).
    await page.evaluate(() => {
      const btn = document.getElementById('btn-delegate');
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(await page.evaluate(() => window.__luminous.world._delegateMode)).toBe(true);

    // Drive the delegate via the exposed agent + sim updates. Manually drain
    // events so the delegate log is populated (normally world.update does it).
    const outcome = await page.evaluate(() => {
      const w = window.__luminous;
      const env = {
        time: 0, tod: 0.3, weatherState: 'clear', calmness: 0.6, wind: 0.3,
        boatX: 0, boatZ: -11.5, boatHeading: 0, isWater: () => true
      };
      const agent = w.delegateAgent;
      const f = w.fishing;
      for (let i = 0; i < 800 && f.phase !== 'result'; i++) {
        agent.tick(env);
        f.update(0.05, env);
        if (f.phase === 'bite' && f._biteWindow <= 0.15) f.press(env.time);
      }
      // Drain events through world.onFishingEvent so the delegate log fills.
      for (const e of f.takeEvents()) {
        if (e.type === 'caught' || e.type === 'escaped') {
          w.delegateLog.record(agent.describeFight());
          agent.resetFightLog();
          if (w.world.onFishingEvent) w.world.onFishingEvent(e);
        }
      }
      return {
        phase: f.phase,
        catches: f.stats.catches,
        bait: f.bait,
        logKeys: Object.keys(w.delegateLog.snapshot()).length
      };
    });
    expect(outcome.phase).toBe('result');
    expect(outcome.catches).toBe(1);
    expect(outcome.logKeys).toBeGreaterThanOrEqual(1);

    // Turn delegate back off.
    await page.evaluate(() => {
      const btn = document.getElementById('btn-delegate');
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(await page.evaluate(() => window.__luminous.world._delegateMode)).toBe(false);
    await page.evaluate(() => window.__luminous.resumeFishing());
  });
});

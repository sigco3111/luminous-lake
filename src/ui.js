// 직접 만든 글래스모피즘 컨트롤 패널. 프레임워크 없음.
// 식별자(world.setCameraMode / setter / dataset)는 절대 한글화하지 않습니다.
import { CAMERA_MODES } from './world/cameras.js';
import { SPECIES, RARITY, BAITS } from './sim/fishing.js';

// 슬라이더 정의: key / setter 는 식별자(영문 유지), label 은 UI 노출 텍스트(한글화).
const SLIDERS = [
  { key: 'timeOfDay', label: '시간대', setter: 'setTimeOfDay', initial: 0.36 },
  { key: 'weather', label: '날씨', setter: 'setWeather', initial: 0.1 },
  { key: 'wind', label: '바람', setter: 'setWind', initial: 0.35 },
  { key: 'wildlife', label: '야생 생물', setter: 'setWildlife', initial: 0.65 },
  { key: 'calmness', label: '수면 잔잔함', setter: 'setCalmness', initial: 0.62 },
  { key: 'mist', label: '안개', setter: 'setMist', initial: 0.35 }
];

// 카메라 모드 식별자 → 화면에 표시할 한글 라벨
const CAMERA_LABELS = {
  orbit: '궤도',
  cinematic: '시네마틱',
  shore: '해안',
  aerial: '공중'
};

export function createUI(world) {
  const root = document.getElementById('ui');

  // 타이틀
  const title = document.createElement('div');
  title.id = 'title';
  title.innerHTML = '<span class="title-dot"></span>빛나는 호수';
  root.appendChild(title);

  // 라이선스 고지: MIT 라이선스 원본을 그대로 안내합니다.
  const credit = document.createElement('div');
  credit.id = 'oss-credit';
  credit.innerHTML =
    'MIT 라이선스 &middot; Copyright (c) 2026 Bles Software<br>' +
    '<a href="https://github.com/stas4000/luminous-lake" target="_blank" rel="noopener">원본 소스</a> &middot; ' +
    '<a href="/LICENSE" target="_blank" rel="noopener">전체 라이선스 보기</a>';
  root.appendChild(credit);

  const panel = document.createElement('div');
  panel.id = 'panel';

  const handle = document.createElement('button');
  handle.id = 'panel-handle';
  handle.type = 'button';
  handle.setAttribute('aria-label', '컨트롤 패널 열기/닫기');
  handle.innerHTML = '<span class="chev">▾</span> 컨트롤';
  panel.appendChild(handle);

  const body = document.createElement('div');
  body.id = 'panel-body';
  panel.appendChild(body);
  root.appendChild(panel);

  // 카메라 모드 버튼 (4개)
  const camRow = document.createElement('div');
  camRow.id = 'camera-row';
  camRow.setAttribute('role', 'group');
  camRow.setAttribute('aria-label', '카메라 모드');
  const camButtons = {};
  CAMERA_MODES.forEach((mode, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cam-btn';
    b.dataset.mode = mode;
    b.textContent = CAMERA_LABELS[mode];
    b.title = `카메라: ${CAMERA_LABELS[mode]} (단축키 ${i + 1})`;
    b.addEventListener('click', () => setCameraMode(mode));
    camRow.appendChild(b);
    camButtons[mode] = b;
  });
  body.appendChild(camRow);

  // 슬라이더 그리드
  const grid = document.createElement('div');
  grid.id = 'slider-grid';
  body.appendChild(grid);

  const inputs = {};
  for (const s of SLIDERS) {
    const wrap = document.createElement('label');
    wrap.className = 'slider-wrap';
    const name = document.createElement('span');
    name.className = 'slider-label';
    name.textContent = s.label;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = '0';
    input.max = '1000';
    input.value = String(Math.round(s.initial * 1000));
    input.dataset.control = s.key;
    input.setAttribute('aria-label', s.label);
    input.addEventListener('input', () => {
      world[s.setter](Number(input.value) / 1000);
    });
    wrap.appendChild(name);
    wrap.appendChild(input);
    grid.appendChild(wrap);
    inputs[s.key] = input;
  }

  function setCameraMode(mode) {
    world.setCameraMode(mode);
    for (const [m, b] of Object.entries(camButtons)) {
      b.classList.toggle('active', m === mode);
    }
  }
  setCameraMode('orbit');

  // 패널 열기/닫기
  handle.addEventListener('click', () => {
    panel.classList.toggle('collapsed');
    handle.querySelector('.chev').textContent = panel.classList.contains('collapsed') ? '▴' : '▾';
  });

  // 작은 화면에서는 처음에 패널을 접어 풍경 위주로 보여줍니다.
  if (window.innerWidth < 620) {
    panel.classList.add('collapsed');
    handle.querySelector('.chev').textContent = '▴';
  }

  // 더 좁은 화면에서도 동일하게 패널을 접어 시작합니다.
  if (window.innerWidth < 700) {
    panel.classList.add('collapsed');
    handle.querySelector('.chev').textContent = '▴';
  }

  // 키보드 1~4: 카메라 모드 전환
  window.addEventListener('keydown', (e) => {
    const idx = ['1', '2', '3', '4'].indexOf(e.key);
    if (idx >= 0) setCameraMode(CAMERA_MODES[idx]);
  });

  // 스크립트 카메라에서 마우스/터치로 빠져나오면 궤도 카메라 버튼을 다시 활성화합니다.
  world.onCameraExit = () => {
    for (const [m, b] of Object.entries(camButtons)) {
      b.classList.toggle('active', m === 'orbit');
    }
  };

  buildFishingUI(world, root);

  return {
    setCameraMode,
    // 디버그 핸들에서 들어오는 외부 변경을 위젯에 반영합니다.
    sync(key, value) {
      const input = inputs[key];
      if (input) input.value = String(Math.round(value * 1000));
    },
    isCollapsed() {
      return panel.classList.contains('collapsed');
    }
  };
}

// ------------------------------------------------------- fishing HUD -------
// 낚시 게임 오버레이: 상태 라벨, 게이지, 액션 버튼, 어획 토스트, 도감 패널.
function buildFishingUI(world, root) {
  const now = () => performance.now() / 1000;

  // --- HUD (status + gauges) ---
  const hud = document.createElement('div');
  hud.id = 'fishing-hud';

  const status = document.createElement('div');
  status.id = 'fishing-status';
  hud.appendChild(status);

  const bars = document.createElement('div');
  bars.className = 'fish-bars';
  const makeBar = (id, label) => {
    const wrap = document.createElement('div');
    wrap.className = 'fish-bar-wrap';
    wrap.id = `${id}-wrap`;
    const lab = document.createElement('div');
    lab.className = 'fish-bar-label';
    lab.textContent = label;
    const bar = document.createElement('div');
    bar.className = 'fish-bar';
    bar.id = id;
    bar.appendChild(document.createElement('div'));
    wrap.appendChild(lab);
    wrap.appendChild(bar);
    bars.appendChild(wrap);
    return { wrap, fill: bar.firstChild };
  };
  const powerBar = makeBar('bar-power', '캐스팅 파워');
  const tensionBar = makeBar('bar-tension', '줄 장력');
  const progressBar = makeBar('bar-progress', '회수');
  hud.appendChild(bars);
  root.appendChild(hud);

  // --- toast ---
  const toast = document.createElement('div');
  toast.id = 'catch-toast';
  root.appendChild(toast);
  let toastTimer = 0;
  function showToast(html, color) {
    toast.innerHTML = html;
    toast.style.borderColor = color || 'var(--glass-border)';
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 6500);
  }

  // A new catch starts fresh, so dismiss any older toast immediately.
  function closeToast() {
    clearTimeout(toastTimer);
    toast.classList.remove('show');
  }

  // --- action buttons ---
  const actions = document.createElement('div');
  actions.id = 'fishing-actions';

  // Bait chips appear above the action buttons. The active chip is outlined;
  // clicking switches bait immediately.
  const baitRow = document.createElement('div');
  baitRow.id = 'bait-row';
  const baitChips = {};
  for (const id of Object.keys(BAITS)) {
    const b = BAITS[id];
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'bait-chip';
    chip.dataset.bait = id;
    chip.title = `${b.label} — ${b.note}`;
    chip.innerHTML = `<span class="bait-ico">${b.icon}</span><span class="bait-label">${b.label}</span>`;
    chip.addEventListener('click', () => setBait(id));
    baitChips[id] = chip;
    baitRow.appendChild(chip);
  }
  actions.appendChild(baitRow);

  function setBait(id) {
    if (!BAITS[id]) return;
    for (const k of Object.keys(baitChips)) {
      baitChips[k].classList.toggle('active', k === id);
    }
    if (world.fishingSim && world.fishingSim.setBait) world.fishingSim.setBait(id);
  }

  const castBtn = document.createElement('button');
  castBtn.type = 'button';
  castBtn.className = 'fish-btn';
  castBtn.id = 'btn-cast';
  castBtn.innerHTML = '<span class="fb-ico">🎣</span>낚시';
  castBtn.title = '낚시 (스페이스)';
  const down = (e) => {
    e.preventDefault();
    try {
      castBtn.setPointerCapture?.(e.pointerId);
    } catch {
      /* pointer tracking not available (e.g. dispatchEvent from tests) */
    }
    onActionStart();
    world.fishingPress(now());
  };
  const up = (e) => {
    e.preventDefault();
    world.fishingRelease(now());
  };
  castBtn.addEventListener('pointerdown', down);
  castBtn.addEventListener('pointerup', up);
  castBtn.addEventListener('pointercancel', up);
  actions.appendChild(castBtn);

  // Delegate button — toggles the auto-angler. When on, it shows the current
  // target species inline so the player can see what the agent is hunting.
  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'fish-btn';
  delBtn.id = 'btn-delegate';
  delBtn.innerHTML = '<span class="fb-ico">🤖</span>위임';
  delBtn.title = '위임 (D)';
  actions.appendChild(delBtn);
  let delegateOn = false;
  function setDelegate(on) {
    delegateOn = !!on;
    delBtn.classList.toggle('hot', delegateOn);
    world.setDelegateMode && world.setDelegateMode(delegateOn);
    if (delegateOn) {
      castBtn.classList.add('locked');
    } else {
      castBtn.classList.remove('locked');
    }
  }
  delBtn.addEventListener('click', () => setDelegate(!delegateOn));
  function toggleDelegate() { setDelegate(!delegateOn); }

  const dexBtn = document.createElement('button');
  dexBtn.type = 'button';
  dexBtn.className = 'fish-btn';
  dexBtn.id = 'btn-dex';
  dexBtn.innerHTML = '<span class="fb-ico">📖</span>도감';
  dexBtn.title = '도감 (C)';
  actions.appendChild(dexBtn);
  root.appendChild(actions);

  // --- dex panel ---
  const dexPanel = document.createElement('div');
  dexPanel.id = 'dex-panel';
  const dexHead = document.createElement('h2');
  const dexCountLabel = document.createElement('span');
  dexHead.appendChild(document.createTextNode('물고기 도감'));
  dexHead.appendChild(dexCountLabel);
  dexPanel.appendChild(dexHead);

  // A small inline SVG silhouette per mesh type, used as a "dex photo" for
  // the species that share that mesh. Six swatches total — see G option 1.
  const meshSvgCache = {};
  function meshSvg(meshType) {
    if (meshSvgCache[meshType]) return meshSvgCache[meshType];
    let inner = '';
    const common = 'fill="#5a8db0" stroke="#9fb2c4" stroke-width="1"';
    switch (meshType) {
      case 'trout':
        inner = `<ellipse cx="20" cy="14" rx="12" ry="4" ${common}/>
                 <polygon points="32,14 38,11 38,17" ${common}/>`;
        break;
      case 'carp':
        inner = `<ellipse cx="20" cy="14" rx="12" ry="6" ${common}/>
                 <polygon points="32,14 38,10 38,18" ${common}/>
                 <polygon points="20,8 22,4 18,4" ${common}/>`;
        break;
      case 'catfish':
        inner = `<ellipse cx="20" cy="14" rx="11" ry="4" ${common}/>
                 <ellipse cx="31" cy="14" rx="6" ry="4" ${common}/>
                 <line x1="34" y1="14" x2="40" y2="18" stroke="#9fb2c4" stroke-width="0.6"/>
                 <line x1="34" y1="14" x2="40" y2="10" stroke="#9fb2c4" stroke-width="0.6"/>`;
        break;
      case 'perch':
        inner = `<ellipse cx="20" cy="14" rx="11" ry="5" ${common}/>
                 <polygon points="32,14 38,11 38,17" ${common}/>
                 <polygon points="14,8 17,3 20,8" ${common}/>
                 <polygon points="20,8 23,3 26,8" ${common}/>`;
        break;
      case 'eel':
        inner = `<rect x="6" y="13" width="28" height="3" rx="1.5" ${common}/>
                 <polygon points="34,14 40,11 40,17" ${common}/>
                 <rect x="6" y="11" width="28" height="0.5" fill="#9fb2c4"/>`;
        break;
      case 'puffer':
        inner = `<circle cx="20" cy="14" r="9" ${common}/>
                 <polygon points="12,6 14,2 16,6" ${common}/>
                 <polygon points="20,4 22,0 24,4" ${common}/>
                 <polygon points="28,6 30,2 32,6" ${common}/>
                 <polygon points="12,22 14,26 16,22" ${common}/>
                 <polygon points="20,24 22,28 24,24" ${common}/>
                 <polygon points="28,22 30,26 32,22" ${common}/>`;
        break;
      default:
        inner = `<circle cx="20" cy="14" r="8" ${common}/>`;
    }
    const svg = `<svg viewBox="0 0 40 28" width="38" height="26" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
    meshSvgCache[meshType] = svg;
    return svg;
  }

  const dexRows = {};
  for (const sp of SPECIES) {
    const row = document.createElement('div');
    row.className = 'dex-row unknown';
    row.dataset.species = sp.id;
    row.innerHTML =
      `<span class="dx-photo">${meshSvg(sp.meshType)}</span>` +
      `<span class="dx-name">???</span>` +
      `<span class="dx-best"></span><span class="dx-count"></span>` +
      `<span class="dx-tip"></span>`;
    dexPanel.appendChild(row);
    dexRows[sp.id] = { row, sp };
  }
  root.appendChild(dexPanel);

  function refreshDex(snap) {
    let known = 0;
    for (const id of Object.keys(dexRows)) {
      const { row, sp } = dexRows[id];
      const d = snap.dex[id];
      const tip = world.getDelegateTip ? world.getDelegateTip(id) : null;
      if (d && d.count > 0) {
        known += 1;
        row.classList.remove('unknown');
        const r = RARITY[sp.rarity];
        row.querySelector('.dx-name').innerHTML =
          `${sp.name} <small style="color:${r.color};font-size:10px;">${r.label}</small>` +
          `<span class="dx-note">${sp.note}</span>`;
        row.querySelector('.dx-best').textContent = `최장 ${d.best}cm`;
        row.querySelector('.dx-count').textContent = `${d.count}마리`;
        // Tip from the delegate agent's learned log.
        if (tip) {
          const acc = Math.round(tip.castPower * 100);
          const hookMs = tip.hookDelayMs ? Math.round(tip.hookDelayMs) : '–';
          row.querySelector('.dx-tip').textContent =
            `위임 학습: ${tip.baitLabel} · 파워 ${acc}% · 후킹 ${hookMs}ms (${tip.attempts}회 시도)`;
        } else {
          row.querySelector('.dx-tip').textContent = '';
        }
      } else {
        row.classList.add('unknown');
        row.querySelector('.dx-name').textContent = '???';
        row.querySelector('.dx-best').textContent = '';
        row.querySelector('.dx-count').textContent = '';
        row.querySelector('.dx-tip').textContent = '';
      }
    }
    dexCountLabel.textContent = `${known}/${SPECIES.length}`;
    sortDexRows();
  }

  // Put caught species first so the dex feels rewarding to scroll.
  function sortDexRows() {
    const arr = Object.values(dexRows);
    arr.sort((a, b) => {
      const ca = a.row.classList.contains('unknown') ? 0 : 1;
      const cb = b.row.classList.contains('unknown') ? 0 : 1;
      if (ca !== cb) return cb - ca; // known first
      return a.sp.name.localeCompare(b.sp.name);
    });
    for (const { row } of arr) dexPanel.appendChild(row);
  }

  dexBtn.addEventListener('click', () => {
    const open = dexPanel.classList.toggle('open');
    if (open && world.getFishingSnapshot) refreshDex(world.getFishingSnapshot());
  });

  function toggleDex() {
    dexBtn.click();
  }

  // Start a fresh action: any prior catch toast gets dismissed so the player
  // can read the new attempt without the old one overlapping.
  function onActionStart() {
    closeToast();
  }

  // --- keyboard ---
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !e.repeat) {
      e.preventDefault();
      onActionStart();
      if (!delegateOn) world.fishingPress(now());
    } else if (e.key === 'c' || e.key === 'C') {
      toggleDex();
    } else if (e.key === 'd' || e.key === 'D') {
      toggleDelegate();
    } else if (e.key === 'Escape') {
      dexPanel.classList.remove('open');
      if (delegateOn) setDelegate(false);
    } else if (e.key >= '1' && e.key <= '3') {
      const id = ['worm', 'berry', 'beet'][Number(e.key) - 1];
      setBait(id);
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      e.preventDefault();
      if (!delegateOn) world.fishingRelease(now());
    }
  });

  // --- catch/escape toasts come through the world callback ---
  world.onFishingEvent = (evt) => {
    if (evt.type === 'caught') {
      const c = evt.catch;
      const r = RARITY[c.species.rarity];
      const bait = BAITS[c.species.bait];
      const baitUsed = c._baitUsed || bait?.label || '';
      showToast(
        `<div class="ct-rarity" style="color:${r.color}">${r.label}</div>` +
        `<div class="ct-name">${c.species.name}</div>` +
        `<div class="ct-sub">${c.sizeCm}cm &middot; ${c.score}점${baitUsed ? ' &middot; ' + baitUsed : ''}</div>`,
        r.color
      );
      refreshDex(world.getFishingSnapshot());
      dexPanel.classList.add('open');
      setTimeout(() => dexPanel.classList.remove('open'), 4200);
    } else if (evt.type === 'escaped') {
      showToast(
        `<div class="ct-rarity" style="color:#ff8a70">놓쳤다…</div>` +
        `<div class="ct-name">줄이 끊어졌습니다</div>` +
        `<div class="ct-sub">${evt.name} &middot; 아쉽게도 놓쳤습니다</div>`,
        'rgba(255,120,90,0.7)'
      );
    }
  };

  // --- per-frame HUD sync (cheap guarded DOM writes) ---
  const PHASE_TEXT = {
    idle: '스페이스를 길게 눌러 캐스팅',
    charging: '게이지가 차오르면 놓아주세요',
    casting: '찌가 날아갑니다…',
    waiting: '입질을 기다리는 중… (짧게 탭하면 회수)',
    bite: '입질이다! 지금 후킹!',
    reeling: '누르면 감고, 떼면 늦춥니다 — 장력 조심!',
    result: '잡았다! 눌러서 확인'
  };

  // Initial bait chip state — reflect whatever the sim already has.
  setBait(world.fishingSim ? world.fishingSim.bait : 'worm');

  let lastText = '';
  let lastPower = -1;
  let lastTension = -1;
  let lastProgress = -1;
  let lastPhase = '';

  function tick() {
    const snap = world.getFishingSnapshot ? world.getFishingSnapshot() : null;
    if (!snap) return;

    if (snap.phase !== lastPhase) {
      lastPhase = snap.phase;
      lastText = ''; // force text refresh
      powerBar.wrap.classList.toggle('on', snap.phase === 'charging');
      const reel = snap.phase === 'reeling';
      tensionBar.wrap.classList.toggle('on', reel);
      progressBar.wrap.classList.toggle('on', reel);
      castBtn.classList.toggle('hot', snap.phase === 'bite' || snap.phase === 'result');
    }
    // In delegate mode the text changes meaning; let the player know what's
    // happening even if they aren't pressing anything.
    let baseText = PHASE_TEXT[snap.phase] || '';
    if (delegateOn) {
      baseText = '🤖 ' + baseText.replace(/^(🎣 )?/, '');
    }
    if (baseText !== lastText) {
      lastText = baseText;
      status.textContent = baseText;
      status.classList.toggle('alert', snap.phase === 'bite' && !delegateOn);
      status.classList.toggle('good', snap.phase === 'result' && !delegateOn);
    }
    const pw = Math.round(snap.power * 100);
    if (pw !== lastPower) {
      lastPower = pw;
      powerBar.fill.style.width = `${pw}%`;
    }
    const tn = Math.round(snap.tension * 100);
    if (tn !== lastTension) {
      lastTension = tn;
      tensionBar.fill.style.width = `${tn}%`;
    }
    const pr = Math.round(snap.progress * 100);
    if (pr !== lastProgress) {
      lastProgress = pr;
      progressBar.fill.style.width = `${pr}%`;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}
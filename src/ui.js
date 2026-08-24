// 직접 만든 글래스모피즘 컨트롤 패널. 프레임워크 없음.
// 식별자(world.setCameraMode / setter / dataset)는 절대 한글화하지 않습니다.
import { CAMERA_MODES } from './world/cameras.js';

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
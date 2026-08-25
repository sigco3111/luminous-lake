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
//
// 50 species across 6 mesh types, 3 bait kinds, with a delegate (auto-angler)
// agent and a delegate log so the dex can store "how it was caught".

import { clamp01, lerp, wrapTime } from './controls.js';

export const FISHING_PHASES = ['idle', 'charging', 'casting', 'waiting', 'bite', 'reeling', 'result'];

// -------------------------------------------------------------- baits ----
export const BAITS = {
  worm:  { id: 'worm',  label: '지렁이', color: '#c79a6a', icon: '🪱',
           note: '만능 기본 미끼. 대부분의 어종이 약하게 반응한다' },
  berry: { id: 'berry', label: '딸기',   color: '#e35b6d', icon: '🍓',
           note: '초식성 어종과 화려한 비늘의 어종이 강하게 반응한다' },
  beet:  { id: 'beet',  label: '비트',   color: '#7a4a8e', icon: '🟣',
           note: '바닥을 뒤지는 저서 어종이 강하게 반응한다' }
};

export const MESH_TYPES = ['trout', 'carp', 'catfish', 'perch', 'eel', 'puffer'];

// -------------------------------------------------------------- species ----
// 50 species. Each entry:
//   id, name, rarity, weight, sizeMin, sizeMax, strength
//   time: 'any' | array of [from, to] (wrap-aware)
//   weather: 'any' | array of weather state names
//   meshType: trout|carp|catfish|perch|eel|puffer
//   bait: preferred bait id
//   profile: delegate hints { distance, holdThreshold, hookDelay }
//   note: short flavor text for the dex
export const SPECIES = [
  // ---------- 민물 일반 (common) ----------
  { id: 'trout', name: '은송어', rarity: 'common', weight: 100, sizeMin: 22, sizeMax: 46, strength: 0.55,
    time: 'any', weather: 'any', meshType: 'trout', bait: 'worm',
    profile: { distance: 'mid', holdThreshold: 0.62, hookDelay: 0.35 },
    note: '호수 어디든 만나는 기본 물고기' },
  { id: 'crucian', name: '붕어', rarity: 'common', weight: 92, sizeMin: 16, sizeMax: 32, strength: 0.48,
    time: 'any', weather: 'any', meshType: 'carp', bait: 'beet',
    profile: { distance: 'near', holdThreshold: 0.55, hookDelay: 0.5 },
    note: '느긋한 미끼 잘 물어보는 평범한 붕어' },
  { id: 'roach', name: '로치', rarity: 'common', weight: 86, sizeMin: 18, sizeMax: 34, strength: 0.5,
    time: 'any', weather: 'any', meshType: 'trout', bait: 'worm',
    profile: { distance: 'near', holdThreshold: 0.58, hookDelay: 0.4 },
    note: '붉은 지느러미가 포인트인 유럽형 민물고기' },
  { id: 'minnow', name: '송사리', rarity: 'common', weight: 80, sizeMin: 8, sizeMax: 18, strength: 0.3,
    time: 'any', weather: 'any', meshType: 'trout', bait: 'worm',
    profile: { distance: 'near', holdThreshold: 0.5, hookDelay: 0.25 },
    note: '작지만 끈질긴 작은 민물고기' },
  { id: 'dace', name: '달빛피라미', rarity: 'common', weight: 70, sizeMin: 14, sizeMax: 30, strength: 0.42,
    time: [[0.78, 0.3]], weather: 'any', meshType: 'trout', bait: 'worm',
    profile: { distance: 'mid', holdThreshold: 0.55, hookDelay: 0.4 },
    note: '밤이면 수면 가까이 올라온다' },
  { id: 'rudd', name: '붉은지느러미', rarity: 'common', weight: 64, sizeMin: 20, sizeMax: 38, strength: 0.5,
    time: 'any', weather: 'any', meshType: 'trout', bait: 'berry',
    profile: { distance: 'near', holdThreshold: 0.55, hookDelay: 0.4 },
    note: '붉은 등지느러미, 딸기에 약하다' },
  { id: 'chub', name: '학공치', rarity: 'common', weight: 58, sizeMin: 26, sizeMax: 48, strength: 0.6,
    time: 'any', weather: 'any', meshType: 'trout', bait: 'berry',
    profile: { distance: 'mid', holdThreshold: 0.6, hookDelay: 0.4 },
    note: '거친 비늘의 민물고기. 딸기를 좋아한다' },
  { id: 'bleak', name: '비익', rarity: 'common', weight: 56, sizeMin: 10, sizeMax: 22, strength: 0.32,
    time: 'any', weather: 'any', meshType: 'trout', bait: 'worm',
    profile: { distance: 'mid', holdThreshold: 0.5, hookDelay: 0.3 },
    note: '은빛으로 번쩍이는 작은 몸' },
  { id: 'gudgeon', name: '모래무지', rarity: 'common', weight: 54, sizeMin: 12, sizeMax: 20, strength: 0.35,
    time: 'any', weather: 'any', meshType: 'trout', bait: 'worm',
    profile: { distance: 'near', holdThreshold: 0.5, hookDelay: 0.3 },
    note: '모래 바닥 근처를 좋아한다' },
  { id: 'bitterling', name: '떡붕어', rarity: 'common', weight: 50, sizeMin: 8, sizeMax: 16, strength: 0.28,
    time: 'any', weather: 'any', meshType: 'carp', bait: 'beet',
    profile: { distance: 'near', holdThreshold: 0.5, hookDelay: 0.4 },
    note: '조개 속에 산다 — 평온한 수심' },
  { id: 'stone_loach', name: '종개', rarity: 'common', weight: 48, sizeMin: 10, sizeMax: 22, strength: 0.36,
    time: 'any', weather: 'any', meshType: 'eel', bait: 'worm',
    profile: { distance: 'near', holdThreshold: 0.55, hookDelay: 0.35 },
    note: '바닥을 기어다니는 작은 민물고기' },
  { id: 'spined_loach', name: '부레종개', rarity: 'common', weight: 46, sizeMin: 12, sizeMax: 24, strength: 0.4,
    time: 'any', weather: 'any', meshType: 'eel', bait: 'worm',
    profile: { distance: 'near', holdThreshold: 0.55, hookDelay: 0.35 },
    note: '등에 가시가 돋아난 종개' },
  { id: 'rutilus', name: '솔치', rarity: 'common', weight: 44, sizeMin: 16, sizeMax: 30, strength: 0.45,
    time: 'any', weather: 'any', meshType: 'trout', bait: 'berry',
    profile: { distance: 'near', holdThreshold: 0.55, hookDelay: 0.4 },
    note: '붉은 눈에 단단한 비늘' },
  { id: 'bream', name: '감붕어', rarity: 'common', weight: 42, sizeMin: 30, sizeMax: 60, strength: 0.7,
    time: 'any', weather: 'any', meshType: 'carp', bait: 'beet',
    profile: { distance: 'mid', holdThreshold: 0.6, hookDelay: 0.45 },
    note: '비트 미끼에 잘 반응하는 우람한 붕어' },
  { id: 'shad', name: '삼치', rarity: 'common', weight: 40, sizeMin: 28, sizeMax: 50, strength: 0.65,
    time: [[0.18, 0.32]], weather: 'any', meshType: 'trout', bait: 'worm',
    profile: { distance: 'mid', holdThreshold: 0.6, hookDelay: 0.35 },
    note: '봄에 강으로 회유해 오는 은빛 물고기' },
  { id: 'gizzard', name: '전어', rarity: 'common', weight: 38, sizeMin: 24, sizeMax: 46, strength: 0.55,
    time: [[0.22, 0.4]], weather: 'any', meshType: 'trout', bait: 'berry',
    profile: { distance: 'mid', holdThreshold: 0.55, hookDelay: 0.4 },
    note: '조류와 식물을 주식으로 하는 초식성' },
  { id: 'topmouth', name: '버들치', rarity: 'common', weight: 36, sizeMin: 14, sizeMax: 26, strength: 0.4,
    time: 'any', weather: 'any', meshType: 'trout', bait: 'berry',
    profile: { distance: 'near', holdThreshold: 0.5, hookDelay: 0.4 },
    note: '입이 위로 향한 작은 물고기' },
  { id: 'eelpout', name: '붕장어', rarity: 'common', weight: 34, sizeMin: 22, sizeMax: 42, strength: 0.45,
    time: [[0.7, 0.92]], weather: 'any', meshType: 'eel', bait: 'worm',
    profile: { distance: 'mid', holdThreshold: 0.55, hookDelay: 0.4 },
    note: '차가운 물에서 발견되는 가시 없는 붕장어' },

  // ---------- 준희귀 / 특수 (uncommon) ----------
  { id: 'perch', name: '황혼우럭', rarity: 'uncommon', weight: 45, sizeMin: 26, sizeMax: 52, strength: 0.72,
    time: [[0.2, 0.34], [0.66, 0.82]], weather: 'any', meshType: 'perch', bait: 'worm',
    profile: { distance: 'near', holdThreshold: 0.58, hookDelay: 0.3 },
    note: '해 무렵 얕은 여울을 오간다' },
  { id: 'bass', name: '민물베스', rarity: 'uncommon', weight: 44, sizeMin: 24, sizeMax: 56, strength: 0.75,
    time: [[0.24, 0.4]], weather: 'any', meshType: 'perch', bait: 'worm',
    profile: { distance: 'mid', holdThreshold: 0.6, hookDelay: 0.35 },
    note: '낮에 활발한 북미 외래종' },
  { id: 'pike', name: '강꼬치고기', rarity: 'uncommon', weight: 42, sizeMin: 50, sizeMax: 110, strength: 1.05,
    time: [[0.3, 0.65]], weather: 'any', meshType: 'eel', bait: 'worm',
    profile: { distance: 'far', holdThreshold: 0.55, hookDelay: 0.25 },
    note: '날카로운 이빨의 포식자 — 빠르게 후킹해야 한다' },
  { id: 'zander', name: '쏠배리', rarity: 'uncommon', weight: 40, sizeMin: 32, sizeMax: 80, strength: 0.85,
    time: 'any', weather: 'any', meshType: 'perch', bait: 'worm',
    profile: { distance: 'mid', holdThreshold: 0.62, hookDelay: 0.4 },
    note: '밤에 활발한 유럽 쏠배리' },
  { id: 'ide', name: '이데', rarity: 'uncommon', weight: 38, sizeMin: 26, sizeMax: 54, strength: 0.7,
    time: 'any', weather: 'any', meshType: 'trout', bait: 'worm',
    profile: { distance: 'mid', holdThreshold: 0.6, hookDelay: 0.4 },
    note: '은빛 비늘의 야경 민물고기' },
  { id: 'asp', name: '재첩', rarity: 'uncommon', weight: 36, sizeMin: 28, sizeMax: 64, strength: 0.78,
    time: [[0.4, 0.65]], weather: 'any', meshType: 'trout', bait: 'worm',
    profile: { distance: 'mid', holdThreshold: 0.6, hookDelay: 0.35 },
    note: '점프가 빠른 민물 추격자' },
  { id: 'tench', name: '틴치', rarity: 'uncommon', weight: 34, sizeMin: 32, sizeMax: 70, strength: 0.8,
    time: 'any', weather: 'any', meshType: 'carp', bait: 'beet',
    profile: { distance: 'near', holdThreshold: 0.65, hookDelay: 0.55 },
    note: '두꺼운 점액 비늘, 느린 인내심의 미끼' },
  { id: 'carp_mirror', name: '거울잉어', rarity: 'uncommon', weight: 32, sizeMin: 36, sizeMax: 88, strength: 0.95,
    time: 'any', weather: 'any', meshType: 'carp', bait: 'beet',
    profile: { distance: 'mid', holdThreshold: 0.65, hookDelay: 0.5 },
    note: '비늘이 거울처럼 듬성듬성 박힌 대형 잉어' },
  { id: 'catfish_small', name: '동자개', rarity: 'uncommon', weight: 30, sizeMin: 28, sizeMax: 52, strength: 0.7,
    time: 'any', weather: 'any', meshType: 'catfish', bait: 'worm',
    profile: { distance: 'near', holdThreshold: 0.62, hookDelay: 0.4 },
    note: '수염이 짧은 소형 메기' },
  { id: 'smelt', name: '빙어', rarity: 'uncommon', weight: 28, sizeMin: 10, sizeMax: 22, strength: 0.34,
    time: [[0.78, 0.1]], weather: 'any', meshType: 'trout', bait: 'worm',
    profile: { distance: 'near', holdThreshold: 0.5, hookDelay: 0.3 },
    note: '차가운 한겨울 밤에만 올라오는 작은 은어' },
  { id: 'ayu', name: '은어', rarity: 'uncommon', weight: 26, sizeMin: 18, sizeMax: 32, strength: 0.5,
    time: [[0.4, 0.7]], weather: 'any', meshType: 'trout', bait: 'berry',
    profile: { distance: 'mid', holdThreshold: 0.55, hookDelay: 0.3 },
    note: '여름 강에서 나는 향 좋은 은어' },
  { id: 'goby', name: '망둥어', rarity: 'uncommon', weight: 24, sizeMin: 10, sizeMax: 22, strength: 0.36,
    time: 'any', weather: 'any', meshType: 'perch', bait: 'worm',
    profile: { distance: 'near', holdThreshold: 0.55, hookDelay: 0.35 },
    note: '바닥 가까이를 헤엄치는 작은 어종' },
  { id: 'stickleback', name: '큰가시고기', rarity: 'uncommon', weight: 22, sizeMin: 6, sizeMax: 10, strength: 0.25,
    time: 'any', weather: 'any', meshType: 'perch', bait: 'worm',
    profile: { distance: 'near', holdThreshold: 0.45, hookDelay: 0.25 },
    note: '등에 가시 세 개, 입이 작다' },
  { id: 'sunfish', name: '해살비', rarity: 'uncommon', weight: 20, sizeMin: 14, sizeMax: 26, strength: 0.4,
    time: [[0.3, 0.55]], weather: 'any', meshType: 'perch', bait: 'worm',
    profile: { distance: 'mid', holdThreshold: 0.5, hookDelay: 0.4 },
    note: '햇살 아래 둥근 몸을 펼치는 어종' },
  { id: 'arowana', name: '아로와나', rarity: 'uncommon', weight: 18, sizeMin: 36, sizeMax: 70, strength: 0.85,
    time: 'any', weather: 'any', meshType: 'trout', bait: 'berry',
    profile: { distance: 'mid', holdThreshold: 0.6, hookDelay: 0.3 },
    note: '몸 위로 입을 튀어올려 사냥하는 열대 어종' },
  { id: 'cichlid', name: '시클리드', rarity: 'uncommon', weight: 16, sizeMin: 14, sizeMax: 28, strength: 0.45,
    time: 'any', weather: 'any', meshType: 'perch', bait: 'berry',
    profile: { distance: 'near', holdThreshold: 0.55, hookDelay: 0.35 },
    note: '형태와 색이 다채로운 관상용 어종' },

  // ---------- 희귀 (rare) ----------
  { id: 'koi', name: '금잉어', rarity: 'rare', weight: 24, sizeMin: 40, sizeMax: 78, strength: 0.95,
    time: [[0.22, 0.36], [0.68, 0.8]], weather: ['clear', 'cloudy'], meshType: 'carp', bait: 'berry',
    profile: { distance: 'mid', holdThreshold: 0.65, hookDelay: 0.5 },
    note: '맑은 날 황금빛 시간대에만 모습을 드러낸다' },
  { id: 'catfish_storm', name: '폭풍메기', rarity: 'rare', weight: 22, sizeMin: 55, sizeMax: 110, strength: 1.15,
    time: 'any', weather: ['rain', 'storm'], meshType: 'catfish', bait: 'worm',
    profile: { distance: 'mid', holdThreshold: 0.6, hookDelay: 0.45 },
    note: '비와 천둥이 몰아칠 때 바닥에서 깨어난다' },
  { id: 'wels_cat', name: '유럽대메기', rarity: 'rare', weight: 18, sizeMin: 80, sizeMax: 180, strength: 1.3,
    time: 'any', weather: 'any', meshType: 'catfish', bait: 'worm',
    profile: { distance: 'far', holdThreshold: 0.55, hookDelay: 0.5 },
    note: '몸집만큼 인내심도 큰 거대 메기' },
  { id: 'arapaima', name: '아라파이마', rarity: 'rare', weight: 16, sizeMin: 100, sizeMax: 220, strength: 1.4,
    time: [[0.3, 0.6]], weather: ['clear'], meshType: 'trout', bait: 'berry',
    profile: { distance: 'far', holdThreshold: 0.5, hookDelay: 0.35 },
    note: '거대한 비늘의 살아있는 화석' },
  { id: 'gar', name: '가아', rarity: 'rare', weight: 14, sizeMin: 60, sizeMax: 130, strength: 1.2,
    time: 'any', weather: 'any', meshType: 'eel', bait: 'worm',
    profile: { distance: 'far', holdThreshold: 0.55, hookDelay: 0.25 },
    note: '긴 주둥이의 살아있는 화석' },
  { id: 'bowfin', name: '보우핀', rarity: 'rare', weight: 12, sizeMin: 40, sizeMax: 70, strength: 0.95,
    time: 'any', weather: 'any', meshType: 'eel', bait: 'worm',
    profile: { distance: 'mid', holdThreshold: 0.6, hookDelay: 0.4 },
    note: '공기 호흡이 가능한 살아있는 화석' },
  { id: 'sturgeon', name: '철갑상어', rarity: 'rare', weight: 12, sizeMin: 90, sizeMax: 220, strength: 1.5,
    time: [[0.18, 0.32]], weather: 'any', meshType: 'eel', bait: 'worm',
    profile: { distance: 'far', holdThreshold: 0.5, hookDelay: 0.55 },
    note: '봄에 회유해 오는 거대 화석 어류' },
  { id: 'lamprey', name: '칠성장어', rarity: 'rare', weight: 10, sizeMin: 30, sizeMax: 60, strength: 0.9,
    time: 'any', weather: 'any', meshType: 'eel', bait: 'worm',
    profile: { distance: 'mid', holdThreshold: 0.6, hookDelay: 0.4 },
    note: '입이 빨판처럼 생긴 기생 어류' },
  { id: 'puffer', name: '복어', rarity: 'rare', weight: 10, sizeMin: 16, sizeMax: 36, strength: 0.7,
    time: [[0.4, 0.6]], weather: 'any', meshType: 'puffer', bait: 'worm',
    profile: { distance: 'near', holdThreshold: 0.55, hookDelay: 0.4 },
    note: '위기 시 몸을 부풀리는 둥근 어종' },
  { id: 'fugu', name: '야생복어', rarity: 'rare', weight: 8, sizeMin: 22, sizeMax: 50, strength: 0.85,
    time: 'any', weather: ['storm'], meshType: 'puffer', bait: 'worm',
    profile: { distance: 'mid', holdThreshold: 0.6, hookDelay: 0.35 },
    note: '폭풍 직전 가장 활발해지는 위험한 어종' },

  // ---------- 전설 / 에픽 ----------
  { id: 'ghost', name: '유령은어', rarity: 'legendary', weight: 4, sizeMin: 30, sizeMax: 60, strength: 1.35,
    time: [[0.86, 0.18]], weather: ['clear'], meshType: 'eel', bait: 'worm',
    profile: { distance: 'mid', holdThreshold: 0.5, hookDelay: 0.5 },
    note: '달이 밝고 잔잔한 한밤중에만 눈에 닿는다' },
  { id: 'koi_king', name: '왕금잉어', rarity: 'legendary', weight: 3, sizeMin: 80, sizeMax: 130, strength: 1.4,
    time: [[0.22, 0.32]], weather: ['clear'], meshType: 'carp', bait: 'berry',
    profile: { distance: 'mid', holdThreshold: 0.55, hookDelay: 0.55 },
    note: '맑은 새벽, 단 한 시간만 모습을 보이는 전설의 잉어' },
  { id: 'celestial', name: '천상의잉어', rarity: 'legendary', weight: 3, sizeMin: 60, sizeMax: 110, strength: 1.3,
    time: [[0.85, 0.95]], weather: ['clear'], meshType: 'carp', bait: 'berry',
    profile: { distance: 'far', holdThreshold: 0.55, hookDelay: 0.5 },
    note: '별빛 아래 비늘이 부서지는 듯 빛난다' },
  { id: 'leviathan_cat', name: '레비아탄', rarity: 'epic', weight: 6, sizeMin: 140, sizeMax: 280, strength: 1.7,
    time: 'any', weather: ['storm'], meshType: 'catfish', bait: 'worm',
    profile: { distance: 'far', holdThreshold: 0.5, hookDelay: 0.55 },
    note: '폭풍 속에 잠에서 깨어나는 호수의 거인' },
  { id: 'abyssal', name: '심해어', rarity: 'legendary', weight: 2, sizeMin: 80, sizeMax: 160, strength: 1.6,
    time: [[0.9, 0.1]], weather: 'any', meshType: 'eel', bait: 'worm',
    profile: { distance: 'far', holdThreshold: 0.5, hookDelay: 0.55 },
    note: '깊은 밤 수면 위로 떠오르는 발광 어종' },
  { id: 'dragon_koi', name: '용비늘', rarity: 'legendary', weight: 2, sizeMin: 100, sizeMax: 180, strength: 1.7,
    time: [[0.22, 0.32]], weather: ['rain', 'storm'], meshType: 'carp', bait: 'berry',
    profile: { distance: 'far', holdThreshold: 0.55, hookDelay: 0.55 },
    note: '폭풍과 새벽이 만나는 순간만 출현' }
];

// Sanity guard so future edits to SPECIES don't silently break the dex.
if (SPECIES.length !== 50) {
  throw new Error(`SPECIES must contain 50 entries (got ${SPECIES.length})`);
}

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

export function speciesTimeOk(sp, tod) {
  return inTimeWindow(tod, sp.time);
}

export function speciesWeatherOk(sp, weatherState) {
  return sp.weather === 'any' || sp.weather.includes(weatherState);
}

// Bait effect on weight: matching bait ×2.0, neutral ×1.0, off-bait ×0.5.
export function baitMultiplier(sp, bait) {
  if (!bait || bait === 'worm') return 1;
  return sp.bait === bait ? 2.0 : 0.5;
}

export function speciesWeight(sp, tod, weatherState, bait) {
  let k = 1;
  k *= speciesTimeOk(sp, tod) ? 3 : 0.12;
  k *= speciesWeatherOk(sp, weatherState) ? 3 : 0.12;
  k *= baitMultiplier(sp, bait);
  return sp.weight * k;
}

// How good the current conditions are: of the GATED species (i.e. those with
// at least one of time/weather as a real filter), what fraction is fully
// active. Always-active 'any' species provide a baseline so the floor is
// 0.3; a perfect gated match drives luck up to 1.0. Roughly 0.4..0.76 across
// real conditions after the dex grew to 50 species.
const GATED_WEIGHT = SPECIES
  .filter((sp) => !(sp.time === 'any' && sp.weather === 'any'))
  .reduce((s, sp) => s + sp.weight, 0);

export function biteLuck(tod, weatherState, bait) {
  let active = 0;
  for (const sp of SPECIES) {
    if (sp.time === 'any' && sp.weather === 'any') continue;
    if (speciesTimeOk(sp, tod) && speciesWeatherOk(sp, weatherState)) {
      active += sp.weight * baitMultiplier(sp, bait);
    }
  }
  return 0.3 + clamp01(active / GATED_WEIGHT) * 0.7;
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

    this.pressTime = -1;
    this.heldTime = 0;
    this.holding = false;

    this.bait = 'worm'; // active bait id
    this.lastCatch = null;
    this.stats = { catches: 0, bestScore: 0, escaped: 0 };
    this.dex = {}; // id -> { count, best }

    this._biteTimer = 0;
    this._nibbles = [];
    this._biteTimerMax = 1;
    this._fish = null; // { species, size01, pull } while fighting
    this._lastCast = null; // { power, distance } for delegate log
  }

  // ---------------------------------------------------------- bait etc ---
  setBait(baitId) {
    if (!BAITS[baitId]) return;
    this.bait = baitId;
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
        this._lastCast = { power };
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
        this._lastCast = { power: this._pendingPower, distance: dist };
        if (this.castT >= 1) {
          this.bobber.x = this._castTo.x;
          this.bobber.z = this._castTo.z;
          this._land();
        }
        break;
      }

      case 'waiting': {
        this._biteTimer -= dt;
        while (this._nibbles.length && this._biteTimer <= this._nibbles[0] * this._biteTimerMax) {
          this._nibbles.shift();
          this.events.push({ type: 'nibble', x: this.bobber.x, z: this.bobber.z });
        }
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
          this.progress -= dt * 0.05;
        }
        this.tension = clamp01(this.tension);
        this.progress = clamp01(this.progress);
        const drag = Math.sin(env.time * 2.3 + pull * 9) * 0.35 * pull * dt;
        const bx = this.bobber.x - env.boatX;
        const bz = this.bobber.z - env.boatZ;
        const bl = Math.hypot(bx, bz) || 1;
        this.bobber.x += (-bz / bl) * drag;
        this.bobber.z += (bx / bl) * drag;
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
    const luck = biteLuck(env.tod, env.weatherState, this.bait);
    this._biteTimerMax = lerp(20, 7, luck) * this.rng.float(0.7, 1.35);
    this._biteTimer = this._biteTimerMax;
    const count = this.rng.int(0, 3);
    this._nibbles = [];
    for (let i = 0; i < count; i++) {
      this._nibbles.push(this.rng.float(0.3, 0.95));
    }
    this._nibbles.sort((a, b) => b - a);
  }

  _startBite() {
    this.phase = 'bite';
    this._biteWindow = BITE_WINDOW;
    this._biteTime = 0; // time spent in the bite phase (for delegate hookDelay)
    this.events.push({ type: 'splash', x: this.bobber.x, z: this.bobber.z, big: true });
    this.events.push({ type: 'bite', x: this.bobber.x, z: this.bobber.z });
  }

  _hook() {
    const env = this._lastEnv;
    const pool = [];
    for (const sp of SPECIES) {
      const w = speciesWeight(sp, env.tod, env.weatherState, this.bait);
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
    const size01 = Math.pow(this.rng.float(), 1.7);
    this._fish = {
      species: picked,
      size01,
      sizeCm: Math.round(lerp(picked.sizeMin, picked.sizeMax, size01)),
      pull: picked.strength * (0.75 + size01 * 0.5),
      hookDelay: picked.profile.hookDelay,
      holdThreshold: picked.profile.holdThreshold,
      startedAt: env.time
    };
    this.phase = 'reeling';
    this.tension = 0.25;
    this.progress = 0.04;
    this.holding = false;
    this.events.push({ type: 'hooked', x: this.bobber.x, z: this.bobber.z, species: picked });
  }

  _finishFight() {
    const f = this._fish;
    const r = RARITY[f.species.rarity];
    const score = Math.round(r.score * (0.6 + f.size01 * 0.8));
    return { ...f, rarityLabel: r.label, score, _baitUsed: BAITS[this.bait] ? BAITS[this.bait].label : this.bait };
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
      bait: this.bait,
      fishName: this._fish ? this._fish.species.name : null,
      lastCatch: this.lastCatch,
      lastCast: this._lastCast ? { ...this._lastCast } : null,
      stats: { ...this.stats },
      dex: this.dex
    };
  }
}

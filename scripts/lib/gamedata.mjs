// Shared dictionaries for Uma Musume game data.
// Naming follows the Global (EN) client wording.

export const RUNNING_STYLE = {
  1: { key: 'front', name: 'Front Runner', short: 'Front' },
  2: { key: 'pace', name: 'Pace Chaser', short: 'Pace' },
  3: { key: 'late', name: 'Late Surger', short: 'Late' },
  4: { key: 'end', name: 'End Closer', short: 'End' },
};

export const DISTANCE_TYPE = {
  1: { key: 'sprint', name: 'Sprint', range: '1000-1600m' },
  2: { key: 'mile', name: 'Mile', range: '1600-1800m' },
  3: { key: 'medium', name: 'Medium', range: '1800-2400m' },
  4: { key: 'long', name: 'Long', range: '2500m+' },
};

export const SURFACE = {
  1: { key: 'turf', name: 'Turf' },
  2: { key: 'dirt', name: 'Dirt' },
};

export const GROUND_CONDITION = {
  1: 'Firm',
  2: 'Good',
  3: 'Soft',
  4: 'Heavy',
};

export const WEATHER = {
  1: 'Sunny',
  2: 'Cloudy',
  3: 'Rainy',
  4: 'Snowy',
};

export const SEASON = {
  1: 'Spring',
  2: 'Summer',
  3: 'Autumn',
  4: 'Winter',
  5: 'Sakura season',
};

export const ROTATION = {
  1: 'Right-handed',
  2: 'Left-handed',
};

export const PHASE = {
  0: { key: 'opening', name: 'Opening leg' },
  1: { key: 'middle', name: 'Middle leg' },
  2: { key: 'final', name: 'Final leg' },
  3: { key: 'lastspurt', name: 'Last spurt' },
};

// Aptitude grades, as stored in card_rarity_data (1 = G .. 8 = S)
export const APTITUDE_GRADE = ['-', 'G', 'F', 'E', 'D', 'C', 'B', 'A', 'S'];

export const APTITUDE_ORDER = [
  { key: 'sprint', label: 'Sprint', group: 'distance' },
  { key: 'mile', label: 'Mile', group: 'distance' },
  { key: 'medium', label: 'Medium', group: 'distance' },
  { key: 'long', label: 'Long', group: 'distance' },
  { key: 'front', label: 'Front Runner', group: 'style' },
  { key: 'pace', label: 'Pace Chaser', group: 'style' },
  { key: 'late', label: 'Late Surger', group: 'style' },
  { key: 'end', label: 'End Closer', group: 'style' },
  { key: 'turf', label: 'Turf', group: 'surface' },
  { key: 'dirt', label: 'Dirt', group: 'surface' },
];

// Order of the aptitude array coming out of card_rarity_data.
export const APTITUDE_COLUMNS = [
  'sprint', 'mile', 'medium', 'long',
  'front', 'pace', 'late', 'end',
  'turf', 'dirt',
];

export const SUPPORT_TYPE = {
  0: { key: 'speed', name: 'Speed' },
  1: { key: 'stamina', name: 'Stamina' },
  2: { key: 'power', name: 'Power' },
  3: { key: 'guts', name: 'Guts' },
  4: { key: 'wit', name: 'Wit' },
  5: { key: 'friend', name: 'Friend' },
  6: { key: 'group', name: 'Group' },
};

export const SUPPORT_RARITY = { 0: 'R', 1: 'SR', 2: 'SSR' };

// skill_data.rarity
export const SKILL_RARITY = {
  1: { key: 'normal', name: 'Normal', rank: 1 },
  2: { key: 'gold', name: 'Gold', rank: 2 },
  3: { key: 'evolved', name: 'Evolved unique', rank: 4 },
  4: { key: 'evolved', name: 'Evolved unique', rank: 4 },
  5: { key: 'unique', name: 'Unique', rank: 3 },
};

/**
 * Effect types used by skill_data. `scale` converts the raw modifier into the
 * displayed number, `unit` is what that number means.
 */
export const EFFECT_TYPES = {
  1: { key: 'speed', label: 'Speed', scale: 1e-4, unit: '', kind: 'stat' },
  2: { key: 'stamina', label: 'Stamina', scale: 1e-4, unit: '', kind: 'stat' },
  3: { key: 'power', label: 'Power', scale: 1e-4, unit: '', kind: 'stat' },
  4: { key: 'guts', label: 'Guts', scale: 1e-4, unit: '', kind: 'stat' },
  5: { key: 'wit', label: 'Wit', scale: 1e-4, unit: '', kind: 'stat' },
  6: { key: 'special', label: 'Special', scale: 1, unit: '', kind: 'other' },
  8: { key: 'activation', label: 'Skill activation rate', scale: 1e-4, unit: '%', kind: 'utility' },
  9: { key: 'recovery', label: 'Stamina recovery', scale: 1e-2, unit: '% max HP', kind: 'recovery' },
  10: { key: 'startdash', label: 'Start-delay factor', scale: 1e-4, unit: '', kind: 'utility' },
  13: { key: 'opp_temptation', label: 'Opponent pace-up rate', scale: 1e-4, unit: '%', kind: 'debuff' },
  14: { key: 'hp_drain', label: 'Stamina drain', scale: 1e-2, unit: '% max HP', kind: 'debuff' },
  21: { key: 'current_speed', label: 'Instant speed', scale: 1e-4, unit: 'm/s', kind: 'speed' },
  22: { key: 'current_speed_decel', label: 'Instant speed (decays)', scale: 1e-4, unit: 'm/s', kind: 'speed' },
  27: { key: 'target_speed', label: 'Speed', scale: 1e-4, unit: 'm/s', kind: 'speed' },
  28: { key: 'lane_move', label: 'Lane-change speed', scale: 1e-4, unit: 'm/s', kind: 'utility' },
  29: { key: 'vision', label: 'Vision', scale: 1e-4, unit: '', kind: 'debuff' },
  31: { key: 'accel', label: 'Acceleration', scale: 1e-4, unit: 'm/s²', kind: 'accel' },
  35: { key: 'unblock', label: 'Blocking recovery', scale: 1e-4, unit: '', kind: 'utility' },
  37: { key: 'position_keep', label: 'Positioning', scale: 1e-4, unit: '', kind: 'utility' },
};

export function effectType(t) {
  return EFFECT_TYPES[t] || { key: `type${t}`, label: `Effect #${t}`, scale: 1e-4, unit: '', kind: 'other' };
}

// Race track ids -> Global names come from tracknames.json; this is only a
// fallback for ids the dump does not carry.
export const TRACK_FALLBACK = {};

export const STRATEGY_HP_COEF = {
  1: 0.95,   // Front Runner
  2: 0.89,   // Pace Chaser
  3: 1.0,    // Late Surger
  4: 0.995,  // End Closer
};

// Per-phase target-speed multipliers by running style.
export const STRATEGY_PHASE_COEF = {
  1: [1.0, 0.98, 0.962],
  2: [0.978, 0.991, 0.975],
  3: [0.938, 0.998, 0.994],
  4: [0.931, 1.0, 1.0],
};

export const STRATEGY_ACCEL_COEF = {
  1: [1.0, 1.0, 0.996],
  2: [0.985, 1.0, 0.996],
  3: [0.975, 1.0, 1.0],
  4: [0.945, 1.0, 0.997],
};

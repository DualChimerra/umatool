#!/usr/bin/env node
// Checks docs/assets/js/model.mjs against the reference race solver.
//
// The formulas below are an independent transcription of RaceSolver.ts and
// HpPolicy.ts from alpha123/uma-skill-tools — the same author whose master-database
// dump this project reads. Every course, running style, going and a spread of
// aptitudes are run through both, and the two have to agree to floating-point
// noise. Run with: node scripts/verify-model.mjs
//
// It exits non-zero if they drift, so a change to the model that quietly breaks
// a formula fails here rather than in a race.
import { readFile } from 'node:fs/promises';
import { simulateRace, raceSpeeds, accelRate, effectiveStats, courseSpeedModifier } from '../docs/assets/js/model.mjs';

const SpeedStrategyCoef = [[], [1.0,0.98,0.962],[0.978,0.991,0.975],[0.938,0.998,0.994],[0.931,1.0,1.0]];
const AccelStrategyCoef = [[], [1.0,1.0,0.996],[0.985,1.0,0.996],[0.975,1.0,1.0],[0.945,1.0,0.997]];
const DistProfSpeed  = [1.05,1.0,0.9,0.8,0.6,0.4,0.2,0.1];   // index 0=S,1=A,...
const DistProfAccel  = [1.0,1.0,1.0,1.0,1.0,0.6,0.5,0.4];
const SurfProfAccel  = [1.05,1.0,0.9,0.8,0.7,0.5,0.3,0.1];
const HpStrategyCoef = [0,0.95,0.89,1.0,0.995];
const HpGround = [[],[0,1.0,1.0,1.02,1.02],[0,1.0,1.0,1.01,1.02]];
const GroundSpeed = [null,[0,0,0,0,-50],[0,0,0,0,-50]];
const GroundPower = [null,[0,0,-50,-50,-50],[0,-100,-50,-100,-100]];
// project grade value 8=S -> reference index 0
const refIdx = (grade) => 8 - grade;

const base = (d) => 20.0 - (d - 2000) / 1000.0;

function refCourseSpeedModifier(course, stats) {
  const v = [0, stats.speed, stats.stamina, stats.power, stats.guts, stats.wit].map((x) => Math.min(x, 901));
  const set = course.courseSetStatus ?? [];
  return 1 + set.map((st) => (1 + Math.floor(v[st] / 300.01)) * 0.05).reduce((a, b) => a + b, 0) / Math.max(set.length, 1);
}

function refStats(stats, course, ground) {
  return {
    speed: Math.max(stats.speed * refCourseSpeedModifier(course, stats) + GroundSpeed[course.surface][ground], 1),
    stamina: stats.stamina,
    power: Math.max(stats.power + GroundPower[course.surface][ground], 1),
    guts: stats.guts, wit: stats.wit,
  };
}

function refBaseTargetSpeed(h, course, phase, apt) {
  return base(course.distance) * SpeedStrategyCoef[h.strategy][phase]
    + (phase === 2 ? 1 : 0) * Math.sqrt(500.0 * h.speed) * DistProfSpeed[refIdx(apt.distance)] * 0.002;
}
function refLastSpurtSpeed(h, course, apt) {
  return (refBaseTargetSpeed(h, course, 2, apt) + 0.01 * base(course.distance)) * 1.05
    + Math.sqrt(500.0 * h.speed) * DistProfSpeed[refIdx(apt.distance)] * 0.002
    + Math.pow(450.0 * h.guts, 0.597) * 0.0001;
}
function refAccel(h, phase, apt, uphill = false) {
  return (uphill ? 0.0004 : 0.0006) * Math.sqrt(500.0 * h.power)
    * AccelStrategyCoef[h.strategy][phase]
    * SurfProfAccel[refIdx(apt.surface)] * DistProfAccel[refIdx(apt.distance)];
}
function refHpPerSecond(course, ground, v, guts, phase) {
  const gutsMod = phase >= 2 ? 1.0 + 200.0 / Math.sqrt(600.0 * guts) : 1.0;
  return 20.0 * Math.pow(v - base(course.distance) + 12.0, 2) / 144.0 * HpGround[course.surface][ground] * gutsMod;
}
/** HP the reference needs for an unbroken last spurt: (finalLeg - 60) / maxSpeed seconds. */
function refFullSpurtHp(course, ground, stats, strategy, apt) {
  const e = refStats(stats, course, ground);
  const h = { ...e, strategy };
  const maxSpeed = refLastSpurtSpeed(h, course, apt);
  const maxDist = course.distance - course.distance * 2 / 3;
  return refHpPerSecond(course, ground, maxSpeed, e.guts, 2) * ((maxDist - 60) / maxSpeed);
}

const courses = JSON.parse(await readFile(new URL('../docs/data/courses.json', import.meta.url), 'utf8'));
const STATS = { speed: 1200, stamina: 900, power: 1000, guts: 500, wit: 900 };

let worstSpurt = 0, worstAccel = 0, worstHp = 0, worstStats = 0, worstCsm = 0;
let n = 0;
for (const course of courses) {
  for (const strategy of [1, 2, 3, 4]) {
    for (const ground of [1, 2, 3, 4]) {
      for (const apt of [{ distance: 7, surface: 7, style: 7 }, { distance: 8, surface: 5, style: 6 }, { distance: 4, surface: 8, style: 7 }]) {
        n += 1;
        const e = effectiveStats(STATS, course, ground);
        const r = refStats(STATS, course, ground);
        worstStats = Math.max(worstStats, Math.abs(e.speed - r.speed), Math.abs(e.power - r.power));
        worstCsm = Math.max(worstCsm, Math.abs(courseSpeedModifier(course, STATS) - refCourseSpeedModifier(course, STATS)));

        const mine = raceSpeeds({ distance: course.distance, speed: e.speed, guts: e.guts, strategy, aptitudes: apt });
        const theirs = refLastSpurtSpeed({ ...r, strategy }, course, apt);
        worstSpurt = Math.max(worstSpurt, Math.abs(mine.spurt - theirs));

        const myAccel = accelRate(e.power, strategy, 2, apt);
        worstAccel = Math.max(worstAccel, Math.abs(myAccel - refAccel({ ...r, strategy }, 2, apt)));

        const sim = simulateRace({ course, strategy, stats: STATS, ground, aptitudes: apt });
        worstHp = Math.max(worstHp, Math.abs(sim.hpFullSpurt - refFullSpurtHp(course, ground, STATS, strategy, apt)));
      }
    }
  }
}
console.log(`combinations checked: ${n}`);
console.log(`max |Δ| effective stats     : ${worstStats.toExponential(3)}`);
console.log(`max |Δ| course speed modifier: ${worstCsm.toExponential(3)}`);
console.log(`max |Δ| last spurt speed     : ${worstSpurt.toExponential(3)} m/s`);
console.log(`max |Δ| final-leg accel      : ${worstAccel.toExponential(3)} m/s²`);
console.log(`max |Δ| full-spurt HP        : ${worstHp.toExponential(3)} HP`);

const tolerance = 1e-9;
const drift = [worstStats, worstCsm, worstSpurt, worstAccel, worstHp].some((d) => d > tolerance);
if (drift) {
  console.error('\nMODEL DRIFT: the model no longer matches the reference solver.');
  process.exit(1);
}
console.log('\nmodel matches the reference solver.');

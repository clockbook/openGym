import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runEngine, trendSeries, goalRate, mergeWeighIns, formulaExpenditure, addDays, targetsChanged, KCAL_PER_KG
} from '../coach/core/energy.js';

const STATS = { sex: 'm', birthYear: 1990, heightCm: 178, activity: 'moderate' };

/** A made-up person: eats `eat` a day, really burns `burn`, weighs in every `every` days with noise. */
function person({ days = 70, eat = 2500, burn = 2800, startKg = 80, every = 1, noise = 0.4, logged = 1, today = '2026-11-01' }) {
  const food = [], weighIns = [];
  let kg = startKg, seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  for (let i = days; i >= 1; i--) {
    const d = addDays(today, -i);
    kg += (eat - burn) / KCAL_PER_KG;
    if ((days - i) % Math.round(1 / logged) === 0) food.push({ d, kcal: eat, p: 140 });
    if ((days - i) % every === 0) weighIns.push({ d, kg: kg + noise * 2 * rnd() });
  }
  return { days: food, weighIns, stats: STATS, goal: {}, today };
}

test('the trend smooths the scale and follows a straight line between sparse weigh-ins', () => {
  const t = trendSeries([{ d: '2026-10-01', kg: 80 }, { d: '2026-10-11', kg: 79 }], '2026-10-20');
  assert.equal(t.size, 20);
  assert.ok(t.get('2026-10-11') < 80 && t.get('2026-10-11') > 79);
  assert.ok(t.get('2026-10-20') < t.get('2026-10-11'));   // still catching up with 79
});

test('expenditure starts at the formula and walks to what the body actually did', () => {
  const p = person({});
  const formula = formulaExpenditure(STATS, p.weighIns[0].kg, p.days[0].d);
  const r = runEngine(p);
  assert.equal(r.weeks[0].expenditure, Math.round(formula));
  assert.ok(Math.abs(r.expenditure - 2800) < 120, `expected ~2800, got ${r.expenditure}`);
  assert.equal(r.confidence, 'ok');
  // A deficit of 300 kcal a day is about 0.27 kg a week.
  assert.ok(r.actualRate < -0.15 && r.actualRate > -0.4, `rate ${r.actualRate}`);
});

test('a week moves the estimate by at most 150 kcal', () => {
  const r = runEngine(person({ burn: 3600 }));
  for (let i = 1; i < r.weeks.length; i++) {
    assert.ok(Math.abs(r.weeks[i].expenditure - r.weeks[i - 1].expenditure) <= 150);
  }
});

test('weekly weigh-ins still converge, only more slowly', () => {
  const r = runEngine(person({ every: 7, days: 98 }));
  assert.ok(Math.abs(r.expenditure - 2800) < 200, `got ${r.expenditure}`);
});

test('sparse logging is left out rather than read as eating nothing', () => {
  const half = runEngine(person({ logged: 0.33, days: 42 }));
  // Too few logged days: no week is observed, the formula stands.
  assert.equal(half.confidence, 'formula');
  assert.ok(half.expenditure > 2000);
});

test('the target is expenditure plus the goal rate, never under the floor', () => {
  const p = person({});
  const hold = runEngine(p);
  assert.equal(hold.target.kcal, Math.round(hold.expenditure / 10) * 10);
  const lose = runEngine({ ...p, goal: { rateGoal: { dir: 'lose', by: '%', lo: 0.5, hi: 0.5 } } });
  const perDay = 0.005 * lose.trendKg * KCAL_PER_KG / 7;
  assert.ok(Math.abs(hold.target.kcal - lose.target.kcal - perDay) < 15);
  const crash = runEngine({ ...p, goal: { rateGoal: { dir: 'lose', by: 'w', lo: 3, hi: 3 } } });
  assert.equal(crash.target.kcal, 1500);
  assert.equal(crash.floorApplied, true);
});

test('protein follows the trend weight, 1.6 g/kg unless set', () => {
  const p = person({});
  const r = runEngine(p);
  assert.equal(r.target.protein, Math.round(1.6 * r.trendKg / 5) * 5);
  assert.equal(runEngine({ ...p, proteinPerKg: 2.2 }).target.protein, Math.round(2.2 * r.trendKg / 5) * 5);
});

test('goal rate: a corridor, a goal weight, or hold', () => {
  assert.equal(goalRate({ rateGoal: { dir: 'lose', by: '%', lo: 0.5, hi: 1 } }, 80), -0.6);
  assert.ok(Math.abs(goalRate({ rateGoal: { dir: 'gain', by: 'w', lo: 0.5, hi: 0.5 }, unit: 'lb' }, 80) - 0.2268) < 0.001);
  assert.equal(goalRate({ rateGoal: { dir: 'hold', lo: 0, hi: 0.5 } }, 80), 0);
  assert.equal(goalRate({ targetW: 75 }, 80), -0.4);
  assert.equal(goalRate({ targetW: 79.8 }, 80), 0);
  assert.equal(goalRate({}, 80), 0);
});

test('typed weigh-ins win over imported ones, and pounds become kg', () => {
  const m = mergeWeighIns([{ d: '2026-10-02', w: 176 }], 'lb', [{ d: '2026-10-01', kg: 80 }, { d: '2026-10-02', kg: 81 }]);
  assert.deepEqual(m.map(x => x.d), ['2026-10-01', '2026-10-02']);
  assert.ok(Math.abs(m[1].kg - 79.83) < 0.01);
});

test('no weigh-ins, no engine; no body stats, the first good weeks seed it', () => {
  assert.equal(runEngine({ today: '2026-11-01', weighIns: [] }), null);
  const r = runEngine({ ...person({}), stats: {} });
  assert.ok(Math.abs(r.expenditure - 2800) < 150, `got ${r.expenditure}`);
});

test('small moves are not worth a check-in card', () => {
  assert.equal(targetsChanged({ kcal: 2300, protein: 115 }, { kcal: 2330, protein: 115 }), false);
  assert.equal(targetsChanged({ kcal: 2300, protein: 115 }, { kcal: 2250, protein: 115 }), true);
  assert.equal(targetsChanged(null, { kcal: 2250, protein: 115 }), true);
});

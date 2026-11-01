/* The energy engine: trend weight, expenditure, and the calorie and protein targets.
 *
 * The same idea as MacroFactor's weekly check-in. The scale is noisy, so the weight that counts
 * is a smoothed trend. What someone burns is estimated from what they actually ate and what the
 * trend did over the same weeks (energy in − change in stored energy), starting from a formula
 * and moving towards the observed number a bit at a time. The calorie target is that burn plus
 * whatever the goal rate asks for. Whether last week's target was hit plays no part: the target
 * follows the body, not the adherence.
 *
 * Deterministic and pure, like the progression engine: the Coach explains these numbers, it
 * never picks them. Shared by the server (the Sunday check-in) and the app (the cards).
 *
 * Every weight in here is kg, every energy kcal, every day an ISO date.
 */

export const KCAL_PER_KG = 7700;          // energy in a kg of body mass, mixed tissue
export const TREND_ALPHA = 0.1;           // smoothing per day: a weigh-in moves the trend 10%
export const WINDOW_DAYS = 21;            // how far back one estimate reads
export const MIN_LOGGED_DAYS = 10;        // of WINDOW_DAYS, to trust the intake average
export const MIN_WEIGH_INS = 3;           // in the window, to trust the trend's slope
export const LOGGED_MIN_KCAL = 800;       // a day under this was not fully logged: left out
export const STEP = 0.5;                  // how far each week moves towards the observed number
export const MAX_STEP_KCAL = 150;         // and never more than this in one week
export const PROTEIN_PER_KG = 1.6;
export const ACTIVITY = Object.freeze({
  sedentary: 1.2,     // desk job, little walking
  light: 1.375,       // on your feet some of the day, or training 1-3 times a week
  moderate: 1.55,     // training 3-5 times a week
  very: 1.725,        // hard training most days, or a physical job
  extra: 1.9          // physical job and hard training
});
const FLOOR = { m: 1500, f: 1200 };

const DAY = 86400000;
const toMs = iso => Date.parse(iso + 'T00:00:00Z');
const toIso = ms => new Date(ms).toISOString().slice(0, 10);
export const addDays = (iso, n) => toIso(toMs(iso) + n * DAY);
const daysBetween = (a, b) => Math.round((toMs(b) - toMs(a)) / DAY);
const r1 = v => Math.round(v * 10) / 10;
const r2 = v => Math.round(v * 100) / 100;
const roundTo = (v, n) => Math.round(v / n) * n;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Mifflin-St Jeor resting energy, kcal/day. Null when the profile is incomplete. */
export function bmr({ sex, heightCm, birthYear } = {}, kg, today) {
  const age = Number(today?.slice(0, 4)) - Number(birthYear);
  if (!(kg > 0) || !(heightCm > 0) || !(age > 0 && age < 120) || !['m', 'f'].includes(sex)) return null;
  return 10 * kg + 6.25 * heightCm - 5 * age + (sex === 'm' ? 5 : -161);
}

/** Expenditure from the formula alone: resting energy times the activity factor. */
export function formulaExpenditure(stats, kg, today) {
  const b = bmr(stats, kg, today);
  return b == null ? null : b * (ACTIVITY[stats?.activity] || ACTIVITY.light);
}

/**
 * One weigh-in per day, in kg, from the profile's own log (`S.bodyweight`, in `unit`) and the
 * ones Health Connect sent (already kg). A day typed into openGym keeps its typed weight.
 */
export function mergeWeighIns(bodyweight, unit, imported = []) {
  const k = unit === 'lb' ? 1 / 2.2046226218 : 1;
  const out = new Map();
  for (const b of Array.isArray(imported) ? imported : []) if (b?.d && b.kg > 0) out.set(b.d, b.kg);
  for (const b of Array.isArray(bodyweight) ? bodyweight : []) {
    const w = Number(b?.w);
    if (b?.d && w > 0) out.set(b.d, w * k);
  }
  return [...out].map(([d, kg]) => ({ d, kg })).sort((a, b) => (a.d < b.d ? -1 : 1));
}

/**
 * The trend weight for every day from the first weigh-in to `to`. Days between weigh-ins are
 * filled by a straight line between them, and the days after the last hold it, so a person who
 * weighs in weekly gets a trend as smooth as a daily one, only slower to react.
 * Returns Map(day → kg).
 */
export function trendSeries(weighIns, to) {
  const pts = (weighIns || []).filter(p => p.d <= to);
  const out = new Map();
  if (!pts.length) return out;
  let trend = pts[0].kg, i = 0;
  for (let d = pts[0].d; d <= to; d = addDays(d, 1)) {
    while (i + 1 < pts.length && pts[i + 1].d <= d) i++;
    const a = pts[i], b = pts[i + 1];
    const raw = b ? a.kg + (b.kg - a.kg) * daysBetween(a.d, d) / daysBetween(a.d, b.d) : a.kg;
    trend += TREND_ALPHA * (raw - trend);
    out.set(d, trend);
  }
  return out;
}

/**
 * The weekly rate the goal asks for, signed kg/week (negative is losing). From the profile's
 * weekly-rate corridor (S.rateGoal, the middle of it) when there is one; otherwise towards the
 * goal weight at a moderate pace; otherwise hold.
 */
export function goalRate({ rateGoal, targetW, unit } = {}, kg) {
  const toKg = unit === 'lb' ? 1 / 2.2046226218 : 1;
  if (rateGoal && ['lose', 'gain', 'hold'].includes(rateGoal.dir)) {
    if (rateGoal.dir === 'hold') return 0;
    const lo = Math.abs(Number(rateGoal.lo) || 0), hi = Math.abs(Number(rateGoal.hi) || 0);
    const mid = (lo + hi) / 2;
    if (mid > 0) {
      const perWeek = rateGoal.by === 'w' ? mid * toKg : mid / 100 * kg;
      return rateGoal.dir === 'lose' ? -perWeek : perWeek;
    }
  }
  const goal = Number(targetW) * toKg;
  if (goal > 0 && kg > 0) {
    if (Math.abs(goal - kg) < 0.5) return 0;
    return goal < kg ? -0.005 * kg : 0.0025 * kg;
  }
  return 0;
}

/**
 * Run the engine over everything logged, week by week, up to `today`.
 *
 * @param {object} input
 *   days        [{ d, kcal, p }]     daily food totals
 *   weighIns    [{ d, kg }]          one per day (mergeWeighIns)
 *   stats       { sex, birthYear, heightCm, activity }
 *   goal        { rateGoal, targetW, unit }
 *   proteinPerKg
 *   today       ISO date
 * @returns {object|null}  null with no weigh-in at all to start from
 */
export function runEngine({ days = [], weighIns = [], stats = {}, goal = {}, proteinPerKg, today }) {
  if (!today || !weighIns.length) return null;
  const trend = trendSeries(weighIns, today);
  const trendOn = d => trend.get(d) ?? null;
  const food = new Map(days.filter(x => x && x.d).map(x => [x.d, x]));
  const measured = new Set(weighIns.map(w => w.d));

  // Weeks end on Saturday, so the Sunday check-in reads a whole Sunday-to-Saturday week.
  const lastSat = addDays(today, -((new Date(toMs(today)).getUTCDay() + 1) % 7));
  const firstFood = days.length ? days.map(x => x.d).sort()[0] : null;
  const start = firstFood && firstFood > weighIns[0].d ? firstFood : weighIns[0].d;
  const startKg = trendOn(start) ?? weighIns[0].kg;

  let E = formulaExpenditure(stats, startKg, start);
  const fromFormula = E != null;
  const weeks = [];
  let observedWeeks = 0;
  // The first week end that has a full window of history behind it.
  let w = addDays(lastSat, -7 * Math.floor(Math.max(0, daysBetween(start, lastSat)) / 7));
  for (; w <= lastSat; w = addDays(w, 7)) {
    const from = addDays(w, -(WINDOW_DAYS - 1));
    const est = observe(from, w);
    if (E == null && est.observed != null) E = est.observed;      // no formula: the first good week seeds it
    else if (E != null && est.observed != null) {
      E += clamp(STEP * (est.observed - E), -MAX_STEP_KCAL, MAX_STEP_KCAL);
      observedWeeks++;
    }
    weeks.push({ end: w, expenditure: E == null ? null : Math.round(E), trend: trendOn(w) == null ? null : r2(trendOn(w)), observed: est.observed, logged: est.logged, weighIns: est.weighIns });
  }

  function observe(from, to) {
    let sum = 0, logged = 0, wins = 0;
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const f = food.get(d);
      if (f && f.kcal >= LOGGED_MIN_KCAL) { sum += f.kcal; logged++; }
      if (measured.has(d)) wins++;
    }
    const t0 = trendOn(addDays(from, -1)), t1 = trendOn(to);
    if (logged < MIN_LOGGED_DAYS || wins < MIN_WEIGH_INS || t0 == null || t1 == null) return { observed: null, logged, weighIns: wins };
    return { observed: Math.round(sum / logged - (t1 - t0) * KCAL_PER_KG / WINDOW_DAYS), logged, weighIns: wins };
  }

  const kg = trendOn(today) ?? weighIns[weighIns.length - 1].kg;
  const rate = goalRate(goal, kg);
  const floor = FLOOR[stats?.sex] || FLOOR.f;
  const kcal = E == null ? null : Math.max(floor, roundTo(E + rate * KCAL_PER_KG / 7, 10));
  const perKg = Number(proteinPerKg) > 0 ? Number(proteinPerKg) : PROTEIN_PER_KG;

  // How the trend actually moved over the last two weeks, kg/week.
  const back = trendOn(addDays(today, -14));
  const actualRate = back == null ? null : r2((kg - back) / 2);

  // The last seven days of eating, against the target.
  let k7 = 0, p7 = 0, n7 = 0;
  for (let d = addDays(today, -7); d < today; d = addDays(d, 1)) {
    const f = food.get(d);
    if (f && f.kcal >= LOGGED_MIN_KCAL) { k7 += f.kcal; p7 += f.p || 0; n7++; }
  }

  return {
    trendKg: r2(kg),
    actualRate,                              // kg/week, last 14 days of trend
    goalRate: r2(rate),                      // kg/week the goal asks for
    expenditure: E == null ? null : Math.round(E),
    // 'formula': nothing observed yet; 'learning': under three good weeks; 'ok' after that.
    confidence: E == null ? 'none' : observedWeeks === 0 ? (fromFormula ? 'formula' : 'none') : observedWeeks < 3 ? 'learning' : 'ok',
    floorApplied: kcal != null && kcal === floor && E + rate * KCAL_PER_KG / 7 < floor,
    target: { kcal, protein: roundTo(perKg * kg, 5) },
    last7: { days: n7, kcal: n7 ? Math.round(k7 / n7) : null, protein: n7 ? Math.round(p7 / n7) : null },
    weeks: weeks.slice(-12),
    lastWeighIn: weighIns[weighIns.length - 1].d
  };
}

/** A target as the app stores it, or null. */
export function cleanTargets(t) {
  if (!t || typeof t !== 'object') return null;
  const kcal = Number(t.kcal), protein = Number(t.protein);
  if (!(kcal >= 800 && kcal <= 8000)) return null;
  return { kcal: Math.round(kcal), protein: protein >= 0 && protein <= 500 ? Math.round(protein) : null };
}

/**
 * Whether the new numbers differ from the current target enough to bother anyone with: 50 kcal
 * or 5 g of protein. Smaller moves are noise, and a target that twitches weekly is ignored.
 */
export function targetsChanged(cur, next) {
  if (!next?.kcal) return false;
  if (!cur?.kcal) return true;
  return Math.abs(next.kcal - cur.kcal) >= 50 || Math.abs((next.protein || 0) - (cur.protein || 0)) >= 5;
}

export { r1 };

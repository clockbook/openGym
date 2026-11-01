/* The weekly nutrition check-in: what the model is given, what it may say, and the proposal.
 *
 * MacroFactor's idea, with openGym's rule on top: the numbers come from the energy engine
 * (energy.js), never from the model. The model reads the engine's result and the weeks behind it
 * and explains it: a summary, one reason for the change, and notes, which is where it may suggest
 * a different weekly rate. The change card itself is built here from the engine's target, so no
 * answer, however it is worded, can move a calorie.
 */
import { CONTRACT, langTag } from './payload.js';
import { cleanTargets, targetsChanged, addDays } from './energy.js';

const DAYS_SENT = 28;
const WEEKS_SENT = 8;
const TEXT_MAX = 1200;

const isStr = v => typeof v === 'string' && v.trim().length > 0;
const clamp = (v, n) => String(v == null ? '' : v).slice(0, n);
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * The payload for a check-in job.
 * @param {object} S        the profile's state
 * @param {object} engine   runEngine's result
 * @param {object} opts     { handle, lang, days: [{ d, kcal, p }], today, sessions }
 */
export function checkinPayload(S, engine, opts = {}) {
  const today = opts.today;
  const from = addDays(today, -DAYS_SENT);
  const current = cleanTargets(S?.nutrition?.targets);
  const goal = S?.coach?.profile?.goal;
  return {
    coach_contract: CONTRACT,
    task: 'checkin',
    meta: {
      profile: opts.handle,
      lang: langTag(opts.lang) || (typeof S?.lang === 'string' ? S.lang.slice(0, 16) : '') || 'en',
      unit: 'kg',
      today
    },
    goal: {
      training: typeof goal === 'string' ? goal.slice(0, 40) : null,
      weightKg: num(Number(S?.targetW)) && S?.unit === 'lb' ? Math.round(S.targetW / 2.2046226218 * 10) / 10 : num(Number(S?.targetW)),
      rateKgPerWeek: engine.goalRate
    },
    nutrition: {
      current,
      proposed: engine.target,
      expenditure: engine.expenditure,
      confidence: engine.confidence,
      floorApplied: !!engine.floorApplied,
      trendKg: engine.trendKg,
      actualRateKgPerWeek: engine.actualRate,
      lastWeighIn: engine.lastWeighIn,
      last7: engine.last7,
      days: (opts.days || []).filter(d => d && d.d >= from && d.d < today).map(d => ({ d: d.d, kcal: d.kcal, p: d.p })),
      weeks: (engine.weeks || []).slice(-WEEKS_SENT).map(w => ({ end: w.end, expenditure: w.expenditure, trend: w.trend, logged: w.logged, weighIns: w.weighIns }))
    },
    training: { sessionsLast14Days: num(opts.sessions) ?? 0 }
  };
}

/** The model's answer: { summary, why, notes }. */
export function validateCheckin(data) {
  if (!data || typeof data !== 'object') return { ok: false, errors: ['the answer was not an object'] };
  if (!isStr(data.summary)) return { ok: false, errors: ['summary is required: 2-4 sentences on the week'] };
  return {
    ok: true,
    proposal: {
      summary: clamp(data.summary, TEXT_MAX),
      why: isStr(data.why) ? clamp(data.why, 600) : '',
      notes: (Array.isArray(data.notes) ? data.notes : []).filter(isStr).slice(0, 4).map(n => clamp(n, 600))
    }
  };
}

/**
 * What the job leaves for the person: a one-change proposal when the targets moved enough to
 * matter, or a reading when they did not. `answer` is validateCheckin's proposal.
 */
export function checkinResult(S, engine, answer, today) {
  const current = cleanTargets(S?.nutrition?.targets);
  const next = engine.target;
  const evidence = { from: addDays(today, -21), to: addDays(today, -1), sessions: null };
  if (!next?.kcal || !targetsChanged(current, next)) {
    const notes = answer.notes.length ? '\n\n' + answer.notes.map(n => '• ' + n).join('\n') : '';
    return { nochange: true, reading: clamp(answer.summary + notes, TEXT_MAX) };
  }
  return {
    proposal: {
      summary: answer.summary,
      evidence,
      changes: [{
        id: 'n1',
        type: 'nutrition-targets',
        target: {},
        before: current ? { kcal: current.kcal, protein: current.protein } : null,
        after: { kcal: next.kcal, protein: next.protein },
        why: answer.why || answer.summary.slice(0, 600)
      }],
      notes: answer.notes
    }
  };
}

/**
 * Whether a scheduled check-in is due: switched on, a Sunday where the person is, and none done
 * today. `now` is { date, hhmm, weekday } in their zone; `lastDay` the day of the last one ('' for never).
 */
export function checkinDue(S, now, lastDay) {
  if (!now || S?.nutrition?.checkin === false) return false;
  if (!S?.nutrition || typeof S.nutrition !== 'object') return false;
  // From 08:00, so the card and its notification do not arrive in the middle of the night.
  return now.weekday === 0 && String(now.hhmm || '') >= '08:00' && lastDay !== now.date;
}

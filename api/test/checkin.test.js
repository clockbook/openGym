import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkinPayload, validateCheckin, checkinResult, checkinDue } from '../coach/core/checkin.js';
import { runEngine, addDays } from '../coach/core/energy.js';

const today = '2026-11-01';
function engine() {
  const days = [], weighIns = [];
  for (let i = 42; i >= 1; i--) {
    days.push({ d: addDays(today, -i), kcal: 2300, p: 120 });
    weighIns.push({ d: addDays(today, -i), kg: 80 - (42 - i) * 0.03 });
  }
  return { days, e: runEngine({ days, weighIns, stats: { sex: 'm', birthYear: 1990, heightCm: 178, activity: 'moderate' }, today }) };
}

test('the payload carries the engine and four weeks of days, never meals', () => {
  const { days, e } = engine();
  const p = checkinPayload({ nutrition: { targets: { kcal: 2400, protein: 120 } } }, e, { handle: 'h', days, today, sessions: 5 });
  assert.equal(p.task, 'checkin');
  assert.equal(p.nutrition.days.length, 28);
  assert.deepEqual(Object.keys(p.nutrition.days[0]), ['d', 'kcal', 'p']);
  assert.deepEqual(p.nutrition.current, { kcal: 2400, protein: 120 });
  assert.deepEqual(p.nutrition.proposed, e.target);
  assert.equal(p.training.sessionsLast14Days, 5);
  assert.ok(JSON.stringify(p).length < 4000);
});

test('the answer is words only: whatever numbers it holds, the card carries the engine\'s', () => {
  const { e } = engine();
  const bad = validateCheckin({ coach_contract: 1, summary: 'Eat 900 kcal.', why: 'x', notes: ['n'], after: { kcal: 900 }, changes: [{ type: 'nutrition-targets', after: { kcal: 900 } }] });
  assert.equal(bad.ok, true);
  const r = checkinResult({ nutrition: { targets: { kcal: 3000, protein: 100 } } }, e, bad.proposal, today);
  assert.equal(r.proposal.changes.length, 1);
  assert.deepEqual(r.proposal.changes[0].after, { kcal: e.target.kcal, protein: e.target.protein });
  assert.deepEqual(r.proposal.changes[0].before, { kcal: 3000, protein: 100 });
  assert.equal(validateCheckin({ coach_contract: 1 }).ok, false);
});

test('targets that barely moved give a reading, not a card', () => {
  const { e } = engine();
  const r = checkinResult({ nutrition: { targets: { kcal: e.target.kcal + 20, protein: e.target.protein } } }, e, { summary: 'Steady week.', why: '', notes: ['Protein is short.'] }, today);
  assert.equal(r.nochange, true);
  assert.match(r.reading, /Steady week\.\n\n• Protein is short\./);
});

test('due on Sunday from 08:00, once, and not when switched off', () => {
  const S = { nutrition: {} };
  assert.equal(checkinDue(S, { date: today, hhmm: '09:00', weekday: 0 }, ''), true);
  assert.equal(checkinDue(S, { date: today, hhmm: '07:59', weekday: 0 }, ''), false);
  assert.equal(checkinDue(S, { date: today, hhmm: '09:00', weekday: 0 }, today), false);
  assert.equal(checkinDue(S, { date: '2026-11-02', hhmm: '09:00', weekday: 1 }, ''), false);
  assert.equal(checkinDue({ nutrition: { checkin: false } }, { date: today, hhmm: '09:00', weekday: 0 }, ''), false);
  assert.equal(checkinDue({}, { date: today, hhmm: '09:00', weekday: 0 }, ''), false);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNutrition, localDay, applyPayload, dailyTotals, dailyWeights } from '../nutrition.js';

// The shape HC Webhook sends (docs/webhook.md in its repo), trimmed to the fields used.
const meal = (id, start, kcal, p, extra = {}) => ({
  start_time: start, end_time: start, calories: kcal, protein_grams: p, carbs_grams: 30, fat_grams: 10,
  metadata: { id, data_origin: 'com.cronometer.android.gold', last_modified_time: start }, ...extra
});

test('a local-time stamp keeps its own day; a UTC one is shifted by its offset or the zone', () => {
  assert.equal(localDay('2026-11-01T23:30:00+11:00', null, 'UTC'), '2026-11-01');
  // 23:30 in Sydney is 12:30 UTC the same day; 01:30 Sydney is the previous day in UTC.
  assert.equal(localDay('2026-10-31T14:30:00Z', 39600, 'UTC'), '2026-11-01');
  assert.equal(localDay('2026-10-31T14:30:00Z', null, 'Australia/Sydney'), '2026-11-01');
  assert.equal(localDay('2026-10-31T14:30:00Z', null, 'UTC'), '2026-10-31');
  assert.equal(localDay('not a time', null, 'UTC'), null);
});

test('meals add up per day, an edit replaces, a deletion removes', () => {
  const s = { food: {}, weights: {} };
  applyPayload(s, { nutrition: [
    meal('a', '2026-11-01T08:00:00+11:00', 500, 40),
    meal('b', '2026-11-01T13:00:00+11:00', 700, 50),
    meal('c', '2026-11-02T08:00:00+11:00', 600, 45)
  ] });
  assert.deepEqual(dailyTotals(s).map(d => [d.d, d.kcal, d.p, d.n]), [['2026-11-01', 1200, 90, 2], ['2026-11-02', 600, 45, 1]]);
  applyPayload(s, { nutrition: [meal('b', '2026-11-01T13:00:00+11:00', 800, 55)] });
  assert.equal(dailyTotals(s)[0].kcal, 1300);
  const r = applyPayload(s, { deleted: [{ type: 'nutrition', id: 'a' }, { type: 'weight', id: 'zzz' }] });
  assert.equal(r.removed, 1);
  assert.deepEqual(dailyTotals(s).map(d => d.kcal), [800, 600]);
});

test('implausible entries and openGym\'s own weigh-ins are left out', () => {
  const s = { food: {}, weights: {} };
  const r = applyPayload(s, {
    nutrition: [meal('x', '2026-11-01T08:00:00Z', -5, 1), meal('y', '2026-11-01T08:00:00Z', 99999, 1), { start_time: 'nope' }],
    weight: [
      { kilograms: 72.4, time: '2026-11-01T07:00:00+11:00', metadata: { id: 'w1', data_origin: 'com.withings.wiscale2' } },
      { kilograms: 72.0, time: '2026-11-01T07:05:00+11:00', metadata: { id: 'w2', data_origin: 'ch.duartesantos.opengym' } },
      { kilograms: 5, time: '2026-11-01T07:00:00+11:00', metadata: { id: 'w3' } }
    ]
  });
  assert.equal(r.food, 0);
  assert.equal(r.weights, 1);
  assert.deepEqual(dailyWeights(s), [{ d: '2026-11-01', kg: 72.4 }]);
});

test('a merged daily record without an id is upserted by its start time', () => {
  const s = { food: {}, weights: {} };
  const day = { start_time: '2026-11-01T00:00:00+11:00', end_time: '2026-11-02T00:00:00+11:00', calories: 2000, protein_grams: 120 };
  applyPayload(s, { nutrition: [day] });
  applyPayload(s, { nutrition: [{ ...day, calories: 2100 }] });
  assert.deepEqual(dailyTotals(s).map(d => d.kcal), [2100]);
});

test('keys: minted, hashed on disk, replaced, and tied to one profile', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nutr-'));
  const n = createNutrition(dir);
  const k1 = n.mintKey('u1');
  assert.match(k1, /^ogn_/);
  assert.equal(n.uidForKey(k1), 'u1');
  assert.ok(!fs.readFileSync(path.join(dir, 'nutrition', 'keys.json'), 'utf8').includes(k1));
  const k2 = n.mintKey('u1');
  assert.equal(n.uidForKey(k1), null);
  assert.equal(n.uidForKey(k2), 'u1');
  assert.equal(n.uidForKey('ogn_wrong'), null);
  assert.equal(n.uidForKey(undefined), null);
  n.ingest('u1', { nutrition: [meal('a', '2026-11-01T08:00:00+11:00', 500, 40)] });
  assert.equal(dailyTotals(n.read('u1'))[0].kcal, 500);
  n.remove('u1');
  assert.equal(n.uidForKey(k2), null);
  assert.deepEqual(n.read('u1').food, {});
});

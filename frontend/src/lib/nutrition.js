// Nutrition in the app: the feed HC Webhook fills on the server (GET /api/nutrition) and the
// energy engine run over it (api/coach/core/energy.js, the same module the Sunday check-in runs).
//
// The profile's own choices live in S.nutrition and sync like every other setting:
//   { stats: { sex, birthYear, heightCm, activity }, proteinPerKg, main, checkin,
//     targets: { kcal, protein, at, by: 'checkin' | 'hand' } }
import { api } from './api.js'
import { isoOf } from './format.js'
import { runEngine, mergeWeighIns, cleanTargets, PROTEIN_PER_KG } from '../../../api/coach/core/energy.js'

export { ACTIVITY, PROTEIN_PER_KG } from '../../../api/coach/core/energy.js'

export const nutritionOf = S => (S?.nutrition && typeof S.nutrition === 'object' ? S.nutrition : {})
export const targetsOf = S => cleanTargets(nutritionOf(S).targets)
export const proteinPerKgOf = S => {
  const v = Number(nutritionOf(S).proteinPerKg)
  return v >= 0.8 && v <= 3.5 ? v : PROTEIN_PER_KG
}
/** Whether the body stats the formula needs are all there. */
export function statsComplete(S) {
  const s = nutritionOf(S).stats || {}
  return ['m', 'f'].includes(s.sex) && s.birthYear > 1900 && s.heightCm > 100 && !!s.activity
}

/* -------- the feed: fetched once per page view, shared by every card that asks -------- */

let cache = null          // { at, data }
let inflight = null
const subs = new Set()
const FRESH_MS = 60000

/** The feed from the server: { connected, lastAt, sources, days, weights }. */
export function loadNutrition({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < FRESH_MS) return Promise.resolve(cache.data)
  if (inflight) return inflight
  inflight = api('/api/nutrition')
    .then(data => { cache = { at: Date.now(), data }; subs.forEach(f => f(data)); return data })
    .finally(() => { inflight = null })
  return inflight
}
export const cachedNutrition = () => cache?.data || null
export function onNutrition(fn) { subs.add(fn); return () => subs.delete(fn) }
export function forgetNutritionCache() { cache = null }

/** A new webhook key, replacing the old one. Shown once. */
export const mintKey = () => api('/api/nutrition/key', { method: 'POST' }).then(r => { forgetNutritionCache(); return r.key })
/** Disconnect and forget everything the feed brought in. */
export const forgetFeed = () => api('/api/nutrition', { method: 'DELETE' }).then(() => { forgetNutritionCache() })

/** The URL HC Webhook posts to, for the server this app talks to. */
export function webhookUrl(base = (typeof location !== 'undefined' ? location.origin + location.pathname.replace(/\/$/, '') : '')) {
  return base.replace(/\/(index\.html)?$/, '') + '/api/nutrition/hc'
}

/** The engine over this profile and the feed, or null before the first weigh-in. */
export function engineFor(S, feed, today = isoOf(new Date())) {
  const n = nutritionOf(S)
  return runEngine({
    days: feed?.days || [],
    weighIns: mergeWeighIns(S?.bodyweight, S?.unit, feed?.weights || []),
    stats: n.stats || {},
    goal: { rateGoal: S?.rateGoal, targetW: S?.targetW, unit: S?.unit },
    proteinPerKg: proteinPerKgOf(S),
    today
  })
}

/** Set the targets (mutates `s`, for store.update). */
export function setTargets(s, { kcal, protein }, by = 'hand', at = Date.now()) {
  const t = cleanTargets({ kcal, protein })
  if (!t) return false
  s.nutrition = { ...nutritionOf(s), targets: { ...t, at, by } }
  return true
}

/** Kilograms in the profile's unit, for display. */
export const kgIn = (kg, unit) => (unit === 'lb' ? kg * 2.2046226218 : kg)

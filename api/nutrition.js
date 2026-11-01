// Food and weigh-ins that reach the server from the phone's Health Connect, by way of HC Webhook
// (github.com/mcnaveen/health-connect-webhook). A food diary such as Cronometer writes its meals
// to Health Connect; HC Webhook reads them there and POSTs them here on a schedule. openGym never
// talks to the diary itself.
//
// Kept beside a profile's state rather than inside it: the server writes this file on every push,
// and the state file belongs to the clients (their writes are merged field by field, sync-merge.js).
// A server that wrote into it would race every phone that is syncing at the time.
//
//   <DATA_DIR>/nutrition/<uid>.json   { v, food: { key: rec }, weights: { key: rec }, lastAt }
//   <DATA_DIR>/nutrition/keys.json    { sha256(key): uid }     the webhook keys, hashed
//
// A record is kept per Health Connect record id, so an edit in the diary (same id, sent again)
// replaces the old copy and a deletion (the payload's `deleted` list) removes it. Merged records
// (HC Webhook's bucketed or daily resolution) carry no id and are kept by their start time, which
// is how the HC Webhook docs say to upsert them.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWrite } from './durable.js';

const KEEP_DAYS = 400;               // a year of check-ins and then some
const MAX_FOOD = 20000;              // ~400 days at a generous 50 entries a day
const MAX_WEIGHTS = 2000;
const KG_MIN = 20, KG_MAX = 400;     // as lib/health-read.js: outside this is a typo or another person
const KCAL_MAX = 20000;              // one entry; a whole day of a strongman is under this
const GRAMS_MAX = 2000;
const KEY_PREFIX = 'ogn_';

const safe = uid => String(uid).replace(/[^a-zA-Z0-9_-]/g, '');
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v, n = 80) => (typeof v === 'string' ? v.slice(0, n) : null);
const round = (v, d = 1) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

export function createNutrition(dataDir) {
  const dir = path.join(dataDir, 'nutrition');
  const fileOf = uid => path.join(dir, safe(uid) + '.json');
  const keysFile = path.join(dir, 'keys.json');
  const ensure = () => fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const readJson = (f, empty) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return empty; } };
  const empty = () => ({ v: 1, food: {}, weights: {}, lastAt: null });

  function read(uid) {
    const s = readJson(fileOf(uid), null);
    if (!s || typeof s !== 'object') return empty();
    return { ...empty(), ...s, food: s.food || {}, weights: s.weights || {} };
  }
  function write(uid, s) { ensure(); atomicWrite(fileOf(uid), JSON.stringify(s), 0o600); }

  const hash = k => crypto.createHash('sha256').update(String(k)).digest('hex');
  const readKeys = () => readJson(keysFile, {});
  const writeKeys = k => { ensure(); atomicWrite(keysFile, JSON.stringify(k), 0o600); };

  return {
    read,
    /** A fresh webhook key for `uid`, replacing any earlier one. Shown once; only its hash is kept. */
    mintKey(uid) {
      const keys = Object.fromEntries(Object.entries(readKeys()).filter(([, u]) => u !== uid));
      const key = KEY_PREFIX + crypto.randomBytes(24).toString('base64url');
      keys[hash(key)] = uid;
      writeKeys(keys);
      return key;
    },
    revokeKey(uid) {
      const keys = readKeys();
      const kept = Object.fromEntries(Object.entries(keys).filter(([, u]) => u !== uid));
      if (Object.keys(kept).length !== Object.keys(keys).length) writeKeys(kept);
    },
    hasKey: uid => Object.values(readKeys()).includes(uid),
    /** The profile a webhook key belongs to, or null. */
    uidForKey(key) {
      if (typeof key !== 'string' || !key.startsWith(KEY_PREFIX) || key.length > 100) return null;
      return readKeys()[hash(key)] || null;
    },
    /** Take one HC Webhook payload into `uid`'s store. Returns what changed. */
    ingest(uid, body, { tz, now = Date.now() } = {}) {
      const s = read(uid);
      const res = applyPayload(s, body, { tz, now });
      if (res.food || res.weights || res.removed) {
        prune(s, now);
        s.lastAt = now;
        write(uid, s);
      } else if (!s.lastAt || now - s.lastAt > 60000) {
        // An empty sync still says the connection works; written at most once a minute.
        s.lastAt = now;
        write(uid, s);
      }
      return res;
    },
    /** Forget everything this profile pushed, and its key. */
    remove(uid) {
      this.revokeKey(uid);
      try { fs.unlinkSync(fileOf(uid)); } catch { /* nothing there */ }
    }
  };
}

/* ---------------------------------- pure ---------------------------------- */

/**
 * The calendar day a record belongs to, where the person was. HC Webhook writes times either in
 * the phone's zone ("2026-11-01T19:30:00+11:00", the default for new installs) or in UTC with
 * the record's own offset beside it (`start_zone_offset_seconds`). The first carries its day in
 * its first ten characters; the second is shifted by the offset; a UTC time with no offset at all
 * falls back to the profile's own zone.
 */
export function localDay(time, offsetSec, tz) {
  if (typeof time !== 'string') return null;
  const t = Date.parse(time);
  if (!Number.isFinite(t)) return null;
  if (/[+-]\d\d:?\d\d$/.test(time) && /^\d{4}-\d\d-\d\d/.test(time)) return time.slice(0, 10);
  if (Number.isFinite(offsetSec)) return new Date(t + offsetSec * 1000).toISOString().slice(0, 10);
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
  } catch {
    return new Date(t).toISOString().slice(0, 10);
  }
}

/** One `nutrition` entry from HC Webhook as the store keeps it, or null when it is unusable. */
export function foodRecord(r, tz) {
  if (!r || typeof r !== 'object') return null;
  const m = r.metadata && typeof r.metadata === 'object' ? r.metadata : {};
  const d = localDay(r.start_time, num(m.start_zone_offset_seconds) ?? num(m.zone_offset_seconds), tz);
  if (!d) return null;
  const kcal = num(r.calories);
  const p = num(r.protein_grams), c = num(r.carbs_grams), f = num(r.fat_grams);
  if (kcal == null && p == null) return null;
  if ((kcal != null && (kcal < 0 || kcal > KCAL_MAX)) || [p, c, f].some(g => g != null && (g < 0 || g > GRAMS_MAX))) return null;
  const id = str(m.id, 120);
  return {
    key: id ? 'hc:' + id : 'at:' + str(r.start_time, 40),
    rec: {
      d, t: Date.parse(r.start_time),
      kcal: round(kcal, 1), p: round(p, 1), c: round(c, 1), f: round(f, 1),
      ...(str(r.meal_type, 12) ? { meal: str(r.meal_type, 12) } : {}),
      ...(str(m.data_origin) ? { src: str(m.data_origin) } : {})
    }
  };
}

/** One `weight` entry from HC Webhook, or null. */
export function weightRecord(r, tz) {
  if (!r || typeof r !== 'object') return null;
  const m = r.metadata && typeof r.metadata === 'object' ? r.metadata : {};
  const kg = num(r.kilograms);
  if (kg == null || kg < KG_MIN || kg > KG_MAX) return null;
  // openGym's own weigh-ins, written to Health Connect by the phone app, are already in the log.
  if (/^opengym-/.test(String(m.client_record_id || '')) || /^ch\.duartesantos\.opengym(\.|$)/.test(String(m.data_origin || ''))) return null;
  const d = localDay(r.time, num(m.zone_offset_seconds), tz);
  if (!d) return null;
  const id = str(m.id, 120);
  return { key: id ? 'hc:' + id : 'at:' + str(r.time, 40), rec: { d, t: Date.parse(r.time), kg: round(kg, 2), ...(str(m.data_origin) ? { src: str(m.data_origin) } : {}) } };
}

/** Apply a payload to a store `s` (mutated). Returns counts. */
export function applyPayload(s, body, { tz } = {}) {
  const out = { food: 0, weights: 0, removed: 0, skipped: 0 };
  if (!body || typeof body !== 'object') return out;
  for (const r of Array.isArray(body.nutrition) ? body.nutrition : []) {
    const x = foodRecord(r, tz);
    if (!x) { out.skipped++; continue; }
    s.food[x.key] = x.rec; out.food++;
  }
  for (const r of Array.isArray(body.weight) ? body.weight : []) {
    const x = weightRecord(r, tz);
    if (!x) { out.skipped++; continue; }
    s.weights[x.key] = x.rec; out.weights++;
  }
  for (const del of Array.isArray(body.deleted) ? body.deleted : []) {
    if (!del || typeof del.id !== 'string') continue;
    const k = 'hc:' + del.id.slice(0, 120);
    const bag = del.type === 'nutrition' ? s.food : del.type === 'weight' ? s.weights : null;
    if (bag && bag[k]) { delete bag[k]; out.removed++; }
  }
  return out;
}

/** Drop what is older than KEEP_DAYS, and the oldest past the caps. */
export function prune(s, now = Date.now()) {
  const cutoff = new Date(now - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
  for (const [bag, max] of [[s.food, MAX_FOOD], [s.weights, MAX_WEIGHTS]]) {
    for (const [k, r] of Object.entries(bag)) if (!r || r.d < cutoff) delete bag[k];
    const keys = Object.keys(bag);
    if (keys.length > max) keys.sort((a, b) => (bag[a].d < bag[b].d ? -1 : 1)).slice(0, keys.length - max).forEach(k => delete bag[k]);
  }
}

/** Daily totals between two days (inclusive, either may be null): [{ d, kcal, p, c, f, n }]. */
export function dailyTotals(s, from = null, to = null) {
  const days = new Map();
  for (const r of Object.values(s?.food || {})) {
    if (!r?.d || (from && r.d < from) || (to && r.d > to)) continue;
    const t = days.get(r.d) || { d: r.d, kcal: 0, p: 0, c: 0, f: 0, n: 0 };
    t.kcal += r.kcal || 0; t.p += r.p || 0; t.c += r.c || 0; t.f += r.f || 0; t.n++;
    days.set(r.d, t);
  }
  return [...days.values()]
    .map(t => ({ d: t.d, kcal: Math.round(t.kcal), p: Math.round(t.p), c: Math.round(t.c), f: Math.round(t.f), n: t.n }))
    .sort((a, b) => (a.d < b.d ? -1 : 1));
}

/** Weigh-ins from Health Connect, the latest of each day: [{ d, kg }]. */
export function dailyWeights(s, from = null) {
  const best = new Map();
  for (const r of Object.values(s?.weights || {})) {
    if (!r?.d || (from && r.d < from)) continue;
    const cur = best.get(r.d);
    if (!cur || r.t > cur.t) best.set(r.d, r);
  }
  return [...best.values()].map(r => ({ d: r.d, kg: r.kg })).sort((a, b) => (a.d < b.d ? -1 : 1));
}

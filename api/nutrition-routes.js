/* HTTP surface for the nutrition feed (nutrition.js).
 *
 * POST /api/nutrition/hc is what HC Webhook calls from the phone. It carries no session: it is
 * authenticated by the `x-api-key` header the person pasted into HC Webhook, which names the
 * profile. The other routes are the signed-in person managing their own feed.
 *
 * A factory taking server.js's helpers, like coach/routes.js, so this module imports none of the
 * closures over the db and the session secret.
 */
import { dailyTotals, dailyWeights, foodSources } from './nutrition.js';

const DAYS_BACK = 120;   // enough for a check-in window and the weight-screen card

export function nutritionRoutes({ json, readBody, readSession, readState, store, audit }) {
  const isoDaysAgo = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

  return {
    'POST /api/nutrition/hc': async (req, res) => {
      const uid = store.uidForKey(req.headers['x-api-key']);
      // The body is read either way, so a wrong key and a right one cost the same and the client
      // gets its answer instead of a reset.
      const body = await readBody(req);
      if (!uid) return json(res, 401, { error: 'unknown key' });
      const S = readState(uid) || {};
      const tz = typeof body.timezone === 'string' && body.timezone !== 'UTC' ? body.timezone : S.reminder?.tz;
      const got = store.ingest(uid, body, { tz });
      json(res, 200, { ok: true, ...got });
    },

    'GET /api/nutrition': async (req, res) => {
      const user = readSession(req);
      if (!user) return json(res, 401, { error: 'not signed in' });
      const s = store.read(user.id);
      const from = isoDaysAgo(DAYS_BACK);
      const main = readState(user.id)?.nutrition?.main || null;
      json(res, 200, {
        connected: store.hasKey(user.id),
        lastAt: s.lastAt,
        sources: foodSources(s),
        days: dailyTotals(s, from, null, { main }),
        weights: dailyWeights(s, from)
      });
    },

    // A new key replaces the old one: HC Webhook has to be given the new value.
    'POST /api/nutrition/key': async (req, res) => {
      const user = readSession(req);
      if (!user) return json(res, 401, { error: 'not signed in' });
      const key = store.mintKey(user.id);
      audit?.(req, 'nutrition.key', { user });
      json(res, 200, { key });
    },

    'DELETE /api/nutrition/key': async (req, res) => {
      const user = readSession(req);
      if (!user) return json(res, 401, { error: 'not signed in' });
      store.revokeKey(user.id);
      json(res, 200, { ok: true });
    },

    // Disconnect and forget every meal and weigh-in the feed brought in.
    'DELETE /api/nutrition': async (req, res) => {
      const user = readSession(req);
      if (!user) return json(res, 401, { error: 'not signed in' });
      store.remove(user.id);
      json(res, 200, { ok: true });
    }
  };
}

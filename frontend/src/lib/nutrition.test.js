import { describe, it, expect } from 'vitest'
import { engineFor, setTargets, targetsOf, proteinPerKgOf, statsComplete, webhookUrl } from './nutrition.js'

const S = (over = {}) => ({
  unit: 'kg',
  bodyweight: [{ d: '2026-10-01', w: 80 }, { d: '2026-10-08', w: 79.6 }, { d: '2026-10-15', w: 79.3 }],
  nutrition: { stats: { sex: 'm', birthYear: 1990, heightCm: 178, activity: 'moderate' } },
  ...over
})

describe('nutrition in the app', () => {
  it('runs the engine over typed and imported weigh-ins, typed winning', () => {
    const e = engineFor(S(), { days: [], weights: [{ d: '2026-10-15', kg: 90 }, { d: '2026-10-20', kg: 79.1 }] }, '2026-11-01')
    expect(e.lastWeighIn).toBe('2026-10-20')
    expect(e.trendKg).toBeGreaterThan(78)
    expect(e.trendKg).toBeLessThan(81)
    expect(e.confidence).toBe('formula')
    expect(e.target.kcal).toBeGreaterThan(2000)
  })

  it('reads pounds as pounds', () => {
    const lb = S({ unit: 'lb', bodyweight: [{ d: '2026-10-01', w: 176 }] })
    expect(engineFor(lb, null, '2026-10-02').trendKg).toBeCloseTo(79.8, 0)
  })

  it('stores targets in range only, and remembers who set them', () => {
    const s = S()
    expect(setTargets(s, { kcal: 500, protein: 100 })).toBe(false)
    expect(setTargets(s, { kcal: 2250.4, protein: 129.6 }, 'hand', 5)).toBe(true)
    expect(s.nutrition.targets).toEqual({ kcal: 2250, protein: 130, at: 5, by: 'hand' })
    expect(targetsOf(s)).toEqual({ kcal: 2250, protein: 130 })
    expect(s.nutrition.stats.sex).toBe('m')
  })

  it('protein per kg defaults to 1.6 and stays in a sane range', () => {
    expect(proteinPerKgOf({})).toBe(1.6)
    expect(proteinPerKgOf({ nutrition: { proteinPerKg: 2.2 } })).toBe(2.2)
    expect(proteinPerKgOf({ nutrition: { proteinPerKg: 9 } })).toBe(1.6)
  })

  it('knows when the body stats are complete', () => {
    expect(statsComplete(S())).toBe(true)
    expect(statsComplete({ nutrition: { stats: { sex: 'm' } } })).toBe(false)
  })

  it('builds the webhook URL from where the app is served, subpath included', () => {
    expect(webhookUrl('https://g10.example.net')).toBe('https://g10.example.net/api/nutrition/hc')
    expect(webhookUrl('https://example.net/gym/')).toBe('https://example.net/gym/api/nutrition/hc')
    expect(webhookUrl('https://example.net/gym/index.html')).toBe('https://example.net/gym/api/nutrition/hc')
  })
})

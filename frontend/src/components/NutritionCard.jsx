// The nutrition card on Home, under body weight: the targets, the last seven days against them,
// and what the engine reads from your data (expenditure, trend weight). Shown to a signed-in
// profile that connected a food feed or set targets; everything else gets a one-line invitation
// in Settings instead, never a card on Home.
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { t } from '../lib/i18n.js'
import { fmtNum, isoOf } from '../lib/format.js'
import { addDays } from '../../../api/coach/core/energy.js'
import { loadNutrition, onNutrition, cachedNutrition, targetsOf, engineFor, kgIn } from '../lib/nutrition.js'
import Icon from './Icon.jsx'
import { Button } from './ui.jsx'

const CONFIDENCE = {
  formula: () => t('estimated from your body stats'),
  learning: () => t('learning from your data'),
  ok: () => t('from your own data'),
}

export default function NutritionCard({ S }) {
  const nav = useNavigate()
  const [feed, setFeed] = useState(cachedNutrition)
  useEffect(() => {
    let gone = false
    loadNutrition().then(f => { if (!gone) setFeed(f) }).catch(() => {})
    const off = onNutrition(f => setFeed(f))
    return () => { gone = true; off() }
  }, [])
  const targets = targetsOf(S)
  if (!feed?.connected && !targets) return null

  const engine = feed ? engineFor(S, feed) : null
  const today = isoOf(new Date())
  const byDay = new Map((feed?.days || []).map(d => [d.d, d]))
  const week = Array.from({ length: 7 }, (_, i) => addDays(today, i - 6)).map(d => ({ d, kcal: byDay.get(d)?.kcal || 0, p: byDay.get(d)?.p || 0 }))
  const scale = Math.max(targets?.kcal || 0, ...week.map(x => x.kcal), 1) * 1.1
  const l7 = engine?.last7

  return <div className="card nutr-card">
    <div className="row between" style={{ marginBottom: 6 }}>
      <h2 style={{ margin: 0 }}>{t('Nutrition')}</h2>
      <Button size="sm" icon="gear" aria-label={t('Nutrition')} onClick={() => nav('/settings/nutrition')} />
    </div>
    <div className="row" style={{ gap: 14, alignItems: 'baseline', flexWrap: 'wrap' }}>
      <div className="big">{targets ? fmtNum(targets.kcal) : '–'} <span className="muted" style={{ fontSize: '1rem' }}>kcal</span></div>
      {targets?.protein != null && <div className="small"><b>{targets.protein} g</b> <span className="muted">{t('protein')}</span></div>}
      {!targets && <span className="small muted">{t('No targets yet')}</span>}
    </div>

    <div className="nutr-bars" role="img" aria-label={t('Calories, last 7 days')}>
      {targets && <span className="nutr-target" style={{ bottom: (targets.kcal / scale * 100) + '%' }} />}
      {week.map(x => <span key={x.d} className="nutr-bar" title={`${x.d}: ${fmtNum(x.kcal)} kcal, ${x.p} g`}
        style={{ height: Math.max(2, x.kcal / scale * 100) + '%', opacity: x.kcal ? 1 : 0.25 }} />)}
    </div>

    {l7?.days > 0 && <div className="small" style={{ marginTop: 6 }}>
      {t('Last 7 days: {0} kcal and {1} g protein a day ({2} days logged)', fmtNum(l7.kcal), l7.protein, l7.days)}
    </div>}
    {engine?.expenditure && <div className="small muted" style={{ marginTop: 4 }}>
      <Icon name="flame" style={{ fontSize: 12, color: 'var(--orange)' }} />{' '}
      {t('Expenditure {0} kcal a day', fmtNum(engine.expenditure))} · {CONFIDENCE[engine.confidence]?.() || ''}
      {engine.trendKg ? ' · ' + t('trend {0}', fmtNum(Math.round(kgIn(engine.trendKg, S.unit) * 10) / 10) + ' ' + S.unit) : ''}
    </div>}
  </div>
}

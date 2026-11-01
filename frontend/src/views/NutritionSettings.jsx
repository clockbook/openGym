// Settings → Nutrition: the food feed from Health Connect (HC Webhook), the body stats the
// expenditure formula starts from, protein, and the calorie and protein targets.
//
// The targets are what the weekly check-in proposes and the person approves in the Coach, or what
// they set here by hand. openGym cannot write them into the food diary; they are copied across.
import { useEffect, useState } from 'react'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { t } from '../lib/i18n.js'
import { fmtAgo, fmtNum } from '../lib/format.js'
import { Section, Row, Button, NumberField, Segmented, SelectRow, Switch, Stepper } from '../components/ui.jsx'
import { rateGoalSheet } from '../components/WeightRate.jsx'
import {
  loadNutrition, onNutrition, cachedNutrition, mintKey, forgetFeed, webhookUrl, nutritionOf, targetsOf,
  proteinPerKgOf, statsComplete, engineFor, setTargets, ACTIVITY
} from '../lib/nutrition.js'

const ACTIVITY_LABEL = {
  sedentary: () => t('Mostly sitting'),
  light: () => t('Lightly active'),
  moderate: () => t('Moderately active'),
  very: () => t('Very active'),
  extra: () => t('Extremely active'),
}

const patch = fn => useStore.getState().update(s => { s.nutrition = { ...nutritionOf(s) }; fn(s.nutrition) })

export default function NutritionSettingsPage() {
  const S = useStore(s => s.S)
  const [feed, setFeed] = useState(cachedNutrition)
  const [err, setErr] = useState(null)
  useEffect(() => {
    let gone = false
    loadNutrition({ force: true }).then(f => { if (!gone) setFeed(f) }).catch(e => { if (!gone) setErr(e.message || String(e)) })
    const off = onNutrition(f => setFeed(f))
    return () => { gone = true; off() }
  }, [])

  const n = nutritionOf(S)
  const stats = n.stats || {}
  const targets = targetsOf(S)
  const engine = feed ? engineFor(S, feed) : null
  const setStat = (k, v) => patch(x => { x.stats = { ...(x.stats || {}), [k]: v } })

  const status = err ? t('Couldn’t reach the server')
    : !feed ? t('Checking…')
    : !feed.connected ? t('Not connected')
    : feed.lastAt ? t('Last sync {0}', fmtAgo(feed.lastAt))
    : t('Waiting for the first sync')
  const sources = feed?.sources || []

  return <>
    <Section title={t('Food diary')} footer={t('Your food diary (Cronometer, MacroFactor…) writes to Health Connect, and the HC Webhook app sends it here. Only daily calories and protein are used.')}>
      <Row icon="cloud" iconTint="var(--blue)" title={t('Health Connect feed')} value={status} />
      <Row icon="key" iconTint="var(--orange)" title={feed?.connected ? t('New webhook key') : t('Connect HC Webhook')}
        accessory="chevron" onClick={() => keySheet(!!feed?.connected)} />
      {sources.length > 1 && <SelectRow icon="note" iconTint="var(--green)" title={t('Main food diary')}
        value={n.main || ''} onChange={v => patch(x => { x.main = v || null })}
        options={[{ value: '', label: t('Automatic') }, ...sources.filter(x => x.src).map(x => ({ value: x.src, label: x.name }))]} />}
      {sources.length > 0 && <Row icon="list" iconTint="var(--grey)" title={t('Apps sending food')}
        subtitle={sources.map(x => `${x.name}: ${x.first} – ${x.last}`).join('\n')} />}
    </Section>

    <Section title={t('Targets')} footer={t('The weekly check-in suggests new targets in the Coach. Copy them into your food diary.')}>
      <Row icon="flame" iconTint="var(--orange)" title={t('Calories')} value={targets ? fmtNum(targets.kcal) + ' kcal' : t('Not set')} />
      <Row icon="bolt" iconTint="var(--purple)" title={t('Protein')} value={targets?.protein != null ? targets.protein + ' g' : t('Not set')} />
      {engine?.target?.kcal && <Row icon="calculator" iconTint="var(--green)" title={t('Suggested now')}
        value={fmtNum(engine.target.kcal) + ' kcal · ' + engine.target.protein + ' g'}
        subtitle={engine.expenditure ? t('Expenditure {0} kcal a day', fmtNum(engine.expenditure)) : null} />}
      <Row icon="pencil" iconTint="var(--blue)" title={t('Set targets by hand')} accessory="chevron"
        onClick={() => targetsSheet(targets || engine?.target)} />
      {engine?.target?.kcal && (!targets || targets.kcal !== engine.target.kcal || targets.protein !== engine.target.protein) &&
        <Row icon="check" iconTint="var(--green)" title={t('Use the suggested targets')} accessory="chevron"
          onClick={() => useStore.getState().update(s => setTargets(s, engine.target, 'hand'))} />}
    </Section>

    <Section title={t('About you')} footer={statsComplete(S) ? null : t('The first estimate of what you burn comes from these. After a few weeks of logging, your own data takes over.')}>
      <div className="lrow"><span className="lrow-m"><span className="lrow-t">{t('Sex')}</span></span>
        <Segmented value={stats.sex || ''} onChange={v => setStat('sex', v)}
          options={[{ value: 'm', label: t('Male') }, { value: 'f', label: t('Female') }]} /></div>
      <div className="lrow"><span className="lrow-m"><span className="lrow-t">{t('Year of birth')}</span></span>
        <NumberField value={stats.birthYear ?? null} nullable decimal={false} onChange={v => setStat('birthYear', v)} aria-label={t('Year of birth')} style={{ width: '6ch', textAlign: 'end' }} /></div>
      <div className="lrow"><span className="lrow-m"><span className="lrow-t">{t('Height')}</span></span>
        <NumberField value={stats.heightCm ?? null} nullable decimal={false} onChange={v => setStat('heightCm', v)} aria-label={t('Height')} style={{ width: '5ch', textAlign: 'end' }} /><span className="muted">cm</span></div>
      <SelectRow icon="figureRun" iconTint="var(--green)" title={t('Activity')} value={stats.activity || ''}
        onChange={v => setStat('activity', v)}
        options={Object.keys(ACTIVITY).map(k => ({ value: k, label: ACTIVITY_LABEL[k]() }))} />
    </Section>

    <Section title={t('Goal')} footer={t('Calories follow your weekly rate, or your goal weight when no rate is set.')}>
      <Row icon="chartLine" iconTint="var(--teal)" title={t('Weekly rate')} accessory="chevron" onClick={rateGoalSheet}
        value={engine ? t('{0} a week', (engine.goalRate > 0 ? '+' : '') + engine.goalRate + ' kg') : null} />
      <div className="lrow"><span className="lrow-m"><span className="lrow-t">{t('Protein per kg')}</span>
        <span className="lrow-s">{t('Of body weight. 1.6 g is a good start for building muscle.')}</span></span>
        <Stepper value={proteinPerKgOf(S)} step={0.1} min={0.8} max={3.5} onChange={v => patch(x => { x.proteinPerKg = Math.round(v * 10) / 10 })} ariaLabel={t('Protein per kg')} /></div>
      <div className="lrow"><span className="lrow-m"><span className="lrow-t">{t('Weekly check-in')}</span>
        <span className="lrow-s">{t('Every Sunday the Coach reads your week and suggests targets.')}</span></span>
        <Switch checked={n.checkin !== false} onChange={v => patch(x => { x.checkin = v })} aria-label={t('Weekly check-in')} /></div>
    </Section>

    {feed?.connected && <Section>
      <Row icon="trash" danger title={t('Disconnect and forget food data')} onClick={() => forgetSheet()} />
    </Section>}
  </>
}

/* ------------------------------- sheets ------------------------------- */

function copy(text) {
  try { navigator.clipboard?.writeText(text); useUI.getState().toast(t('Copied')) } catch { /* no clipboard */ }
}

function KeySheet({ close, replacing }) {
  const [key, setKey] = useState(null)
  const [busy, setBusy] = useState(false)
  const url = webhookUrl()
  const make = () => {
    setBusy(true)
    mintKey().then(setKey).catch(e => useUI.getState().toast(e.message || String(e))).finally(() => setBusy(false))
  }
  return <>
    <h3>{t('Connect HC Webhook')}</h3>
    <ol className="small" style={{ paddingInlineStart: 18, marginTop: 0 }}>
      <li>{t('In your food diary, turn on Health Connect and allow it to write nutrition.')}</li>
      <li>{t('In HC Webhook, allow Nutrition and Weight, and add a webhook with this URL:')}</li>
    </ol>
    <div className="row" style={{ gap: 8, marginBottom: 10 }}>
      <code className="small" style={{ wordBreak: 'break-all', flex: 1 }}>{url}</code>
      <Button size="sm" icon="copy" onClick={() => copy(url)}>{t('Copy')}</Button>
    </div>
    <ol className="small" start={3} style={{ paddingInlineStart: 18 }}>
      <li>{t('Add the header x-api-key with the key below, then run a manual sync of the past 30 days.')}</li>
    </ol>
    {key ? <>
      <div className="row" style={{ gap: 8, marginBottom: 6 }}>
        <code className="small" style={{ wordBreak: 'break-all', flex: 1 }}>{key}</code>
        <Button size="sm" icon="copy" onClick={() => copy(key)}>{t('Copy')}</Button>
      </div>
      <div className="small dim" style={{ marginBottom: 12 }}>{t('Shown once. Keep it like a password.')}</div>
    </> : <>
      {replacing && <div className="small dim" style={{ marginBottom: 10 }}>{t('A new key stops the old one from working.')}</div>}
      <Button variant="primary" icon="key" disabled={busy} onClick={make}>{t('Create key')}</Button>
      <div style={{ height: 8 }} />
    </>}
    <Button variant="ghost" className="dim" onClick={close}>{t('Done')}</Button>
  </>
}
const keySheet = replacing => useUI.getState().openSheet(close => <KeySheet close={close} replacing={replacing} />)

function TargetsSheet({ close, start }) {
  const [kcal, setKcal] = useState(start?.kcal ?? null)
  const [protein, setProtein] = useState(start?.protein ?? null)
  const save = () => {
    let ok = false
    useStore.getState().update(s => { ok = setTargets(s, { kcal, protein }, 'hand') })
    if (!ok) { useUI.getState().toast(t('Enter between 800 and 8000 kcal')); return }
    close()
  }
  return <>
    <h3>{t('Set targets by hand')}</h3>
    <div className="rate-range">
      <label className="measure-field"><span>{t('Calories')}</span>
        <span className="measure-input"><NumberField value={kcal} nullable decimal={false} onChange={setKcal} aria-label={t('Calories')} /><i>kcal</i></span></label>
      <label className="measure-field"><span>{t('Protein')}</span>
        <span className="measure-input"><NumberField value={protein} nullable decimal={false} onChange={setProtein} aria-label={t('Protein')} /><i>g</i></span></label>
    </div>
    <Button variant="primary" onClick={save}>{t('Save')}</Button>
    <div style={{ height: 8 }} />
    <Button variant="ghost" className="dim" onClick={close}>{t('Cancel')}</Button>
  </>
}
const targetsSheet = start => useUI.getState().openSheet(close => <TargetsSheet close={close} start={start} />)

function ForgetSheet({ close }) {
  const go = () => forgetFeed().then(() => { loadNutrition({ force: true }).catch(() => {}); close() })
    .catch(e => useUI.getState().toast(e.message || String(e)))
  return <>
    <h3>{t('Disconnect and forget food data')}</h3>
    <div className="muted small" style={{ marginBottom: 12 }}>{t('Removes the webhook key and every meal and weigh-in HC Webhook sent. Your food diary keeps its own copy.')}</div>
    <Button variant="danger" onClick={go}>{t('Disconnect')}</Button>
    <div style={{ height: 8 }} />
    <Button variant="ghost" className="dim" onClick={close}>{t('Cancel')}</Button>
  </>
}
const forgetSheet = () => useUI.getState().openSheet(close => <ForgetSheet close={close} />)

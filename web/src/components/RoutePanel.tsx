import { useEffect, useState } from 'react'
import type { PlannedRoute } from '../types'
import { sanitizeUserFacingScore } from '../mockData'
import { getRouteSpeechSummary, pauseSpeaking, resumeSpeaking, speak, stopSpeaking } from '../lib/speech'

const STEP_META = {
  walk: {
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="5" r="1"/><path d="m9 20 3-6 3 6"/><path d="m6 8 6 2 6-2"/>
      </svg>
    ),
    label: '步行',
    color: 'var(--walk-color)',
    bg: 'var(--walk-bg)',
    dot: 'var(--walk-color)',
  },
  mrt: {
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="4" y="3" width="16" height="16" rx="2"/><path d="M4 11h16"/><path d="M12 3v8"/>
        <circle cx="8" cy="19" r="2"/><circle cx="16" cy="19" r="2"/>
        <path d="M8 17v-2"/><path d="M16 17v-2"/>
      </svg>
    ),
    label: '捷運',
    color: 'var(--mrt-color)',
    bg: 'var(--mrt-bg)',
    dot: 'var(--mrt-color)',
  },
  bus: {
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 6v6"/><path d="M15 6v6"/><path d="M2 12h19.6"/>
        <path d="M18 18h3s.5-1.7.8-2.8c.1-.4.2-.8.2-1.2 0-.4-.1-.8-.2-1.2l-1.4-5C20.1 6.8 19.1 6 18 6H4a2 2 0 0 0-2 2v10h3"/>
        <circle cx="7" cy="18" r="2"/><path d="M9 18h5"/><circle cx="16" cy="18" r="2"/>
      </svg>
    ),
    label: '公車',
    color: 'var(--bus-color)',
    bg: 'var(--bus-bg)',
    dot: 'var(--bus-color)',
  },
}

const ELEVATOR_ICON = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="2" width="18" height="20" rx="2" />
    <path d="M12 2v20" />
    <path d="m7 9 2-2 2 2" />
    <path d="m17 15-2 2-2-2" />
  </svg>
)

interface Props {
  routes: PlannedRoute[]
  onSelectRoute: (route: PlannedRoute) => void
  speechRate: number
  speechAutoPlay: boolean
}

export default function RoutePanel({ routes, onSelectRoute, speechRate, speechAutoPlay }: Props) {
  const recommended = routes.filter(r => !r.excluded)
  const excluded    = routes.filter(r => r.excluded)
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null)
  const [speakingRouteId, setSpeakingRouteId] = useState<string | null>(null)
  const [speechPaused, setSpeechPaused] = useState(false)

  useEffect(() => () => stopSpeaking(), [])

  useEffect(() => {
    stopSpeaking()
    setSpeakingRouteId(null)
    setSpeechPaused(false)

    const recommendedRoute = routes.find(route => !route.excluded)
    if (!speechAutoPlay || !recommendedRoute) return

    setSpeakingRouteId(recommendedRoute.id)
    const started = speak(
      getRouteSpeechSummary(recommendedRoute),
      speechRate,
      () => {
        setSpeakingRouteId(current => current === recommendedRoute.id ? null : current)
        setSpeechPaused(false)
      },
    )
    if (!started) setSpeakingRouteId(null)
  }, [routes, speechAutoPlay, speechRate])

  const toggleRouteSpeech = (route: PlannedRoute) => {
    if (speakingRouteId === route.id) {
      if (speechPaused) {
        resumeSpeaking()
        setSpeechPaused(false)
      } else {
        pauseSpeaking()
        setSpeechPaused(true)
      }
      return
    }

    stopSpeaking()
    setSpeechPaused(false)
    setSpeakingRouteId(route.id)
    const started = speak(
      getRouteSpeechSummary(route),
      speechRate,
      () => {
        setSpeakingRouteId(current => current === route.id ? null : current)
        setSpeechPaused(false)
      },
    )
    if (!started) setSpeakingRouteId(null)
  }

  // ── 空白狀態 ──────────────────────────────────────────────────────────────
  if (routes.length === 0) {
    return (
      <div style={{
        height: '100%', minHeight: 0, background: 'var(--bg-base)',
      }}>
        <span className="sr-only" role="status">尚未產生路線，請先與路線助理對話。</span>
      </div>
    )
  }

  // ── 有路線 ────────────────────────────────────────────────────────────────
  return (
    <div
      className="route-panel-scroll"
      tabIndex={0}
      aria-label="路線建議，可上下捲動"
      style={{
      position: 'absolute', inset: 0,
      background: 'var(--bg-base)',
      padding: '20px 20px 32px',
      display: 'flex', flexDirection: 'column', gap: 16,
    }}>

      {/* 行程起訖資訊 */}
      <JourneyCard from={routes[0].from} to={routes[0].to} />

      {/* 先比較，再看單一路線的完整步驟 */}
      {recommended.length > 0 && (
        <>
          <SectionHeading
            title="推薦路線比較"
            detail={`${recommended.length} 條可行路線・點選即可切換詳情`}
          />

          <div className="route-comparison" role="list" aria-label="推薦路線比較">
            {recommended.map((route, index) => {
              const expanded = route.id === selectedRouteId
              return (
                <div
                  key={route.id}
                  className={`route-option-group${expanded ? ' is-expanded' : ''}`}
                  role="listitem"
                >
                  <RouteSummary
                    route={route}
                    recommended={index === 0}
                    selected={expanded}
                    onShowDetails={() => setSelectedRouteId(current => current === route.id ? null : route.id)}
                    onSelect={() => onSelectRoute(route)}
                    speaking={speakingRouteId === route.id}
                    speechPaused={speakingRouteId === route.id && speechPaused}
                    onSpeak={() => toggleRouteSpeech(route)}
                  />
                  {expanded && (
                    <div id={`route-details-${route.id}`} className="route-expanded-detail">
                      <RouteCard
                        route={route}
                        onSelect={() => onSelectRoute(route)}
                        embedded
                      />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}

      {/* 不建議路線 */}
      {excluded.length > 0 && (
        <>
          <Divider label="不建議選擇" />
          {excluded.map(route => (
            <ExcludedCard key={route.id} route={route} onSelect={() => onSelectRoute(route)} />
          ))}
        </>
      )}
    </div>
  )
}

// ── 區段標題 ────────────────────────────────────────────────────────────────
function SectionHeading({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="route-section-heading">
      <span>{title}</span>
      <small>{detail}</small>
    </div>
  )
}

function getRouteDisplayName(route: PlannedRoute) {
  const transitSteps = route.steps.filter(step => step.type !== 'walk')
  const transitTypes = [...new Set(transitSteps.map(step => step.type))]

  if (transitTypes.length > 1) return '捷運＋公車轉乘'

  const mrtSteps = transitSteps.filter(step => step.type === 'mrt')
  if (mrtSteps.length > 0) {
    const lines = [...new Set(mrtSteps.map(step => step.line).filter(Boolean))]
    const lineName = lines.length === 1 ? lines[0] : '捷運'
    return `${lineName}${route.segments <= 1 ? '直達' : '轉乘'}`
  }

  const busStep = transitSteps.find(step => step.type === 'bus')
  if (busStep) {
    const lineName = busStep.line?.replace(/(\d+)\s*路/, '$1 路') ?? ''
    const isLowFloor = `${busStep.description}${busStep.detail ?? ''}`.includes('低地板')
    return `${lineName}${isLowFloor ? '低地板' : ''}公車`
  }

  return '步行路線'
}

function SpeakerIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
    </svg>
  )
}

function PauseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="5" y="4" width="5" height="16" rx="1" />
      <rect x="14" y="4" width="5" height="16" rx="1" />
    </svg>
  )
}

// ── 路線比較摘要 ────────────────────────────────────────────────────────────
function RouteSummary({
  route,
  recommended,
  selected,
  onShowDetails,
  onSelect,
  onSpeak,
  speaking,
  speechPaused,
}: {
  route: PlannedRoute
  recommended: boolean
  selected: boolean
  onShowDetails: () => void
  onSelect: () => void
  onSpeak: () => void
  speaking: boolean
  speechPaused: boolean
}) {
  const transferLabel = route.segments <= 1 ? '免轉乘' : `${route.segments - 1} 次轉乘`
  const displayName = getRouteDisplayName(route)

  return (
    <article className={`route-summary-card${selected ? ' is-selected' : ''}`}>
      <button
        type="button"
        className="route-summary-select"
        onClick={onShowDetails}
        aria-pressed={selected}
        aria-expanded={selected}
        aria-controls={`route-details-${route.id}`}
        aria-label={`查看${route.label}完整步驟`}
      >
        <span className="route-summary-primary">
          <span className="route-summary-topline">
            <span className="route-summary-name">{displayName}</span>
            {recommended && <span className="route-best-badge">首選</span>}
          </span>
          <span className="route-code-badge">{route.label}</span>
          <span className="route-summary-time">
            <strong>{route.totalMinutes}</strong> 分鐘
          </span>
        </span>

        <span className="route-summary-middle">
          <span className="route-mode-chain" aria-label="交通方式">
            {route.steps.map((step, index) => {
              const meta = STEP_META[step.type]
              return (
                <span key={`${step.type}-${index}`} className="route-mode-item">
                  <span className="route-mode-icon" style={{ color: meta.color }}>{meta.icon}</span>
                  {meta.label}
                  <span className="route-mode-duration">{step.duration} 分</span>
                  {index < route.steps.length - 1 && <span className="route-mode-arrow">→</span>}
                </span>
              )
            })}
          </span>

          <span className="route-summary-meta-row">
            <span className="route-summary-meta">
              <span>{transferLabel}</span>
              {route.fullyAccessible && <span>全程無障礙</span>}
            </span>
            <span className="route-summary-cue">{selected ? '收合詳情' : '查看詳情'}</span>
          </span>
        </span>
      </button>

      <span className="route-summary-actions">
        <button
          type="button"
          className={`route-summary-speak${speaking ? ' is-speaking' : ''}`}
          onClick={onSpeak}
          aria-label={speechPaused ? `繼續朗讀${route.label}` : speaking ? `暫停朗讀${route.label}` : `朗讀${route.label}重點`}
          aria-pressed={speaking}
        >
          {speaking && !speechPaused ? <PauseIcon /> : <SpeakerIcon />}
          <span>{speechPaused ? '繼續' : speaking ? '暫停' : '朗讀'}</span>
        </button>
        <button type="button" className="route-summary-map" onClick={onSelect} aria-label={`在 3D 地圖上查看${route.label}`}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>
          </svg>
          <span>3D 地圖</span>
        </button>
      </span>
    </article>
  )
}

// ── 行程起訖卡 ──────────────────────────────────────────────────────────────
function JourneyCard({ from, to }: { from: string; to: string }) {
  return (
    <div className="journey-card" aria-label={`行程從${from}到${to}`}>
      <div className="journey-card-icon" aria-hidden="true">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="6" cy="5" r="2" />
          <circle cx="18" cy="19" r="2" />
          <path d="M6 7v3a4 4 0 0 0 4 4h4a4 4 0 0 1 4 4v-1" />
        </svg>
      </div>
      <div className="journey-endpoint">
        <small>起點</small>
        <strong>{from}</strong>
      </div>
      <svg className="journey-arrow" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M5 12h14" /><path d="m15 8 4 4-4 4" />
      </svg>
      <div className="journey-endpoint">
        <small>終點</small>
        <strong>{to}</strong>
      </div>
    </div>
  )
}

// ── 分隔線 ────────────────────────────────────────────────────────────────────
function Divider({ label }: { label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '4px 0 0' }}>
      <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
      <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{label}</span>
      <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
    </div>
  )
}

// ── 推薦路線卡 ────────────────────────────────────────────────────────────────
function RouteCard({ route, onSelect, embedded = false }: { route: PlannedRoute; onSelect: () => void; embedded?: boolean }) {
  const userFacingReason = sanitizeUserFacingScore(route.reason)
  const ttsText = getRouteSpeechSummary(route)

  return (
    <div className={embedded ? 'route-detail-card is-embedded' : 'route-detail-card'} style={{
      background: 'var(--bg-card)', border: '1.5px solid var(--border)',
      borderRadius: 16, overflow: 'hidden', boxShadow: 'var(--shadow-xs)',
    }}>
      {/* Header */}
      {!embedded && <div style={{
        padding: '14px 16px 12px',
        borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>{route.label}</span>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 20, fontWeight: 800, color: 'var(--green)', letterSpacing: '-0.5px' }}>
          {route.totalMinutes}
        </span>
        <span style={{ fontSize: 12, color: 'var(--text-muted)', marginRight: 8 }}>分鐘</span>
        <button onClick={() => speak(ttsText)} title="朗讀路線" style={{
          width: 28, height: 28, borderRadius: 8,
          background: 'var(--green-light)', border: '1px solid var(--border)',
          color: 'var(--green)', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
          </svg>
        </button>
        <button
          type="button"
          onClick={onSelect}
          aria-label={`在 3D 地圖上查看${route.label}`}
          style={{
            height: 28, padding: '0 10px', borderRadius: 8,
            background: 'var(--green)', border: '1px solid var(--green)',
            color: '#fff', cursor: 'pointer', fontFamily: 'inherit',
            display: 'inline-flex', alignItems: 'center', gap: 5,
            fontSize: 11.5, fontWeight: 600, flexShrink: 0,
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>
          </svg>
          3D 地圖
        </button>
      </div>}

      {/* 步驟時間軸 */}
      <div style={{ padding: '16px 16px 12px', display: 'flex', flexDirection: 'column', gap: 0 }}>
        {route.steps.map((step, i) => {
          const meta = STEP_META[step.type]
          const isLast = i === route.steps.length - 1
          return (
            <div key={i} style={{ display: 'flex', gap: 12, position: 'relative' }}>
              {/* 左側時間軸 */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0, width: 20 }}>
                <div style={{
                  width: 20, height: 20, borderRadius: '50%', flexShrink: 0,
                  background: meta.bg, border: `2px solid ${meta.dot}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: meta.color, zIndex: 1,
                }}>
                  {meta.icon}
                </div>
                {!isLast && (
                  <div style={{ width: 2, flex: 1, minHeight: 20, background: 'var(--border)', margin: '2px 0' }} />
                )}
              </div>

              {/* 右側內容 */}
              <div style={{ flex: 1, paddingBottom: isLast ? 0 : 14 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 2 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: meta.color }}>{meta.label}</span>
                  {step.line && (
                    <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{step.line}</span>
                  )}
                  <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>
                    {step.duration} 分
                  </span>
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{step.description}</div>
                {step.detail && (
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.4 }}>{step.detail}</div>
                )}
                {step.hasElevator && (
                  <div style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 4,
                    background: 'var(--walk-bg)', color: 'var(--walk-color)',
                    fontSize: 10.5, fontWeight: 600, padding: '2px 7px', borderRadius: 5,
                  }}>
                    {ELEVATOR_ICON}
                    電梯可用
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* 路線說明 */}
      {userFacingReason && (
        <div style={{
          margin: '0 16px', padding: '10px 12px',
          background: 'var(--green-light)', borderRadius: 10,
          fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6,
          border: '1px solid var(--border)',
        }}>
          {userFacingReason}
        </div>
      )}

      {/* CTA */}
      <div style={{ padding: '14px 16px 16px' }}>
        <button
          type="button"
          onClick={onSelect}
          style={{
            width: '100%', padding: '11px 0', borderRadius: 12, border: 'none',
            background: 'var(--green)', color: '#fff', fontSize: 13.5, fontWeight: 600,
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
            transition: 'opacity 0.15s', fontFamily: 'inherit',
          }}
          onMouseEnter={e => (e.currentTarget.style.opacity = '0.85')}
          onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>
          </svg>
          在 3D 地圖上查看路線
        </button>
      </div>
    </div>
  )
}

// ── 不建議路線卡 ──────────────────────────────────────────────────────────────
// 雖然這條路線被 profile 的硬性條件排除，仍保留「在地圖上查看」的入口 ——
// 使用者（或 demo 現場）可能想看看被排除的路線實際長什麼樣，或想確認排除
// 原因是否真的是資料缺漏而非確定不可行（見 excludeReason 的說明文字）。
function ExcludedCard({ route, onSelect }: { route: PlannedRoute; onSelect: () => void }) {
  return (
    <div style={{
      background: 'var(--bg-card)', border: '1.5px solid var(--danger-border)',
      borderRadius: 16, overflow: 'hidden',
    }}>
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid var(--danger-border)',
        display: 'flex', alignItems: 'center', gap: 8,
        background: 'var(--danger-bg)',
      }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
        </svg>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--danger)' }}>{route.label}</span>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--danger)' }}>{route.totalMinutes} 分鐘</span>
        <button
          type="button"
          onClick={onSelect}
          aria-label={`仍在 3D 地圖上查看${route.label}`}
          style={{
            height: 26, padding: '0 9px', borderRadius: 7,
            background: 'transparent', border: '1px solid var(--danger-border)',
            color: 'var(--danger)', cursor: 'pointer', fontFamily: 'inherit',
            display: 'inline-flex', alignItems: 'center', gap: 4,
            fontSize: 11, fontWeight: 600, flexShrink: 0,
          }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>
          </svg>
          仍要查看
        </button>
      </div>

      {/* 簡化步驟 */}
      <div style={{ padding: '12px 16px', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {route.steps.map((step, i) => {
          const meta = STEP_META[step.type]
          return (
            <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                background: meta.bg, color: meta.color,
                borderRadius: 6, padding: '3px 9px', fontSize: 11.5, fontWeight: 600,
                opacity: step.accessible ? 1 : 0.45,
                textDecoration: step.accessible ? 'none' : 'line-through',
              }}>
                {meta.icon}<span>{meta.label}</span><span>{step.duration} 分</span>
              </span>
              {i < route.steps.length - 1 && (
                <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>→</span>
              )}
            </span>
          )
        })}
      </div>

      {route.excludeReason && (
        <div style={{
          margin: '0 16px 14px',
          padding: '10px 12px', borderRadius: 10,
          background: 'var(--danger-bg)', border: '1px solid var(--danger-border)',
          fontSize: 12, color: 'var(--danger)', lineHeight: 1.6,
        }}>
          <span style={{ fontWeight: 700 }}>不建議原因：</span>{route.excludeReason}
        </div>
      )}
    </div>
  )
}

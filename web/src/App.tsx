import { useState, useCallback, useRef, useEffect } from 'react'
import { Map3D } from './components/Map3D'
import type { MapStatus } from './components/Map3D'
import ChatPanel from './components/ChatPanel'
import RoutePanel from './components/RoutePanel'
import SosButton from './components/SosButton'
import { BANNAN_CORRIDOR, CAMERA_PRESETS } from './data/corridor'
import type { Map3DElementLike, Maps3dLibrary } from './lib/googleMaps'
import type { AccessibilityMode, AppPhase, Message, PlannedRoute } from './types'
import type { AgentResponse } from './mockData'


export default function App() {
  const [phase, setPhase]               = useState<AppPhase>('chat')
  const [mode, setMode]                 = useState<AccessibilityMode>('general')
  const [dark, setDark]                 = useState(false)
  const [messages, setMessages]         = useState<Message[]>([])
  const [routes, setRoutes]             = useState<PlannedRoute[]>([])

  const [mapStatus, setMapStatus]       = useState<MapStatus>({ kind: 'loading' })
  const [transitioning, setTransitioning] = useState(false)

  const mapRef = useRef<Map3DElementLike | null>(null)

  // Theme
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light')
  }, [dark])

  useEffect(() => {
    document.documentElement.setAttribute('data-access', mode === 'visual' ? 'visual' : '')
  }, [mode])

  // Map ready: 添加捷運站標記
  const handleMapReady = useCallback((map: Map3DElementLike, lib: Maps3dLibrary) => {
    mapRef.current = map
    const { Marker3DElement, AltitudeMode } = lib
    for (const station of BANNAN_CORRIDOR) {
      const marker = new Marker3DElement({
        position: station.position,
        label: station.name,
        altitudeMode: AltitudeMode?.RELATIVE_TO_GROUND ?? 'RELATIVE_TO_GROUND',
        extruded: true,
      })
      map.append(marker)
    }
  }, [])

  // 訊息
  const addMessage = (msg: Message) => setMessages(prev => [...prev, msg])

  // Agent 回覆處理（後端 API 或 mock 降級）
  const handleAgentResponse = useCallback((res: AgentResponse) => {
    if (res.detectedMode) setMode(res.detectedMode)
    if (res.routesReady && res.routes) {
      setRoutes(res.routes)
    }

    // 執行後端 agent 的相機指令
    if (res.chatResponse?.camera_commands) {
      for (const cmd of res.chatResponse.camera_commands) {
        if (!mapRef.current) break
        if (cmd.action === 'fly_to' && cmd.center) {
          mapRef.current.flyCameraTo({
            endCamera: {
              center: { lat: cmd.center.lat, lng: cmd.center.lng, altitude: cmd.center.altitude ?? 0 },
              range: cmd.range ?? 800,
              tilt: cmd.tilt ?? 67.5,
              heading: cmd.heading ?? 0,
            },
            durationMillis: 2500,
          })
        } else if (cmd.action === 'orbit' && cmd.center) {
          mapRef.current.flyCameraAround({
            camera: {
              center: { lat: cmd.center.lat, lng: cmd.center.lng, altitude: cmd.center.altitude ?? 0 },
              range: cmd.range ?? 800,
              tilt: cmd.tilt ?? 67.5,
              heading: cmd.heading ?? 0,
            },
            durationMillis: 12000,
            rounds: 1,
          })
        }
      }
    }
  }, [mapRef])

  // 選擇路線 → 切換到地圖
  const handleSelectRoute = (_route: PlannedRoute) => {
    setTransitioning(true)
    setTimeout(() => {
      setPhase('map')
      setTransitioning(false)
      // 地圖就緒後飛到走廊視角
      setTimeout(() => {
        const preset = CAMERA_PRESETS.find(p => p.id === 'corridor')
        if (preset && mapRef.current) {
          mapRef.current.flyCameraTo({
            endCamera: { center: preset.center, range: preset.range, tilt: preset.tilt, heading: preset.heading },
            durationMillis: 2500,
          })
        }
      }, 500)
    }, 260)
  }

  // 返回對話
  const handleBackToChat = () => {
    setTransitioning(true)
    setTimeout(() => { setPhase('chat'); setTransitioning(false) }, 220)
  }

  // 步驟切換 → 飛到對應站點
  // 同學的相機控制（完整保留）
  const [activePreset, setActivePreset] = useState<string>('cityHall')

  const flyTo = useCallback((preset: (typeof CAMERA_PRESETS)[number]) => {
    if (!mapRef.current) return
    setActivePreset(preset.id)
    mapRef.current.flyCameraTo({
      endCamera: { center: preset.center, range: preset.range, tilt: preset.tilt, heading: preset.heading },
      durationMillis: 2500,
    })
  }, [])

  const orbit = useCallback(() => {
    if (!mapRef.current) return
    const preset = CAMERA_PRESETS.find(p => p.id === activePreset) ?? CAMERA_PRESETS[1]
    mapRef.current.flyCameraAround({
      camera: { center: preset.center, range: preset.range, tilt: preset.tilt, heading: preset.heading },
      durationMillis: 12000,
      rounds: 1,
    })
  }, [activePreset])

  // ── 渲染 ──────────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--bg-base)', overflow: 'hidden' }}>

      {/* ── Header（只在對話階段顯示）── */}
      {phase === 'chat' && (
        <header style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '0 20px', height: 64, flexShrink: 0,
          background: 'var(--bg-card)', borderBottom: '1.5px solid var(--border)',
          boxShadow: 'var(--shadow-xs)',
        }}>
          {/* Logo */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <div className="header-logo-mark" aria-hidden="true">
              <img src="/logo.png?v=2" alt="" />
            </div>
            <div>
              <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '0.2px' }}>Taipei Pulse</span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 8 }}>無障礙路線</span>
            </div>
          </div>

          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
            {/* 暗色切換 */}
            <button onClick={() => setDark(d => !d)} style={{
              width: 30, height: 30, borderRadius: 8,
              background: 'transparent', border: '1.5px solid var(--border)',
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--text-muted)', transition: 'all 0.15s',
            }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--green)'; e.currentTarget.style.color = 'var(--green)' }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-muted)' }}
            >
              {dark
                ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>
                : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>
              }
            </button>
          </div>
        </header>
      )}

      {/* ── Main ── */}
      <main style={{
        flex: 1, minHeight: 0, overflow: 'hidden', position: 'relative',
        opacity: transitioning ? 0 : 1,
        transition: 'opacity 0.22s ease',
      }}>

        {/* ── 對話階段：左右分欄 ── */}
        {phase === 'chat' && (
          <div style={{ display: 'grid', gridTemplateColumns: '42% 1fr', height: '100%', minHeight: 0 }}>
            {/* overflow:hidden on grid children → creates BFC → min-height:0 behaviour */}
            <div style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <ChatPanel
                mode={mode}
                messages={messages}
                onAddMessage={addMessage}
                onAgentResponse={handleAgentResponse}
              />
            </div>
            <div style={{ position: 'relative', minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
              <RoutePanel
                routes={routes}
                onSelectRoute={handleSelectRoute}
              />
            </div>
          </div>
        )}

        {/* ── 地圖階段：同學的原版 layout ── */}
        {phase === 'map' && (
          <div className="app">
            <header className="app-header">
              <h1>Taipei Pulse</h1>
              <p className="app-tagline">無障礙大眾運輸 3D 導引 · 板南線示範走廊</p>
              <span className={`status-pill status-${mapStatus.kind}`}>
                {mapStatus.kind === 'loading' && '載入中'}
                {mapStatus.kind === 'ready' && '3D 地圖就緒'}
                {mapStatus.kind === 'error' && '載入失敗'}
              </span>
            </header>

            <main className="app-body">
              <Map3D onReady={handleMapReady} onStatusChange={setMapStatus} />
            </main>

            <nav className="camera-bar" aria-label="相機定位">
              {CAMERA_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => flyTo(preset)}
                  disabled={mapStatus.kind !== 'ready'}
                  aria-pressed={activePreset === preset.id}
                  className={activePreset === preset.id ? 'is-active' : undefined}
                >
                  {preset.label}
                </button>
              ))}
              <button type="button" onClick={orbit} disabled={mapStatus.kind !== 'ready'}>
                環繞一圈
              </button>
              <button
                type="button"
                onClick={handleBackToChat}
                className="back-btn"
              >
                ← 返回對話
              </button>
            </nav>
          </div>
        )}
      </main>

      {/* ── 高齡模式 SOS ── */}
      {mode === 'elderly' && <SosButton />}
    </div>
  )
}

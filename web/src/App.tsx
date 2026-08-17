import { useState, useCallback, useRef, useEffect } from 'react'
import { Map3D } from './components/Map3D'
import type { MapStatus } from './components/Map3D'
import ChatPanel from './components/ChatPanel'
import RoutePanel from './components/RoutePanel'
import SosButton from './components/SosButton'
import { BANNAN_CORRIDOR, CAMERA_PRESETS } from './data/corridor'
import type { Map3DElementLike, Maps3dLibrary } from './lib/googleMaps'
import {
  buildRouteTourTimeline,
  routeTourFrameAt,
  smoothHeading,
  type RouteTourTimeline,
  type TourMode,
} from './lib/routeTour'
import type { AccessibilityMode, AppPhase, Message, PlannedRoute } from './types'
import type { AgentResponse } from './mockData'
import { getSpeechRate, setSpeechRate as persistSpeechRate, SPEECH_RATES, stopSpeaking } from './lib/speech'
import {
  audibleSignalsNearRoute,
  curbRampsNearRoute,
  facilityDescription,
  loadAccessibilityFacilities,
  metroFacilitiesNearRoute,
  type AccessibilityFacility,
} from './lib/accessibilityFacilities'

const ROUTE_COLORS: Record<PlannedRoute['steps'][number]['type'], string> = {
  walk: '#34A853',
  mrt: '#1A73E8',
  bus: '#F29900',
}

const TOUR_MODE_LABELS: Record<TourMode, string> = {
  walk: '步行視角',
  mrt: '捷運移動',
  bus: '公車移動',
}

const TOUR_MODE_SHORT_LABELS: Record<TourMode, string> = {
  walk: '步行',
  mrt: '捷運',
  bus: '公車',
}

const TOUR_SPEEDS = [0.5, 1, 1.5, 2] as const

const TOUR_CAMERA: Record<TourMode, { altitude: number; range: number; tilt: number; fov: number }> = {
  // Walking geometry can pass beside or through station photogrammetry. Keep
  // the camera directly over the route, but high enough to clear those meshes.
  walk: { altitude: 28, range: 58, tilt: 72, fov: 70 },
  // Subway geometry is underground while Photorealistic 3D Maps only renders
  // the city surface. Follow it cinematically above rooftops instead of flying
  // the camera through buildings that are not part of the journey.
  mrt: { altitude: 75, range: 230, tilt: 68, fov: 60 },
  // Bus seed geometry is less detailed than walking geometry, so keep enough
  // height to preserve context and avoid facade clipping.
  bus: { altitude: 38, range: 150, tilt: 72, fov: 64 },
}

const TOUR_WALK_ENTRY_CAMERA = { altitude: 38, range: 74, tilt: 68, fov: 70 }

function cameraForTourFrame(mode: TourMode, stepIndex: number) {
  // The first walking leg starts beside Taipei Main Station's large roof mesh;
  // stay above it, then drop closer to street level for later walking legs.
  return mode === 'walk' && stepIndex === 0 ? TOUR_WALK_ENTRY_CAMERA : TOUR_CAMERA[mode]
}

function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const meanLat = (a.lat + b.lat) / 2 * Math.PI / 180
  const dx = (a.lng - b.lng) * 111_320 * Math.cos(meanLat)
  const dy = (a.lat - b.lat) * 110_574
  return Math.hypot(dx, dy)
}

const TOUR_FACILITY_RADIUS: Record<TourMode, Record<AccessibilityFacility['kind'], number>> = {
  walk: { metro_exit: 120, metro_access: 110, curb_ramp: 65, public_toilet: 140, audible_signal: 80 },
  mrt: { metro_exit: 240, metro_access: 210, curb_ramp: 0, public_toilet: 0, audible_signal: 0 },
  bus: { metro_exit: 0, metro_access: 0, curb_ramp: 90, public_toilet: 110, audible_signal: 0 },
}

function drawRoute(
  map: Map3DElementLike,
  lib: Maps3dLibrary,
  route: PlannedRoute,
): HTMLElement[] {
  const { Polyline3DElement, AltitudeMode } = lib

  return route.steps.flatMap((step, index) => {
    if (!step.path || step.path.length < 2) return []

    // Walking stays just above the road surface. Transit lines are lifted so
    // they read as a clear journey layer instead of cutting through 3D meshes.
    const lineAltitude = step.type === 'mrt' ? 36 : step.type === 'bus' ? 8 : 2.8
    const path = step.path.map(({ lat, lng }) => ({ lat, lng, altitude: lineAltitude }))
    const line = new Polyline3DElement({
      path,
      strokeColor: ROUTE_COLORS[step.type],
      strokeWidth: step.type === 'mrt' ? 10 : step.type === 'walk' ? 9 : 7,
      outerColor: '#FFFFFF',
      outerWidth: step.type === 'mrt' ? 0.36 : 0.28,
      altitudeMode: AltitudeMode?.RELATIVE_TO_GROUND ?? 'RELATIVE_TO_GROUND',
      drawsOccludedSegments: true,
      geodesic: true,
      zIndex: 100 + index,
    })
    map.append(line)
    return [line]
  })
}


export default function App() {
  const [phase, setPhase]               = useState<AppPhase>('chat')
  const [mode, setMode]                 = useState<AccessibilityMode>('general')
  const [dark, setDark]                 = useState(false)
  const [mapNightMode, setMapNightMode] = useState(false)
  const [speechRate, setSpeechRate]     = useState(getSpeechRate)
  const [speechAutoPlay, setSpeechAutoPlay] = useState(
    () => window.localStorage.getItem('taipei-pulse-speech-auto-play') !== 'false',
  )
  const [messages, setMessages]         = useState<Message[]>([])
  const [routes, setRoutes]             = useState<PlannedRoute[]>([])
  const [selectedRoute, setSelectedRoute] = useState<PlannedRoute | null>(null)
  const autoNarratedRoutesRef = useRef<PlannedRoute[] | null>(null)

  const [mapStatus, setMapStatus]       = useState<MapStatus>({ kind: 'loading' })
  const [transitioning, setTransitioning] = useState(false)

  const mapRef = useRef<Map3DElementLike | null>(null)
  const selectedRouteRef = useRef<PlannedRoute | null>(null)
  const routeLinesRef = useRef<HTMLElement[]>([])
  const accessibilityMarkersRef = useRef<Record<AccessibilityFacility['kind'], HTMLElement[]>>({
    metro_exit: [],
    metro_access: [],
    curb_ramp: [],
    public_toilet: [],
    audible_signal: [],
  })
  const facilityByMarkerRef = useRef(new Map<HTMLElement, AccessibilityFacility>())
  const visibleFacilityLayersRef = useRef({ metro_exit: true, metro_access: false, curb_ramp: false, public_toilet: false, audible_signal: false })
  const tourTimelineRef = useRef<RouteTourTimeline | null>(null)
  const tourFrameRef = useRef<number | null>(null)
  const tourLaunchTimeoutRef = useRef<number | null>(null)
  const tourLastFrameAtRef = useRef(0)
  const tourElapsedRef = useRef(0)
  const tourSpeedRef = useRef(1)
  const tourHeadingRef = useRef(0)
  const tourLastUiUpdateRef = useRef(0)
  const tourPositionRef = useRef<{ lat: number; lng: number } | null>(null)
  const tourCurrentModeRef = useRef<TourMode>('walk')
  const [tourStatus, setTourStatus] = useState<'idle' | 'running' | 'paused' | 'completed'>('idle')
  const [tourProgress, setTourProgress] = useState(0)
  const [tourMode, setTourMode] = useState<TourMode>('walk')
  const [tourStepIndex, setTourStepIndex] = useState(0)
  const [tourSpeed, setTourSpeed] = useState(1)
  const [selectedFacility, setSelectedFacility] = useState<AccessibilityFacility | null>(null)
  const [facilityPopoverPosition, setFacilityPopoverPosition] = useState<{ left: number; top: number; width: number } | null>(null)
  const [visibleFacilityLayers, setVisibleFacilityLayers] = useState({ metro_exit: true, metro_access: false, curb_ramp: false, public_toilet: false, audible_signal: false })

  const changeSpeechRate = (rate: number) => {
    stopSpeaking()
    setSpeechRate(rate)
    persistSpeechRate(rate)
  }
  const changeSpeechAutoPlay = (enabled: boolean) => {
    if (!enabled) stopSpeaking()
    setSpeechAutoPlay(enabled)
    window.localStorage.setItem('taipei-pulse-speech-auto-play', String(enabled))
  }
  const cancelTourTimers = useCallback(() => {
    if (tourFrameRef.current !== null) {
      window.cancelAnimationFrame(tourFrameRef.current)
      tourFrameRef.current = null
    }
    if (tourLaunchTimeoutRef.current !== null) {
      window.clearTimeout(tourLaunchTimeoutRef.current)
      tourLaunchTimeoutRef.current = null
    }
  }, [])

  const setFacilityLayerVisibility = useCallback((kind: AccessibilityFacility['kind'], visible: boolean) => {
    const next = { ...visibleFacilityLayersRef.current, [kind]: visible }
    visibleFacilityLayersRef.current = next
    setVisibleFacilityLayers(next)
    for (const marker of accessibilityMarkersRef.current[kind]) {
      if (visible && !tourTimelineRef.current) mapRef.current?.append(marker)
      else marker.remove()
    }
    if (!visible) {
      setSelectedFacility(previous => previous?.kind === kind ? null : previous)
      setFacilityPopoverPosition(null)
    }
  }, [])

  const syncTourFacilityMarkers = useCallback((position: { lat: number; lng: number }, tourModeNow: TourMode) => {
    const map = mapRef.current
    if (!map) return
    tourPositionRef.current = position
    tourCurrentModeRef.current = tourModeNow

    for (const kind of ['metro_exit', 'metro_access', 'curb_ramp', 'public_toilet', 'audible_signal'] as const) {
      const radius = TOUR_FACILITY_RADIUS[tourModeNow][kind]
      for (const marker of accessibilityMarkersRef.current[kind]) {
        const facility = facilityByMarkerRef.current.get(marker)
        const shouldShow = Boolean(
          facility
          && visibleFacilityLayersRef.current[kind]
          && radius > 0
          && distanceMeters(position, facility) <= radius,
        )
        if (shouldShow && marker.parentElement !== map) map.append(marker)
        if (!shouldShow && marker.parentElement === map) marker.remove()
      }
    }

    setSelectedFacility(previous => {
      if (!previous) return previous
      const radius = TOUR_FACILITY_RADIUS[tourModeNow][previous.kind]
      if (radius > 0 && distanceMeters(position, previous) <= radius) return previous
      setFacilityPopoverPosition(null)
      return null
    })
  }, [])

  const stopRouteTour = useCallback(() => {
    cancelTourTimers()
    mapRef.current?.stopCameraAnimation()
    tourTimelineRef.current = null
    tourElapsedRef.current = 0
    tourLastFrameAtRef.current = 0
    tourPositionRef.current = null
    setTourProgress(0)
    setTourStepIndex(0)
    setTourStatus('idle')
  }, [cancelTourTimers])

  const animateRouteTour = useCallback((now: number) => {
    const map = mapRef.current
    const timeline = tourTimelineRef.current
    if (!map || !timeline) return

    if (tourLastFrameAtRef.current === 0) tourLastFrameAtRef.current = now
    const frameDelta = Math.min(100, now - tourLastFrameAtRef.current)
    tourLastFrameAtRef.current = now
    const elapsed = tourElapsedRef.current + frameDelta * tourSpeedRef.current
    tourElapsedRef.current = elapsed
    const frame = routeTourFrameAt(timeline, elapsed)
    const camera = cameraForTourFrame(frame.mode, frame.stepIndex)
    tourHeadingRef.current = smoothHeading(tourHeadingRef.current, frame.heading)

    // A low, forward-looking chase camera. Direct property updates avoid the
    // parabolic arc that repeated flyCameraTo calls would create.
    map.heading = tourHeadingRef.current
    map.tilt = camera.tilt
    map.range = camera.range
    map.fov = camera.fov
    if (frame.mode === 'walk') {
      // Lock the physical camera to the walking geometry. Using center alone
      // leaves it far behind the route and makes it cut across corners.
      map.cameraPosition = { ...frame.position, altitude: camera.altitude }
    } else {
      map.center = { ...frame.position, altitude: camera.altitude }
    }

    if (now - tourLastUiUpdateRef.current > 180 || frame.finished) {
      tourLastUiUpdateRef.current = now
      syncTourFacilityMarkers(frame.position, frame.mode)
      setTourProgress(frame.progress)
      setTourMode(frame.mode)
      setTourStepIndex(frame.stepIndex)
    }

    if (frame.finished) {
      tourFrameRef.current = null
      setTourStatus('completed')
      return
    }
    tourFrameRef.current = window.requestAnimationFrame(animateRouteTour)
  }, [syncTourFacilityMarkers])

  const startRouteTour = useCallback(() => {
    const map = mapRef.current
    if (!map || !selectedRouteRef.current) return

    if (tourStatus === 'paused' && tourTimelineRef.current) {
      setFacilityLayerVisibility('metro_access', true)
      setFacilityLayerVisibility('curb_ramp', true)
      setFacilityLayerVisibility('public_toilet', true)
      setFacilityLayerVisibility('audible_signal', true)
      if (tourPositionRef.current) syncTourFacilityMarkers(tourPositionRef.current, tourCurrentModeRef.current)
      tourLastFrameAtRef.current = performance.now()
      setTourStatus('running')
      tourFrameRef.current = window.requestAnimationFrame(animateRouteTour)
      return
    }

    cancelTourTimers()
    const timeline = buildRouteTourTimeline(selectedRouteRef.current)
    if (!timeline) return
    tourTimelineRef.current = timeline
    tourElapsedRef.current = 0
    tourLastFrameAtRef.current = 0
    setTourProgress(0)
    setTourMode(timeline.edges[0].mode)
    setTourStepIndex(timeline.edges[0].stepIndex)
    setTourStatus('running')

    const firstFrame = routeTourFrameAt(timeline, 0)
    // 鏡頭飛往導覽起點的過程先清空設施，抵達後才依當下視角逐批顯示，
    // 避免起點與後續站點在導覽尚未到達前搶先出現。
    setFacilityLayerVisibility('metro_access', true)
    setFacilityLayerVisibility('curb_ramp', true)
    setFacilityLayerVisibility('public_toilet', true)
    setFacilityLayerVisibility('audible_signal', true)
    for (const markers of Object.values(accessibilityMarkersRef.current)) {
      for (const marker of markers) marker.remove()
    }
    setSelectedFacility(null)
    setFacilityPopoverPosition(null)
    tourPositionRef.current = firstFrame.position
    tourCurrentModeRef.current = firstFrame.mode
    const firstCamera = cameraForTourFrame(firstFrame.mode, firstFrame.stepIndex)
    tourHeadingRef.current = firstFrame.heading
    map.stopCameraAnimation()
    map.flyCameraTo({
      endCamera: {
        cameraPosition: { ...firstFrame.position, altitude: firstCamera.altitude },
        range: firstCamera.range,
        tilt: firstCamera.tilt,
        heading: firstFrame.heading,
      },
      durationMillis: 1400,
    })
    tourLaunchTimeoutRef.current = window.setTimeout(() => {
      tourLaunchTimeoutRef.current = null
      syncTourFacilityMarkers(firstFrame.position, firstFrame.mode)
      tourLastFrameAtRef.current = performance.now()
      tourFrameRef.current = window.requestAnimationFrame(animateRouteTour)
    }, 1450)
  }, [animateRouteTour, cancelTourTimers, setFacilityLayerVisibility, syncTourFacilityMarkers, tourStatus])

  const pauseRouteTour = useCallback(() => {
    cancelTourTimers()
    mapRef.current?.stopCameraAnimation()
    setTourStatus('paused')
  }, [cancelTourTimers])

  const seekRouteTour = useCallback((elapsedMs: number) => {
    const map = mapRef.current
    const timeline = tourTimelineRef.current
    if (!map || !timeline) return

    const clamped = Math.min(Math.max(elapsedMs, 0), timeline.durationMs)
    const frame = routeTourFrameAt(timeline, clamped)
    const camera = cameraForTourFrame(frame.mode, frame.stepIndex)
    tourElapsedRef.current = clamped
    tourLastFrameAtRef.current = performance.now()
    tourHeadingRef.current = frame.heading

    map.stopCameraAnimation()
    map.heading = frame.heading
    map.tilt = camera.tilt
    map.range = camera.range
    map.fov = camera.fov
    if (frame.mode === 'walk') {
      map.cameraPosition = { ...frame.position, altitude: camera.altitude }
    } else {
      map.center = { ...frame.position, altitude: camera.altitude }
    }
    setTourProgress(frame.progress)
    setTourMode(frame.mode)
    setTourStepIndex(frame.stepIndex)
    syncTourFacilityMarkers(frame.position, frame.mode)

    if (frame.finished) {
      cancelTourTimers()
      setTourStatus('completed')
    } else if (tourStatus === 'completed') {
      setTourStatus('paused')
    }
  }, [cancelTourTimers, syncTourFacilityMarkers, tourStatus])

  const jumpToRouteStep = useCallback((stepIndex: number) => {
    const route = selectedRouteRef.current
    if (!route) return

    const timeline = tourTimelineRef.current ?? buildRouteTourTimeline(route)
    const firstEdge = timeline?.edges.find(edge => edge.stepIndex === stepIndex)
    if (!timeline || !firstEdge) return

    cancelTourTimers()
    tourTimelineRef.current = timeline
    // Move just inside the segment so a shared boundary belongs to the newly
    // selected step instead of the final edge of the previous one.
    seekRouteTour(firstEdge.startsAtMs + 1)
    setTourStatus('paused')
  }, [cancelTourTimers, seekRouteTour])

  const changeTourSpeed = useCallback((speed: number) => {
    tourSpeedRef.current = speed
    tourLastFrameAtRef.current = performance.now()
    setTourSpeed(speed)
  }, [])

  useEffect(() => () => cancelTourTimers(), [cancelTourTimers])

  // Theme
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light')
  }, [dark])

  useEffect(() => {
    document.documentElement.setAttribute('data-access', mode === 'visual' ? 'visual' : '')
  }, [mode])

  const toggleFacilityLayer = (kind: AccessibilityFacility['kind']) => {
    setFacilityLayerVisibility(kind, !visibleFacilityLayersRef.current[kind])
    if (tourTimelineRef.current && tourPositionRef.current) {
      syncTourFacilityMarkers(tourPositionRef.current, tourCurrentModeRef.current)
    }
  }

  // Map ready: 添加捷運站與政府開放資料的互動標記
  const handleMapReady = useCallback((map: Map3DElementLike, lib: Maps3dLibrary) => {
    mapRef.current = map
    accessibilityMarkersRef.current = { metro_exit: [], metro_access: [], curb_ramp: [], public_toilet: [], audible_signal: [] }
    facilityByMarkerRef.current.clear()
    const defaultLayers = { metro_exit: true, metro_access: false, curb_ramp: false, public_toilet: false, audible_signal: false }
    visibleFacilityLayersRef.current = defaultLayers
    setVisibleFacilityLayers(defaultLayers)
    setSelectedFacility(null)
    setFacilityPopoverPosition(null)
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

    void loadAccessibilityFacilities().then(bundle => {
      const metroExits = metroFacilitiesNearRoute(bundle.metroExits, selectedRouteRef.current, 110)
      const metroPoints = metroFacilitiesNearRoute(bundle.metroAccessPoints, selectedRouteRef.current, 90)
      const curbRamps = curbRampsNearRoute(bundle.curbRamps, selectedRouteRef.current, 18)
      const publicToilets = metroFacilitiesNearRoute(bundle.publicToilets, selectedRouteRef.current, 140, 100)
      const audibleSignals = audibleSignalsNearRoute(bundle.audibleSignals, selectedRouteRef.current)
      const facilities: AccessibilityFacility[] = [...metroExits, ...metroPoints, ...curbRamps, ...publicToilets, ...audibleSignals]

      for (const facility of facilities) {
        const isElevator = facility.kind === 'metro_access'
        const isExit = facility.kind === 'metro_exit'
        const isToilet = facility.kind === 'public_toilet'
        const isAudibleSignal = facility.kind === 'audible_signal'
        const badge = document.createElement('span')
        badge.className = [
          'facility-map-badge',
          `facility-map-badge-${facility.kind}`,
          (isExit || isToilet) && facility.accessible ? 'is-accessible' : '',
        ].filter(Boolean).join(' ')
        badge.textContent = isExit
          ? facility.exit
          : isElevator
            ? '↕'
            : isToilet
              ? 'WC'
              : isAudibleSignal
                ? '聲'
              : '♿'

        // Google 3D 的 MarkerElement 可承載真正的 HTML/CSS，因此設施可維持
        // 純圓形；倒水滴只留給車站與主要地標。
        const marker = new lib.MarkerElement({
          position: { lat: facility.lat, lng: facility.lng, altitude: isElevator ? 5 : isToilet ? 2.5 : isAudibleSignal ? 2 : 1.5 },
          title: facility.name,
        })
        marker.append(badge)
        marker.addEventListener('click', event => {
          const body = map.closest('.app-body')
          const bodyRect = body?.getBoundingClientRect()
          const markerRect = marker.getBoundingClientRect()
          if (bodyRect) {
            const pointer = event as MouseEvent
            const anchorX = markerRect.width
              ? markerRect.left + markerRect.width / 2 - bodyRect.left
              : pointer.clientX - bodyRect.left
            const anchorY = markerRect.height
              ? markerRect.top + markerRect.height / 2 - bodyRect.top
              : pointer.clientY - bodyRect.top
            const width = Math.min(320, bodyRect.width - 24)
            const estimatedHeight = 230
            const gap = 12
            const left = anchorX + gap + width <= bodyRect.width - 12
              ? anchorX + gap
              : Math.max(12, anchorX - width - gap)
            const top = anchorY + estimatedHeight <= bodyRect.height - 12
              ? Math.max(12, anchorY - 18)
              : Math.max(12, anchorY - estimatedHeight)
            setFacilityPopoverPosition({ left, top, width })
          }
          setSelectedFacility(facility)
        })
        accessibilityMarkersRef.current[facility.kind].push(marker)
        facilityByMarkerRef.current.set(marker, facility)
        if (visibleFacilityLayersRef.current[facility.kind] && !tourTimelineRef.current) map.append(marker)
      }
      if (tourTimelineRef.current && tourPositionRef.current) {
        syncTourFacilityMarkers(tourPositionRef.current, tourCurrentModeRef.current)
      }
    }).catch(error => console.warn('無障礙設施圖層無法載入', error))

    routeLinesRef.current.forEach(line => line.remove())
    routeLinesRef.current = selectedRouteRef.current
      ? drawRoute(map, lib, selectedRouteRef.current)
      : []
  }, [syncTourFacilityMarkers])

  // 訊息
  const addMessage = (msg: Message) => setMessages(prev => [...prev, msg])

  const claimCurrentRoutesAutoPlay = useCallback(() => {
    if (autoNarratedRoutesRef.current === routes) return false
    autoNarratedRoutesRef.current = routes
    return true
  }, [routes])

  // Agent 回覆處理（後端 API 或 mock 降級）
  const handleAgentResponse = useCallback((res: AgentResponse) => {
    if (res.detectedMode) setMode(res.detectedMode)
    if (res.routesReady && res.routes) {
      setRoutes(res.routes)
      setSelectedRoute(null)
      selectedRouteRef.current = null
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
  const handleSelectRoute = (route: PlannedRoute) => {
    stopRouteTour()
    setSelectedRoute(route)
    selectedRouteRef.current = route
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

  // 返回對話：停掉正在跑的導覽，避免切回對話後鏡頭仍在背景移動
  const handleBackToChat = () => {
    stopRouteTour()
    setTransitioning(true)
    setTimeout(() => { setPhase('chat'); setTransitioning(false) }, 220)
  }

  // 步驟切換 → 飛到對應站點
  // 同學的相機控制（完整保留）
  const [activePreset, setActivePreset] = useState<string>('cityHall')

  const flyTo = useCallback((preset: (typeof CAMERA_PRESETS)[number]) => {
    if (!mapRef.current) return
    stopRouteTour()
    setActivePreset(preset.id)
    mapRef.current.flyCameraTo({
      endCamera: { center: preset.center, range: preset.range, tilt: preset.tilt, heading: preset.heading },
      durationMillis: 2500,
    })
  }, [stopRouteTour])

  const orbit = useCallback(() => {
    if (!mapRef.current) return
    stopRouteTour()
    const preset = CAMERA_PRESETS.find(p => p.id === activePreset) ?? CAMERA_PRESETS[1]
    mapRef.current.flyCameraAround({
      camera: { center: preset.center, range: preset.range, tilt: preset.tilt, heading: preset.heading },
      durationMillis: 12000,
      rounds: 1,
    })
  }, [activePreset, stopRouteTour])

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
              <img
                className={dark ? 'is-dark-logo' : undefined}
                src={dark ? '/logo_b.png?v=1' : '/logo.png?v=2'}
                alt=""
              />
            </div>
            <div>
              <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '0.2px' }}>Taipei Pulse</span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 8 }}>無障礙路線</span>
            </div>
          </div>

          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
            <label className="header-speech-toggle">
              <input
                type="checkbox"
                checked={speechAutoPlay}
                onChange={event => changeSpeechAutoPlay(event.currentTarget.checked)}
              />
              <span>自動朗讀</span>
            </label>
            <label className="header-speech-setting">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
              </svg>
              <span>語速</span>
              <select value={speechRate} onChange={event => changeSpeechRate(Number(event.currentTarget.value))} aria-label="全站朗讀速度">
                {SPEECH_RATES.map(rate => <option key={rate} value={rate}>{rate}×</option>)}
              </select>
            </label>
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
                speechAutoPlay={speechAutoPlay}
              />
            </div>
            <div style={{ position: 'relative', minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
              <RoutePanel
                routes={routes}
                onSelectRoute={handleSelectRoute}
                speechRate={speechRate}
                speechAutoPlay={speechAutoPlay}
                claimAutoPlay={claimCurrentRoutesAutoPlay}
              />
            </div>
          </div>
        )}

        {/* ── 地圖階段：同學的原版 layout ── */}
        {phase === 'map' && (
          <div className={`app${tourStatus !== 'idle' ? ' is-route-touring' : ''}`}>
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
              <Map3D
                nightMode={mapNightMode}
                onReady={handleMapReady}
                onStatusChange={setMapStatus}
              />
              {selectedRoute && (
                <div className="route-map-legend" aria-label="地圖路線圖例">
                  <strong>{selectedRoute.label}</strong>
                  <div className="route-map-legend-modes">
                    <span><i className="route-swatch route-swatch-walk" />步行</span>
                    <span><i className="route-swatch route-swatch-mrt" />捷運</span>
                    <span><i className="route-swatch route-swatch-bus" />公車</span>
                  </div>
                  <div className="facility-layer-toggles" aria-label="無障礙設施圖層">
                    <button
                      type="button"
                      className={visibleFacilityLayers.metro_exit ? 'is-active' : undefined}
                      onClick={() => toggleFacilityLayer('metro_exit')}
                      aria-pressed={visibleFacilityLayers.metro_exit}
                      title="顯示或隱藏捷運出口"
                    ><span className="facility-toggle-exit" aria-hidden="true">出</span><b>出口</b></button>
                    <button
                      type="button"
                      className={visibleFacilityLayers.metro_access ? 'is-active' : undefined}
                      onClick={() => toggleFacilityLayer('metro_access')}
                      aria-pressed={visibleFacilityLayers.metro_access}
                      title="顯示或隱藏捷運電梯"
                    ><span aria-hidden="true">↕</span><b>電梯</b></button>
                    <button
                      type="button"
                      className={visibleFacilityLayers.curb_ramp ? 'is-active' : undefined}
                      onClick={() => toggleFacilityLayer('curb_ramp')}
                      aria-pressed={visibleFacilityLayers.curb_ramp}
                      title="顯示或隱藏沿線坡道"
                    ><span aria-hidden="true">♿</span><b>坡道</b></button>
                    <button
                      type="button"
                      className={visibleFacilityLayers.public_toilet ? 'is-active' : undefined}
                      onClick={() => toggleFacilityLayer('public_toilet')}
                      aria-pressed={visibleFacilityLayers.public_toilet}
                      title="顯示或隱藏沿線公廁"
                    ><span className="facility-toggle-toilet" aria-hidden="true">WC</span><b>廁所</b></button>
                    <button
                      type="button"
                      className={visibleFacilityLayers.audible_signal ? 'is-active' : undefined}
                      onClick={() => toggleFacilityLayer('audible_signal')}
                      aria-pressed={visibleFacilityLayers.audible_signal}
                      title="顯示或隱藏沿線有聲號誌"
                    ><span className="facility-toggle-audible" aria-hidden="true">聲</span><b>有聲</b></button>
                  </div>
                </div>
              )}
              {selectedFacility && (
                <aside
                  className="facility-popover"
                  role="dialog"
                  aria-label={`${selectedFacility.name}設施資訊`}
                  style={facilityPopoverPosition ?? undefined}
                >
                  <button type="button" className="facility-popover-close" onClick={() => {
                    setSelectedFacility(null)
                    setFacilityPopoverPosition(null)
                  }} aria-label="關閉設施資訊">×</button>
                  <span>{selectedFacility.kind === 'metro_exit'
                    ? '捷運出口'
                    : selectedFacility.kind === 'metro_access'
                      ? '捷運無障礙設施'
                      : selectedFacility.kind === 'public_toilet'
                        ? selectedFacility.accessible ? '無障礙廁所' : '一般公廁'
                        : selectedFacility.kind === 'audible_signal'
                          ? '視障友善設施'
                          : '路緣坡道'}</span>
                  <strong>{selectedFacility.kind === 'metro_access'
                    ? `${selectedFacility.stationName} ${selectedFacility.exit} 無障礙電梯`
                    : selectedFacility.name}</strong>
                  {facilityDescription(selectedFacility).map(line => <p key={line}>{line}</p>)}
                  <small>來源：臺北市政府開放資料</small>
                </aside>
              )}
              {selectedRoute && (
                <div className={`route-tour-hud route-tour-mode-${tourMode}${tourStatus === 'idle' ? ' is-idle' : ''}`}>
                  <div className="route-tour-steps" aria-label="切換路線區段">
                    {selectedRoute.steps.map((step, stepIndex) => (
                      step.path && step.path.length > 1 && (
                        <button
                          key={`${step.type}-${stepIndex}`}
                          type="button"
                          className={`route-tour-step-${step.type}${tourStatus !== 'idle' && tourStepIndex === stepIndex ? ' is-active' : ''}`}
                          onClick={() => jumpToRouteStep(stepIndex)}
                          aria-pressed={tourStatus !== 'idle' && tourStepIndex === stepIndex}
                        >
                          <span>{TOUR_MODE_SHORT_LABELS[step.type]}</span>
                          <small>{step.duration} 分</small>
                        </button>
                      )
                    ))}
                  </div>
                  {tourStatus === 'idle' ? (
                    <div className="route-tour-intro">
                      <div>
                        <strong>沿路線觀看</strong>
                        <small>可直接切換行程區段</small>
                      </div>
                      <button
                        type="button"
                        className="route-tour-primary route-tour-start"
                        onClick={startRouteTour}
                        disabled={mapStatus.kind !== 'ready'}
                      >
                        開始導覽
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="route-tour-summary">
                        <span role="status" aria-live="polite">
                          {tourStatus === 'completed' ? '導覽完成' : TOUR_MODE_LABELS[tourMode]}
                        </span>
                        <strong>{Math.round(tourProgress * 100)}%</strong>
                      </div>
                      <div className="route-tour-controls">
                        <button
                          type="button"
                          className="route-tour-primary"
                          onClick={tourStatus === 'running' ? pauseRouteTour : startRouteTour}
                        >
                          {tourStatus === 'running' && '暫停'}
                          {tourStatus === 'paused' && '繼續'}
                          {tourStatus === 'completed' && '重新播放'}
                        </button>
                        <button
                          type="button"
                          onClick={() => seekRouteTour(tourElapsedRef.current - 10_000)}
                          aria-label="往後 10 秒"
                        >−10秒</button>
                        <input
                          className="route-tour-scrubber"
                          type="range"
                          min="0"
                          max="1000"
                          value={Math.round(tourProgress * 1000)}
                          onPointerDown={() => {
                            if (tourStatus === 'running') pauseRouteTour()
                          }}
                          onKeyDown={() => {
                            if (tourStatus === 'running') pauseRouteTour()
                          }}
                          onChange={event => {
                            const timeline = tourTimelineRef.current
                            if (timeline) seekRouteTour(Number(event.currentTarget.value) / 1000 * timeline.durationMs)
                          }}
                          aria-label="導覽進度"
                        />
                        <button
                          type="button"
                          onClick={() => seekRouteTour(tourElapsedRef.current + 10_000)}
                          aria-label="往前 10 秒"
                        >+10秒</button>
                        <select
                          value={tourSpeed}
                          onChange={event => changeTourSpeed(Number(event.currentTarget.value))}
                          aria-label="播放速度"
                        >
                          {TOUR_SPEEDS.map(speed => (
                            <option key={speed} value={speed}>{speed}×</option>
                          ))}
                        </select>
                        {(tourStatus === 'running' || tourStatus === 'paused') && (
                          <button type="button" onClick={stopRouteTour}>結束</button>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )}
            </main>

            <nav className="camera-bar" aria-label="相機定位">
              {CAMERA_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => flyTo(preset)}
                  disabled={mapStatus.kind !== 'ready' || tourStatus === 'running'}
                  aria-pressed={activePreset === preset.id}
                  className={activePreset === preset.id ? 'is-active' : undefined}
                >
                  {preset.label}
                </button>
              ))}
              <button type="button" onClick={orbit} disabled={mapStatus.kind !== 'ready' || tourStatus === 'running'}>
                環繞一圈
              </button>
              <button
                type="button"
                className={`map-theme-btn${mapNightMode ? ' is-active' : ''}`}
                onClick={() => setMapNightMode(value => !value)}
                aria-pressed={mapNightMode}
                title="切換 3D 地圖日夜顯示"
              >
                <span aria-hidden="true">{mapNightMode ? '☾' : '☀'}</span>
                {mapNightMode ? '夜間' : '日間'}
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

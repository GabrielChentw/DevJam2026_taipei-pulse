import { useState, useCallback, useRef, useEffect } from 'react'
import { Map3D } from './components/Map3D'
import type { MapStatus } from './components/Map3D'
import ChatPanel from './components/ChatPanel'
import RoutePanel from './components/RoutePanel'
import SosButton from './components/SosButton'
import { BANNAN_CORRIDOR, CAMERA_PRESETS } from './data/corridor'
import {
  fetchTrafficScene,
  fetchTransitArrivals,
  fetchUserPreferences,
  saveUserPreferences,
  type TrafficSceneTarget,
} from './lib/api'
import type { Map3DElementLike, Maps3dLibrary, Model3DElementLike } from './lib/googleMaps'
import { createTrafficLayer, type TrafficLayerHandle } from './lib/trafficLayer'
import {
  buildFirstNavigationCue,
  buildRouteTourTimeline,
  routeTourFrameAt,
  smoothHeading,
  type FirstNavigationCue,
  type RouteTourTimeline,
  type TourMode,
} from './lib/routeTour'
import type { AccessibilityMode, AppPhase, Message, PlannedRoute } from './types'
import type { AgentResponse } from './mockData'
import type { TrafficSceneSnapshot, TrafficVehicle, TransitArrivalSnapshot } from './types/api'
import { getSpeechRate, setSpeechRate as persistSpeechRate, SPEECH_RATES, speak, stopSpeaking } from './lib/speech'

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
// Taipei Main Station's photogrammetry is tall and irregular. Stay close enough
// to read the first turn while keeping the camera above the roof mesh.
const FIRST_STEP_CAMERA = { altitude: 6, range: 140, tilt: 70, fov: 72 }

function getAnonymousUserId(): string {
  const key = 'taipei-pulse-anonymous-user-id'
  const saved = window.localStorage.getItem(key)
  if (saved) return saved
  const id = crypto.randomUUID()
  window.localStorage.setItem(key, id)
  return id
}

function formatEta(seconds: number): string {
  if (seconds <= 45) return '即將到站'
  return `約 ${Math.max(1, Math.ceil(seconds / 60))} 分鐘`
}

function trafficSourceLabel(source: string): string {
  const labels: Record<string, string> = {
    tdx_a2: 'TDX A2 即時位置',
    tdx_station_timetable: 'TDX 捷運時刻表推算',
    tdx_schedule_interpolation: 'TDX 公車班距推算',
    demo_schedule_interpolation: 'Demo 排程推算',
    demo_simulation: 'Demo 模擬位置',
  }
  return labels[source] ?? source
}

function cameraForTourFrame(mode: TourMode, stepIndex: number) {
  // The first walking leg starts beside Taipei Main Station's large roof mesh;
  // stay above it, then drop closer to street level for later walking legs.
  return mode === 'walk' && stepIndex === 0 ? TOUR_WALK_ENTRY_CAMERA : TOUR_CAMERA[mode]
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
  const [speechRate, setSpeechRate]     = useState(getSpeechRate)
  const [messages, setMessages]         = useState<Message[]>([])
  const [routes, setRoutes]             = useState<PlannedRoute[]>([])
  const [selectedRoute, setSelectedRoute] = useState<PlannedRoute | null>(null)

  const [mapStatus, setMapStatus]       = useState<MapStatus>({ kind: 'loading' })
  const [transitioning, setTransitioning] = useState(false)

  const mapRef = useRef<Map3DElementLike | null>(null)
  const mapsLibRef = useRef<Maps3dLibrary | null>(null)
  const selectedRouteRef = useRef<PlannedRoute | null>(null)
  const routeLinesRef = useRef<HTMLElement[]>([])
  const transitMarkerRef = useRef<Model3DElementLike | null>(null)
  const transitSnapshotRef = useRef<TransitArrivalSnapshot | null>(null)
  const trafficLayerRef = useRef<TrafficLayerHandle | null>(null)
  const tourTimelineRef = useRef<RouteTourTimeline | null>(null)
  const tourFrameRef = useRef<number | null>(null)
  const tourLaunchTimeoutRef = useRef<number | null>(null)
  const tourReturnTimeoutRef = useRef<number | null>(null)
  const tourLastFrameAtRef = useRef(0)
  const tourElapsedRef = useRef(0)
  const tourSpeedRef = useRef(1)
  const tourHeadingRef = useRef(0)
  const tourLastUiUpdateRef = useRef(0)
  const [tourStatus, setTourStatus] = useState<'idle' | 'running' | 'paused' | 'returning' | 'navigation-ready'>('idle')
  const [tourProgress, setTourProgress] = useState(0)
  const [tourMode, setTourMode] = useState<TourMode>('walk')
  const [tourStepIndex, setTourStepIndex] = useState(0)
  const [tourSpeed, setTourSpeed] = useState(1)
  const [navigationCue, setNavigationCue] = useState<FirstNavigationCue | null>(null)
  const [transitSnapshot, setTransitSnapshot] = useState<TransitArrivalSnapshot | null>(null)
  const [transitLoading, setTransitLoading] = useState(false)
  const [transitError, setTransitError] = useState<string | null>(null)
  const [trafficScene, setTrafficScene] = useState<TrafficSceneSnapshot | null>(null)
  const [trafficSceneError, setTrafficSceneError] = useState<string | null>(null)
  const [selectedTrafficVehicle, setSelectedTrafficVehicle] = useState<TrafficVehicle | null>(null)
  const [trafficLayerVisible, setTrafficLayerVisible] = useState(true)
  const [activePreset, setActivePreset] = useState<string>('cityHall')
  const anonymousUserIdRef = useRef(getAnonymousUserId())
  const [profileDetail, setProfileDetail] = useState('')
  const [preferenceStatus, setPreferenceStatus] = useState<'idle' | 'saving' | 'saved' | 'memory' | 'error'>('idle')

  useEffect(() => {
    if (window.localStorage.getItem('taipei-pulse-remember-preferences') !== 'true') return
    let disposed = false
    fetchUserPreferences(anonymousUserIdRef.current)
      .then(snapshot => {
        if (disposed || !snapshot.updated_at) return
        setMode(snapshot.accessibility_mode)
        setProfileDetail(snapshot.profile_detail)
        setSpeechRate(snapshot.speech_rate)
        persistSpeechRate(snapshot.speech_rate)
        setDark(snapshot.theme === 'dark')
        setPreferenceStatus(snapshot.storage_mode === 'firestore' ? 'saved' : 'memory')
      })
      .catch(() => {
        if (!disposed) setPreferenceStatus('error')
      })
    return () => { disposed = true }
  }, [])

  const rememberPreferences = async () => {
    setPreferenceStatus('saving')
    try {
      const snapshot = await saveUserPreferences(anonymousUserIdRef.current, {
        accessibility_mode: mode,
        profile_detail: profileDetail,
        speech_rate: speechRate,
        theme: dark ? 'dark' : 'light',
      })
      window.localStorage.setItem('taipei-pulse-remember-preferences', 'true')
      setPreferenceStatus(snapshot.storage_mode === 'firestore' ? 'saved' : 'memory')
    } catch {
      setPreferenceStatus('error')
    }
  }

  const changeSpeechRate = (rate: number) => {
    stopSpeaking()
    setSpeechRate(rate)
    persistSpeechRate(rate)
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
    if (tourReturnTimeoutRef.current !== null) {
      window.clearTimeout(tourReturnTimeoutRef.current)
      tourReturnTimeoutRef.current = null
    }
  }, [])

  const stopRouteTour = useCallback(() => {
    cancelTourTimers()
    mapRef.current?.stopCameraAnimation()
    tourTimelineRef.current = null
    tourElapsedRef.current = 0
    tourLastFrameAtRef.current = 0
    setTourProgress(0)
    setTourStepIndex(0)
    setNavigationCue(null)
    setTourStatus('idle')
    const arrival = transitSnapshotRef.current?.arrivals[0]
    if (arrival && transitMarkerRef.current) {
      transitMarkerRef.current.position = { ...arrival.position, altitude: 4 }
    }
  }, [cancelTourTimers])

  const returnToFirstNavigationStep = useCallback(() => {
    const map = mapRef.current
    const route = selectedRouteRef.current
    if (!map || !route) return

    const cue = buildFirstNavigationCue(route)
    if (!cue) {
      setTourStatus('idle')
      return
    }

    cancelTourTimers()
    map.stopCameraAnimation()
    map.fov = FIRST_STEP_CAMERA.fov
    setNavigationCue(cue)
    setTourProgress(1)
    setTourMode('walk')
    setTourStepIndex(cue.stepIndex)
    setActivePreset('mainStation')
    setTourStatus('returning')
    const arrival = transitSnapshotRef.current?.arrivals[0]
    if (arrival && transitMarkerRef.current) {
      transitMarkerRef.current.position = { ...arrival.position, altitude: 4 }
    }
    map.flyCameraTo({
      endCamera: {
        center: { ...cue.position, altitude: FIRST_STEP_CAMERA.altitude },
        range: FIRST_STEP_CAMERA.range,
        tilt: FIRST_STEP_CAMERA.tilt,
        heading: cue.heading,
      },
      durationMillis: 1800,
    })
    tourReturnTimeoutRef.current = window.setTimeout(() => {
      tourReturnTimeoutRef.current = null
      setTourStatus('navigation-ready')
    }, 1850)
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
    if (frame.mode === 'bus' && transitMarkerRef.current) {
      // The selected suitable bus moves along the official TDX shape during
      // route preview, then returns to its latest arrival position afterwards.
      transitMarkerRef.current.position = { ...frame.position, altitude: 4 }
      transitMarkerRef.current.orientation = { heading: frame.heading, tilt: 0, roll: 0 }
    }

    if (now - tourLastUiUpdateRef.current > 180 || frame.finished) {
      tourLastUiUpdateRef.current = now
      setTourProgress(frame.progress)
      setTourMode(frame.mode)
      setTourStepIndex(frame.stepIndex)
    }

    if (frame.finished) {
      tourFrameRef.current = null
      returnToFirstNavigationStep()
      return
    }
    tourFrameRef.current = window.requestAnimationFrame(animateRouteTour)
  }, [returnToFirstNavigationStep])

  const startRouteTour = useCallback(() => {
    const map = mapRef.current
    if (!map || !selectedRouteRef.current) return

    if (tourStatus === 'paused' && tourTimelineRef.current) {
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
    setNavigationCue(null)
    setTourStatus('running')

    const firstFrame = routeTourFrameAt(timeline, 0)
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
      tourLastFrameAtRef.current = performance.now()
      tourFrameRef.current = window.requestAnimationFrame(animateRouteTour)
    }, 1450)
  }, [animateRouteTour, cancelTourTimers, tourStatus])

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
    if (transitMarkerRef.current) {
      const latestArrival = transitSnapshotRef.current?.arrivals[0]
      transitMarkerRef.current.position = frame.mode === 'bus'
        ? { ...frame.position, altitude: 4 }
        : { ...(latestArrival?.position ?? frame.position), altitude: 4 }
      if (frame.mode === 'bus') {
        transitMarkerRef.current.orientation = { heading: frame.heading, tilt: 0, roll: 0 }
      }
    }
    setTourProgress(frame.progress)
    setTourMode(frame.mode)
    setTourStepIndex(frame.stepIndex)

    if (frame.finished) {
      returnToFirstNavigationStep()
    } else if (tourStatus === 'navigation-ready' || tourStatus === 'returning') {
      setNavigationCue(null)
      setTourStatus('paused')
    }
  }, [returnToFirstNavigationStep, tourStatus])

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

  // Map ready: 添加捷運站標記
  const handleMapReady = useCallback((map: Map3DElementLike, lib: Maps3dLibrary) => {
    mapRef.current = map
    mapsLibRef.current = lib
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

    routeLinesRef.current.forEach(line => line.remove())
    routeLinesRef.current = selectedRouteRef.current
      ? drawRoute(map, lib, selectedRouteRef.current)
      : []
    trafficLayerRef.current?.destroy()
    trafficLayerRef.current = createTrafficLayer(map, lib, setSelectedTrafficVehicle)
  }, [])

  useEffect(() => {
    if (!trafficLayerRef.current) return
    trafficLayerRef.current.update(
      trafficLayerVisible && trafficScene
        ? trafficScene
        : {
            generated_at: new Date().toISOString(),
            clock_time: '--:--:--',
            clock_mode: 'realtime',
            timezone: 'Asia/Taipei',
            notices: [],
            vehicles: [],
          },
    )
  }, [mapStatus.kind, trafficLayerVisible, trafficScene])

  useEffect(() => {
    if (phase === 'map') return
    trafficLayerRef.current?.destroy()
    trafficLayerRef.current = null
  }, [phase])

  useEffect(() => () => trafficLayerRef.current?.destroy(), [])

  useEffect(() => {
    const transitStep = selectedRoute?.steps.find(step =>
      step.type !== 'walk'
      && step.transitRouteUid
      && step.transitDirection !== undefined,
    )
    const target: TrafficSceneTarget | null = transitStep ? {
      mode: transitStep.type === 'mrt' ? 'metro' : 'bus',
      routeName: transitStep.transitRouteName ?? transitStep.line ?? (transitStep.type === 'mrt' ? '板南線' : '公車'),
      routeUid: transitStep.transitRouteUid!,
      direction: transitStep.transitDirection!,
      boardingStopUid: transitStep.boardingStopUid,
    } : null

    // A route change means a different vehicle is now the user's intended
    // boarding target. Select it once; later 10-second refreshes preserve any
    // background vehicle the user explicitly clicked.
    setSelectedTrafficVehicle(null)

    let disposed = false
    const load = async () => {
      try {
        const scene = await fetchTrafficScene(target)
        if (disposed) return
        setTrafficScene(scene)
        setTrafficSceneError(null)
        setSelectedTrafficVehicle(current => {
          if (!current) return scene.vehicles.find(vehicle => vehicle.is_target) ?? null
          return scene.vehicles.find(vehicle => vehicle.vehicle_id === current.vehicle_id)
            ?? scene.vehicles.find(vehicle => vehicle.is_target)
            ?? null
        })
      } catch (error) {
        if (!disposed) setTrafficSceneError(error instanceof Error ? error.message : '無法取得交通場景')
      }
    }
    void load()
    const interval = window.setInterval(() => void load(), 10_000)
    return () => {
      disposed = true
      window.clearInterval(interval)
    }
  }, [selectedRoute])

  useEffect(() => {
    const busStep = selectedRoute?.steps.find(step =>
      step.type === 'bus'
      && step.transitRouteName
      && step.transitRouteUid
      && step.transitDirection !== undefined
      && step.boardingStopUid,
    )

    transitMarkerRef.current?.remove()
    transitMarkerRef.current = null
    transitSnapshotRef.current = null
    setTransitSnapshot(null)
    setTransitError(null)
    if (!busStep) {
      setTransitLoading(false)
      return
    }

    let disposed = false
    const load = async (refresh: boolean) => {
      setTransitLoading(true)
      try {
        const snapshot = await fetchTransitArrivals(
          busStep.transitRouteName!,
          busStep.transitRouteUid!,
          busStep.transitDirection!,
          busStep.boardingStopUid!,
          refresh,
        )
        if (disposed) return
        transitSnapshotRef.current = snapshot
        setTransitSnapshot(snapshot)
        setTransitError(null)
      } catch (error) {
        if (disposed) return
        setTransitError(error instanceof Error ? error.message : '無法取得即將到站車輛')
      } finally {
        if (!disposed) setTransitLoading(false)
      }
    }

    void load(false)
    const interval = window.setInterval(() => void load(true), 15_000)
    return () => {
      disposed = true
      window.clearInterval(interval)
    }
  }, [selectedRoute])

  useEffect(() => {
    const map = mapRef.current
    const lib = mapsLibRef.current
    const snapshot = transitSnapshot
    const arrival = snapshot?.arrivals.find(item => item.suitable_for_wheelchair)
      ?? snapshot?.arrivals[0]
    if (!map || !lib || !snapshot || !arrival) return

    if (!transitMarkerRef.current) {
      const { Model3DInteractiveElement, Model3DElement, AltitudeMode } = lib
      const Model = Model3DInteractiveElement ?? Model3DElement
      transitMarkerRef.current = new Model({
        position: { ...arrival.position, altitude: 4 },
        orientation: { heading: 0, tilt: 0, roll: 0 },
        scale: { x: 10.5, y: 9.75, z: 42 },
        src: '/models/vehicle-target.glb',
        altitudeMode: AltitudeMode?.RELATIVE_TO_GROUND ?? 'RELATIVE_TO_GROUND',
      })
      const selectTargetBus = () => {
        const target = trafficScene?.vehicles.find(vehicle => vehicle.mode === 'bus' && vehicle.is_target)
        if (target) setSelectedTrafficVehicle(target)
      }
      transitMarkerRef.current.addEventListener('gmp-click', selectTargetBus)
      transitMarkerRef.current.addEventListener('click', selectTargetBus)
      map.append(transitMarkerRef.current)
    } else {
      transitMarkerRef.current.position = { ...arrival.position, altitude: 4 }
    }
  }, [mapStatus.kind, trafficScene, transitSnapshot])

  // 訊息
  const addMessage = (msg: Message) => setMessages(prev => [...prev, msg])

  // Agent 回覆處理（後端 API 或 mock 降級）
  const handleAgentResponse = useCallback((res: AgentResponse) => {
    if (res.detectedMode) setMode(res.detectedMode)
    if (res.profileDetail) setProfileDetail(res.profileDetail)
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
            <button
              type="button"
              className={`preference-save-button status-${preferenceStatus}`}
              onClick={() => void rememberPreferences()}
              disabled={preferenceStatus === 'saving'}
              title="只儲存障礙模式、語速與主題，不會儲存定位或對話內容"
            >
              {preferenceStatus === 'saving' && '儲存中…'}
              {preferenceStatus === 'saved' && '✓ 偏好已存 Firestore'}
              {preferenceStatus === 'memory' && '✓ 偏好已暫存'}
              {preferenceStatus === 'error' && '重試儲存偏好'}
              {preferenceStatus === 'idle' && '記住偏好'}
            </button>
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
                speechRate={speechRate}
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
              <aside className="traffic-scene-panel" aria-label="時刻表交通圖層">
                <div className="traffic-scene-header">
                  <div>
                    <strong>城市交通脈動</strong>
                    <small>
                      {trafficScene?.clock_mode === 'schedule_playback' ? '時刻表回放' : '現在時間'}　
                      {trafficScene?.clock_time?.slice(0, 5) ?? '--:--'}
                    </small>
                  </div>
                  <button
                    type="button"
                    className={trafficLayerVisible ? 'is-on' : undefined}
                    onClick={() => setTrafficLayerVisible(value => !value)}
                    aria-pressed={trafficLayerVisible}
                  >{trafficLayerVisible ? '圖層開啟' : '圖層關閉'}</button>
                </div>
                {trafficSceneError && <div className="traffic-scene-notice">交通資料暫時無法更新</div>}
                {trafficScene && (
                  <div className="traffic-scene-counts">
                    <span><i className="traffic-block traffic-block-metro" aria-hidden="true" />{trafficScene.vehicles.filter(vehicle => vehicle.mode === 'metro').length} 班捷運</span>
                    <span><i className="traffic-block traffic-block-bus" aria-hidden="true" />{trafficScene.vehicles.filter(vehicle => vehicle.mode === 'bus').length} 輛公車</span>
                    <span><i className="traffic-block traffic-block-target" aria-hidden="true" />目標車</span>
                  </div>
                )}
                {selectedTrafficVehicle ? (
                  <div className={`traffic-vehicle-card${selectedTrafficVehicle.is_target ? ' is-target' : ''}`} aria-live="polite">
                    <div className="traffic-vehicle-title">
                      <span className="traffic-selected-symbol" aria-hidden="true">
                        <i className={`traffic-block ${selectedTrafficVehicle.is_target ? 'traffic-block-target' : selectedTrafficVehicle.mode === 'metro' ? 'traffic-block-metro' : 'traffic-block-bus'}`} />
                      </span>
                      <div>
                        <small>{selectedTrafficVehicle.is_target ? '你的目標車' : '已選取車輛'}</small>
                        <strong>{selectedTrafficVehicle.route_name}</strong>
                      </div>
                      {selectedTrafficVehicle.plate_number && <code>{selectedTrafficVehicle.plate_number}</code>}
                    </div>
                    <dl>
                      <div><dt>下一站</dt><dd>{selectedTrafficVehicle.next_stop_name ?? '未提供'}</dd></div>
                      <div><dt>目的地</dt><dd>{selectedTrafficVehicle.destination_name ?? '未提供'}</dd></div>
                      <div><dt>{selectedTrafficVehicle.is_target ? '抵達' : '此段剩餘'}</dt><dd>{selectedTrafficVehicle.eta_seconds == null ? '—' : formatEta(selectedTrafficVehicle.eta_seconds)}</dd></div>
                    </dl>
                    <div className="traffic-vehicle-meta">
                      <span>{trafficSourceLabel(selectedTrafficVehicle.source)}</span>
                      {selectedTrafficVehicle.suitable_for_wheelchair === true && <strong>♿ 適合輪椅</strong>}
                      {selectedTrafficVehicle.suitable_for_wheelchair == null && <em>無障礙車型待確認</em>}
                    </div>
                  </div>
                ) : (
                  <div className="traffic-scene-notice">點選地圖上的捷運或公車查看資訊</div>
                )}
                {trafficScene && trafficScene.vehicles.length > 0 && (
                  <div className="traffic-vehicle-picker" aria-label="選擇地圖車輛">
                    {trafficScene.vehicles.slice(0, 8).map(vehicle => (
                      <button
                        key={vehicle.vehicle_id}
                        type="button"
                        className={`${vehicle.is_target ? 'is-target' : ''}${selectedTrafficVehicle?.vehicle_id === vehicle.vehicle_id ? ' is-selected' : ''}`}
                        onClick={() => setSelectedTrafficVehicle(vehicle)}
                        title={`${vehicle.route_name} · ${trafficSourceLabel(vehicle.source)}`}
                      >
                        <i className={`traffic-block ${vehicle.is_target ? 'traffic-block-target' : vehicle.mode === 'metro' ? 'traffic-block-metro' : 'traffic-block-bus'}`} aria-hidden="true" />
                        {vehicle.is_target ? '目標 · ' : ''}{vehicle.route_name}
                      </button>
                    ))}
                  </div>
                )}
                {trafficScene?.notices[0] && <small className="traffic-scene-footnote">{trafficScene.notices[0]}</small>}
              </aside>
              {selectedRoute && (
                <div className="route-map-legend" aria-label="地圖路線圖例">
                  <strong>{selectedRoute.label}</strong>
                  <div className="route-map-legend-modes">
                    <span><i className="route-swatch route-swatch-walk" />步行</span>
                    <span><i className="route-swatch route-swatch-mrt" />捷運</span>
                    <span><i className="route-swatch route-swatch-bus" />公車</span>
                  </div>
                </div>
              )}
              {selectedRoute && (
                <div className={`route-tour-hud route-tour-mode-${tourMode}${tourStatus === 'idle' ? ' is-idle' : ''}${tourStatus === 'navigation-ready' ? ' is-navigation-ready' : ''}`}>
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
                  ) : tourStatus === 'returning' ? (
                    <div className="route-tour-returning" role="status" aria-live="polite">
                      <span className="route-tour-returning-icon" aria-hidden="true">↩</span>
                      <div>
                        <strong>預演完成，正在回到出發位置</strong>
                        <small>接著會顯示第一步步行方向；尚未啟動 GPS 跟隨</small>
                      </div>
                    </div>
                  ) : tourStatus === 'navigation-ready' && navigationCue ? (
                    <div className="route-navigation-ready" role="status" aria-live="polite">
                      <div className="route-navigation-eyebrow">輪椅第一段步行 · 導航準備完成</div>
                      <div className="route-navigation-instruction">
                        <span className="route-navigation-arrow" aria-hidden="true">↑</span>
                        <div>
                          <strong>{navigationCue.description}</strong>
                          {navigationCue.detail && <small>{navigationCue.detail}</small>}
                        </div>
                        <span className="route-navigation-duration">約 {navigationCue.durationMinutes} 分</span>
                      </div>
                      {selectedRoute.steps.some(step => step.type === 'bus') && (
                        <div className="transit-arrival-card" aria-live="polite">
                          {transitLoading && !transitSnapshot && (
                            <div className="transit-arrival-loading">正在確認即將到站的低地板公車…</div>
                          )}
                          {transitError && !transitSnapshot && (
                            <div className="transit-arrival-loading">暫時無法取得車輛資料，請依站牌資訊確認。</div>
                          )}
                          {transitSnapshot?.arrivals[0] && (() => {
                            const arrival = transitSnapshot.arrivals[0]
                            return (
                              <>
                                <div className="transit-arrival-heading">
                                  <span className="transit-arrival-icon" aria-hidden="true">♿</span>
                                  <div>
                                    <small>即將搭乘 · {transitSnapshot.boarding_stop_name}</small>
                                    <strong>{transitSnapshot.route_name}　{formatEta(arrival.eta_seconds)}</strong>
                                  </div>
                                  <span className="transit-arrival-plate">{arrival.plate_number}</span>
                                </div>
                                <div className="transit-arrival-access">
                                  <span className={arrival.is_low_floor ? 'is-ok' : 'is-unknown'}>
                                    {arrival.is_low_floor ? '✓ 低地板' : '? 低地板未知'}
                                  </span>
                                  <span className={arrival.has_ramp ? 'is-ok' : 'is-unknown'}>
                                    {arrival.has_ramp ? '✓ 輪椅斜坡板' : '? 斜坡板未知'}
                                  </span>
                                  <strong>{arrival.suitable_for_wheelchair ? '適合輪椅搭乘' : '請先確認'}</strong>
                                </div>
                                <small className="transit-arrival-source">
                                  {arrival.timing_source === 'tdx_live' ? '到站時間：TDX 即時' : '到站時間：Demo 模擬'} ·
                                  {arrival.position_source === 'tdx_a2' ? ' 車輛位置：TDX A2' : ' 車輛位置：Demo 模擬'} ·
                                  低地板資格：Demo 模擬
                                </small>
                              </>
                            )
                          })()}
                        </div>
                      )}
                      <div className="route-navigation-actions">
                        <button
                          type="button"
                          className="route-tour-primary"
                          onClick={() => speak(`${navigationCue.description}。${navigationCue.detail ?? ''}`, speechRate)}
                        >朗讀第一步</button>
                        <button type="button" onClick={startRouteTour}>重新預演</button>
                      </div>
                      <small className="route-navigation-gps-note">目前固定在出發點視角，不會追蹤或儲存即時位置。</small>
                    </div>
                  ) : (
                    <>
                      <div className="route-tour-summary">
                        <span role="status" aria-live="polite">
                          {TOUR_MODE_LABELS[tourMode]}
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

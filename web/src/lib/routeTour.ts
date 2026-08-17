import type { LatLngPoint } from '../types/api'
import type { PlannedRoute, RouteStep } from '../types'

export type TourMode = RouteStep['type']

export interface TourEdge {
  from: LatLngPoint
  to: LatLngPoint
  mode: TourMode
  stepIndex: number
  startsAtMs: number
  durationMs: number
}

export interface RouteTourTimeline {
  edges: TourEdge[]
  durationMs: number
}

export interface RouteTourFrame {
  position: LatLngPoint
  heading: number
  mode: TourMode
  stepIndex: number
  progress: number
  finished: boolean
}

export interface FirstNavigationCue {
  position: LatLngPoint
  heading: number
  stepIndex: number
  description: string
  detail?: string
  durationMinutes: number
}

interface LocatedTourPoint {
  edge: TourEdge
  position: LatLngPoint
}

const EARTH_RADIUS_METERS = 6_371_000
const DISPLAY_SPEED_METERS_PER_SECOND: Record<TourMode, number> = {
  walk: 24,
  mrt: 120,
  bus: 70,
}

function radians(value: number) {
  return value * Math.PI / 180
}

function degrees(value: number) {
  return value * 180 / Math.PI
}

function distanceMeters(a: LatLngPoint, b: LatLngPoint) {
  const dLat = radians(b.lat - a.lat)
  const dLng = radians(b.lng - a.lng)
  const lat1 = radians(a.lat)
  const lat2 = radians(b.lat)
  const value = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(value))
}

function bearingDegrees(a: LatLngPoint, b: LatLngPoint) {
  const lat1 = radians(a.lat)
  const lat2 = radians(b.lat)
  const dLng = radians(b.lng - a.lng)
  const y = Math.sin(dLng) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2)
    - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng)
  return (degrees(Math.atan2(y, x)) + 360) % 360
}

/** Build a continuous, accelerated demo timeline from every drawable route leg. */
export function buildRouteTourTimeline(route: PlannedRoute): RouteTourTimeline | null {
  const rawEdges: Array<Omit<TourEdge, 'startsAtMs' | 'durationMs'> & { rawDurationMs: number }> = []

  route.steps.forEach((step, stepIndex) => {
    const path = step.path ?? []
    for (let index = 0; index < path.length - 1; index += 1) {
      const from = path[index]
      const to = path[index + 1]
      const distance = distanceMeters(from, to)
      if (distance < 0.25) continue
      rawEdges.push({
        from,
        to,
        mode: step.type,
        stepIndex,
        rawDurationMs: Math.max(180, distance / DISPLAY_SPEED_METERS_PER_SECOND[step.type] * 1000),
      })
    }
  })

  if (rawEdges.length === 0) return null

  const rawTotal = rawEdges.reduce((sum, edge) => sum + edge.rawDurationMs, 0)
  // Keep the complete demo long enough to feel spatial, but short enough for judging.
  const targetDuration = Math.min(70_000, Math.max(28_000, rawTotal))
  const durationScale = targetDuration / rawTotal
  let cursor = 0

  const edges = rawEdges.map(({ rawDurationMs, ...edge }) => {
    const durationMs = rawDurationMs * durationScale
    const result: TourEdge = { ...edge, startsAtMs: cursor, durationMs }
    cursor += durationMs
    return result
  })

  return { edges, durationMs: cursor }
}

function locateTourPoint(timeline: RouteTourTimeline, elapsedMs: number): LocatedTourPoint {
  const clamped = Math.min(Math.max(elapsedMs, 0), timeline.durationMs)
  const edge = timeline.edges.find(
    candidate => clamped <= candidate.startsAtMs + candidate.durationMs,
  ) ?? timeline.edges[timeline.edges.length - 1]
  const localProgress = Math.min(
    1,
    Math.max(0, (clamped - edge.startsAtMs) / edge.durationMs),
  )

  return {
    edge,
    position: {
      lat: edge.from.lat + (edge.to.lat - edge.from.lat) * localProgress,
      lng: edge.from.lng + (edge.to.lng - edge.from.lng) * localProgress,
    },
  }
}

export function routeTourFrameAt(timeline: RouteTourTimeline, elapsedMs: number): RouteTourFrame {
  const clamped = Math.min(Math.max(elapsedMs, 0), timeline.durationMs)
  const current = locateTourPoint(timeline, clamped)
  // Aim roughly one visual second ahead. Routes geometry contains many tiny
  // zigzags; using each edge's bearing directly makes the camera weave sideways.
  const lookAhead = locateTourPoint(timeline, Math.min(clamped + 900, timeline.durationMs))
  const target = lookAhead.edge.mode === current.edge.mode ? lookAhead.position : current.edge.to
  const heading = distanceMeters(current.position, target) > 0.5
    ? bearingDegrees(current.position, target)
    : bearingDegrees(current.edge.from, current.edge.to)

  return {
    position: current.position,
    heading,
    mode: current.edge.mode,
    stepIndex: current.edge.stepIndex,
    progress: timeline.durationMs === 0 ? 1 : clamped / timeline.durationMs,
    finished: clamped >= timeline.durationMs,
  }
}

/**
 * Build the first instruction shown after the cinematic route preview.
 * This intentionally returns a fixed starting pose only: live GPS following
 * belongs to a later MVP stage.
 */
export function buildFirstNavigationCue(route: PlannedRoute): FirstNavigationCue | null {
  const timeline = buildRouteTourTimeline(route)
  const firstWalkingEdge = timeline?.edges.find(edge => edge.mode === 'walk')
  if (!timeline || !firstWalkingEdge) return null

  const step = route.steps[firstWalkingEdge.stepIndex]
  const frame = routeTourFrameAt(timeline, firstWalkingEdge.startsAtMs + 1)
  return {
    position: firstWalkingEdge.from,
    heading: frame.heading,
    stepIndex: firstWalkingEdge.stepIndex,
    description: step.description,
    detail: step.detail,
    durationMinutes: step.duration,
  }
}

/** Interpolate headings across north (359° → 1°) without spinning the long way. */
export function smoothHeading(current: number, target: number, amount = 0.16) {
  const delta = ((target - current + 540) % 360) - 180
  return (current + delta * amount + 360) % 360
}

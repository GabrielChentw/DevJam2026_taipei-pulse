import type { PlannedRoute } from '../types'
import { BANNAN_CORRIDOR } from '../data/corridor'

export interface MetroAccessPoint {
  id: string
  kind: 'metro_access'
  name: string
  exit: string
  lat: number
  lng: number
  stationName: string
  stationNumber: string
  accessibleRestrooms: string
  elevatorLocation: string
}

export interface MetroExitPoint {
  id: string
  kind: 'metro_exit'
  name: string
  exit: string
  lat: number
  lng: number
  accessible: boolean
}

export interface CurbRampPoint {
  id: string
  kind: 'curb_ramp'
  name: string
  district: string
  lat: number
  lng: number
}

export interface PublicToiletPoint {
  id: string
  kind: 'public_toilet'
  name: string
  category: string
  address: string
  lat: number
  lng: number
  accessible: boolean
  accessibleCount: number
}

export interface AudibleSignalPoint {
  id: string
  kind: 'audible_signal'
  name: string
  district: string
  signalId: string
  lat: number
  lng: number
}

export type AccessibilityFacility =
  | MetroExitPoint
  | MetroAccessPoint
  | CurbRampPoint
  | PublicToiletPoint
  | AudibleSignalPoint

interface AccessibilityBundle {
  metroExits: MetroExitPoint[]
  metroAccessPoints: MetroAccessPoint[]
  curbRamps: CurbRampPoint[]
  publicToilets: PublicToiletPoint[]
  audibleSignals: AudibleSignalPoint[]
}

let bundlePromise: Promise<AccessibilityBundle> | null = null

export function loadAccessibilityFacilities(): Promise<AccessibilityBundle> {
  bundlePromise ??= Promise.all([
    fetch('/data/accessibility-facilities.json'),
    fetch('/data/audible-signals.json'),
  ]).then(async ([facilitiesResponse, signalsResponse]) => {
    if (!facilitiesResponse.ok) throw new Error(`無障礙資料載入失敗（${facilitiesResponse.status}）`)
    if (!signalsResponse.ok) throw new Error(`有聲號誌資料載入失敗（${signalsResponse.status}）`)
    const facilities = await facilitiesResponse.json() as Omit<AccessibilityBundle, 'audibleSignals'>
    const signals = await signalsResponse.json() as { audibleSignals: AudibleSignalPoint[] }
    return { ...facilities, audibleSignals: signals.audibleSignals }
  })
  return bundlePromise
}

function stationKey(name: string): string {
  return name.replace('臺北', '台北').replace(/站$/, '')
}

export function metroPointsForStations(
  points: MetroAccessPoint[],
  stationNames: string[],
): MetroAccessPoint[] {
  const wanted = new Set(stationNames.map(stationKey))
  return points.filter(point => wanted.has(stationKey(point.stationName)))
}

function distanceToSegmentMeters(
  point: { lat: number; lng: number },
  start: { lat: number; lng: number },
  end: { lat: number; lng: number },
): number {
  const meanLat = (point.lat + start.lat + end.lat) / 3 * Math.PI / 180
  const metersPerLng = 111_320 * Math.cos(meanLat)
  const metersPerLat = 110_574
  const px = (point.lng - start.lng) * metersPerLng
  const py = (point.lat - start.lat) * metersPerLat
  const ex = (end.lng - start.lng) * metersPerLng
  const ey = (end.lat - start.lat) * metersPerLat
  const lengthSquared = ex * ex + ey * ey
  const ratio = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, (px * ex + py * ey) / lengthSquared))
  return Math.hypot(px - ratio * ex, py - ratio * ey)
}

function routeSegments(route: PlannedRoute | null, modes?: Set<PlannedRoute['steps'][number]['type']>) {
  const explicit = route?.steps
    .filter(step => (!modes || modes.has(step.type)) && step.path && step.path.length > 1)
    .flatMap(step => step.path!.slice(0, -1).map((point, index) => [point, step.path![index + 1]] as const)) ?? []

  if (explicit.length || !route) return explicit

  // 離線示範資料沒有 geometry。若路線起訖可對應板南線站點，仍以站間走廊
  // 建立保守的篩選範圍，避免「有圖層按鈕、地圖卻完全沒有設施」。
  const normalize = (value: string) => value.replace('臺北', '台北').replace(/捷運|站|市政府大樓/g, '')
  const stationIndex = (value: string) => {
    const key = normalize(value)
    return BANNAN_CORRIDOR.findIndex(station => key.includes(normalize(station.name)))
  }
  const fromIndex = stationIndex(route.from)
  const toIndex = stationIndex(route.to)
  if (fromIndex < 0 || toIndex < 0) return []

  const start = Math.min(fromIndex, toIndex)
  const end = Math.max(fromIndex, toIndex)
  const corridor = BANNAN_CORRIDOR.slice(start, end + 1).map(station => station.position)

  // 坡道只在進出站的地面步行附近顯示；捷運設施則沿搭乘走廊顯示。
  if (modes?.has('walk')) {
    return corridor.length > 1
      ? [[corridor[0], corridor[1]] as const, [corridor.at(-2)!, corridor.at(-1)!] as const]
      : []
  }
  return corridor.slice(0, -1).map((point, index) => [point, corridor[index + 1]] as const)
}

/** 捷運出口／電梯只取目前完整路線附近，避免全市靜態點位常駐。 */
export function metroFacilitiesNearRoute<T extends { lat: number; lng: number }>(
  points: T[],
  route: PlannedRoute | null,
  radiusMeters = 170,
  limit = 80,
): T[] {
  const segments = routeSegments(route)
  if (!segments.length) return []
  const matches: T[] = []
  for (const point of points) {
    if (segments.some(([start, end]) => distanceToSegmentMeters(point, start, end) <= radiusMeters)) {
      matches.push(point)
      if (matches.length >= limit) break
    }
  }
  return matches
}

/** 只回傳步行線附近的坡道，並設上限避免 3D 標記過多。 */
export function curbRampsNearRoute(
  ramps: CurbRampPoint[],
  route: PlannedRoute | null,
  radiusMeters = 22,
  limit = 180,
): CurbRampPoint[] {
  const segments = routeSegments(route, new Set(['walk']))

  if (!segments.length) return []
  const matches: CurbRampPoint[] = []
  for (const ramp of ramps) {
    if (segments.some(([start, end]) => distanceToSegmentMeters(ramp, start, end) <= radiusMeters)) {
      matches.push(ramp)
      if (matches.length >= limit) break
    }
  }
  return matches
}

/** 有聲號誌只取步行線會經過的路口附近，避免全市點位常駐。 */
export function audibleSignalsNearRoute(
  signals: AudibleSignalPoint[],
  route: PlannedRoute | null,
  radiusMeters = 28,
  limit = 100,
): AudibleSignalPoint[] {
  const segments = routeSegments(route, new Set(['walk']))
  if (!segments.length) return []
  const matches: AudibleSignalPoint[] = []
  for (const signal of signals) {
    if (segments.some(([start, end]) => distanceToSegmentMeters(signal, start, end) <= radiusMeters)) {
      matches.push(signal)
      if (matches.length >= limit) break
    }
  }
  return matches
}

export function facilityDescription(facility: AccessibilityFacility): string[] {
  if (facility.kind === 'metro_exit') {
    return [
      `${facility.exit} 出口`,
      facility.accessible ? '政府開放資料標示為無障礙出口。' : '一般出口，未標示為無障礙使用。',
    ]
  }
  if (facility.kind === 'curb_ramp') {
    return [
      `${facility.district}政府開放資料點位`,
      '靠近路線可作為友善證據，但仍需確認是否位於實際穿越的路口側。',
    ]
  }
  if (facility.kind === 'public_toilet') {
    return [
      facility.accessible
        ? `設有 ${facility.accessibleCount} 座無障礙廁位。`
        : '一般公廁，資料未標示無障礙廁位。',
      facility.address || `${facility.category}公廁`,
    ]
  }
  if (facility.kind === 'audible_signal') {
    return [
      `${facility.district} · 號誌編號 ${facility.signalId}`,
      '路口設有有聲號誌，可作為視障步行路線的友善證據。',
    ]
  }

  const escapedExit = facility.exit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const exitMention = new RegExp(`出口\\s*${escapedExit}(?![A-Z0-9])`, 'i')
  const relatedElevators = facility.elevatorLocation
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && exitMention.test(line))

  const restroomExitMention = /^[A-Z]/i.test(facility.exit)
    ? new RegExp(`${escapedExit}(?![A-Z0-9])`, 'i')
    : exitMention
  const relatedRestrooms = facility.accessibleRestrooms
    .split(/[；。]/)
    .map(line => line.trim())
    .filter(line => line && restroomExitMention.test(line))

  if (!relatedElevators.length) {
    return ['此點位未能與站內電梯編號自動對應，請依現場指標確認。']
  }

  return [
    ...relatedElevators,
    ...relatedRestrooms.map(line => `附近無障礙廁所：${line}`),
  ]
}

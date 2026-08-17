import type { GeometryPrecision, LatLngPoint as ApiLatLngPoint } from './types/api'

export type AccessibilityMode = 'general' | 'visual' | 'wheelchair' | 'elderly'
export type AppPhase = 'chat' | 'map'

/** 一個座標點，供地圖畫線與導覽動畫使用。與後端 AnnotatedLeg.path 對齊。 */
export type LatLngPoint = ApiLatLngPoint

export interface RouteStep {
  type: 'walk' | 'mrt' | 'bus'
  description: string
  detail?: string
  duration: number
  accessible: boolean
  hasElevator?: boolean
  line?: string
  stationId?: string // 對應 corridor.ts 的站點 id
  path?: LatLngPoint[]
  geometryPrecision?: GeometryPrecision
  transitRouteName?: string
  transitRouteUid?: string
  transitDirection?: number
  boardingStopUid?: string
  alightingStopUid?: string
}

export interface PlannedRoute {
  id: string
  label: string
  from: string
  to: string
  totalMinutes: number
  segments: number // 大眾運輸搭乘段數；轉乘次數 = segments - 1，不包含步行段
  steps: RouteStep[]
  fullyAccessible: boolean
  reason: string
  excluded: boolean
  excludeReason?: string
}

export interface Message {
  id: string
  role: 'agent' | 'user'
  content: string
  timestamp: Date
}

// 從對話中學到的使用者資訊
export interface UserProfile {
  mode: AccessibilityMode
  detail: string // e.g. "手動輪椅・步行 ≤ 300m"
}

export type AccessibilityMode = 'general' | 'visual' | 'wheelchair' | 'elderly'
export type AppPhase = 'chat' | 'map'

/** 一個座標點，供地圖畫線與模擬動畫使用。與後端 AnnotatedLeg.path 對齊。 */
export interface LatLngPoint {
  lat: number
  lng: number
  altitude?: number | null
}

export interface RouteStep {
  type: 'walk' | 'mrt' | 'bus'
  description: string
  detail?: string
  duration: number
  accessible: boolean
  hasElevator?: boolean
  line?: string
  stationId?: string // 對應 corridor.ts 的站點 id
  /**
   * 這段路的座標序列，直接來自後端 AnnotatedLeg.path。
   * 沒有幾何資料時為 undefined（例如 mock 資料、或後端回傳空陣列）——
   * 畫地圖 / 跑模擬動畫前一律要檢查存在且長度 >= 2。
   */
  path?: LatLngPoint[]
  /** 'approximate' | 'missing'，對應後端 geometry_precision。 */
  geometryPrecision?: 'approximate' | 'missing'
}

export interface PlannedRoute {
  id: string
  label: string
  from: string
  to: string
  totalMinutes: number
  segments: number
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

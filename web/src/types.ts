export type AccessibilityMode = 'general' | 'visual' | 'wheelchair' | 'elderly'
export type AppPhase = 'chat' | 'map'

export interface RouteStep {
  type: 'walk' | 'mrt' | 'bus'
  description: string
  detail?: string
  duration: number
  accessible: boolean
  hasElevator?: boolean
  line?: string
  stationId?: string // 對應 corridor.ts 的站點 id
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

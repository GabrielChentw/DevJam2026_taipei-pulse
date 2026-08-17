import type { AccessibilityMode, Message, PlannedRoute, RouteStep } from './types'

// ── 路線建構 ──────────────────────────────────────────────────────────────────

function buildRoutes(from: string, to: string, mode: AccessibilityMode, wheelchairType?: string): PlannedRoute[] {
  const walk = (desc: string, detail: string, min: number, accessible: boolean, elevator?: boolean): RouteStep => ({
    type: 'walk', description: desc, detail, duration: min, accessible, hasElevator: elevator,
  })
  const mrt = (detail: string, min: number, stationId?: string): RouteStep => ({
    type: 'mrt', description: '搭乘捷運板南線', detail, duration: min,
    accessible: true, hasElevator: true, line: '板南線', stationId,
  })
  const bus = (detail: string, min: number, accessible: boolean): RouteStep => ({
    type: 'bus', description: '搭乘公車 33 路', detail, duration: min, accessible, line: '33路',
  })

  const wheelchairNote = wheelchairType === 'electric'
    ? '電動輪椅可直接進入無障礙候車區，車廂設有固定裝置'
    : '手動輪椅建議使用 2 號無障礙出口，月台工作人員可協助'

  const routeA: PlannedRoute = {
    id: 'A', label: '路線 A', from, to,
    totalMinutes: 24, segments: 1,
    steps: [
      walk(`步行至${from}捷運站`, '約 300 公尺，人行道平坦', 5, true, true),
      mrt(`${from} → ${to}，6 站不換乘`, 15, 'BL12'),
      walk(`步行至${to}`, '約 200 公尺，地面平坦', 4, true),
    ],
    fullyAccessible: true,
    excluded: false,
    reason: {
      wheelchair: `全程電梯可用，板南線各站均有無障礙出口。${wheelchairNote}`,
      visual: '板南線全程語音報站，轉乘次數最少（0 次），路線最單純，到站提示清晰',
      elderly: '全程捷運不換乘，車廂有座位，步行距離最短，最輕鬆的選擇',
      general: '最快路線，全程捷運不換乘，準點率高',
    }[mode],
  }

  const routeB: PlannedRoute = {
    id: 'B', label: '路線 B', from, to,
    totalMinutes: 34, segments: 2,
    steps: [
      walk('步行至公車站', '約 150 公尺，較近', 3, true),
      bus(`低地板公車・${from} → ${to}`, 25, mode === 'wheelchair'),
      walk(`步行至${to}`, '約 100 公尺', 6, true),
    ],
    fullyAccessible: mode !== 'visual',
    excluded: false,
    reason: {
      wheelchair: '低地板公車 33 路，輪椅可直接上下車，下一班約 6 分鐘後到站',
      visual: '公車較無語音提示，轉乘複雜度較高，建議優先考慮路線 A',
      elderly: '步行距離短，但公車站立時間較長，若在非尖峰時段可考慮',
      general: '公車沿途可觀察城市風景，適合不趕時間時的選擇',
    }[mode],
  }

  const routeC: PlannedRoute = {
    id: 'C', label: '路線 C', from, to,
    totalMinutes: 19, segments: 1,
    steps: [
      walk('步行至忠孝新生站 1 號出口', '約 100 公尺（路程較近）', 2, false),
      mrt('板南線，僅 4 站', 12, 'BL14'),
      walk(`步行至${to}`, '約 400 公尺', 5, true),
    ],
    fullyAccessible: false,
    excluded: true,
    reason: '',
    excludeReason: {
      wheelchair: '忠孝新生站 1 號出口目前僅有樓梯，無電梯替代方案，輪椅無法通行',
      visual: '出站後步行段需穿越 3 個路口，且部分路段無導盲磚，風險較高',
      elderly: '出站後步行距離長達 400 公尺，且路段較為複雜，不建議高齡者使用',
      general: '出站後步行段較長（400 公尺），與路線 A 時間差距不大，整體不划算',
    }[mode],
  }

  return [routeA, routeB, routeC]
}

// ── 從訊息歷史萃取已知資訊 ────────────────────────────────────────────────────

interface GatheredInfo {
  mode?: AccessibilityMode
  from?: string
  to?: string
  wheelchairType?: 'manual' | 'electric'
  walkDuration?: number   // 分鐘
  askedMode: boolean
  askedRoute: boolean
  askedWheelchairDetail: boolean
}

const MODE_KEYWORDS: { keywords: string[]; mode: AccessibilityMode }[] = [
  { keywords: ['輪椅', '坐輪椅', '電動輪椅', '手動輪椅', '乘坐輪椅'], mode: 'wheelchair' },
  { keywords: ['視障', '盲', '看不見', '視力', '導盲', '失明'], mode: 'visual' },
  { keywords: ['高齡', '老人', '長輩', '年長', '老年', '銀髮', '爸爸', '媽媽', '阿公', '阿嬤'], mode: 'elderly' },
  { keywords: ['一般', '正常', '普通', '沒有特殊'], mode: 'general' },
]

const DEST_RE = /(.+?)\s*[到→至去前往]\s*(.+)/

function detectMode(text: string): AccessibilityMode | undefined {
  for (const { keywords, mode } of MODE_KEYWORDS) {
    if (keywords.some(k => text.includes(k))) return mode
  }
  return undefined
}

function detectWheelchairType(text: string): 'manual' | 'electric' | undefined {
  if (text.includes('電動')) return 'electric'
  if (text.includes('手動') || text.includes('手推')) return 'manual'
  return undefined
}

function extractWalkDuration(text: string): number | undefined {
  const m = /(\d+)\s*分/.exec(text)
  return m ? parseInt(m[1]) : undefined
}

function gatherInfo(messages: Message[], currentInput: string): GatheredInfo {
  const allUserTexts = [
    ...messages.filter(m => m.role === 'user').map(m => m.content),
    currentInput,
  ]
  const allAgentTexts = messages.filter(m => m.role === 'agent').map(m => m.content)

  let mode: AccessibilityMode | undefined
  let from: string | undefined
  let to: string | undefined
  let wheelchairType: 'manual' | 'electric' | undefined
  let walkDuration: number | undefined

  for (const text of allUserTexts) {
    if (!mode) mode = detectMode(text)
    if (!wheelchairType) wheelchairType = detectWheelchairType(text)
    if (!walkDuration) walkDuration = extractWalkDuration(text)
    if (!from || !to) {
      const m = DEST_RE.exec(text.trim())
      if (m) { from = m[1].trim(); to = m[2].trim() }
    }
  }

  const askedMode = allAgentTexts.some(t =>
    t.includes('行動需求') || t.includes('障礙') || t.includes('輪椅') && t.includes('？')
  )
  const askedRoute = allAgentTexts.some(t =>
    t.includes('起點') || t.includes('目的地') || t.includes('哪裡')
  )
  const askedWheelchairDetail = allAgentTexts.some(t =>
    t.includes('手動') || t.includes('電動') || t.includes('輪椅型號')
  )

  return { mode, from, to, wheelchairType, walkDuration, askedMode, askedRoute, askedWheelchairDetail }
}

// ── AgentResponse ──────────────────────────────────────────────────────────────

import type { ChatResponse, PlanResponse, EvaluatedRoute } from './types/api'

export interface AgentResponse {
  content: string
  detectedMode?: AccessibilityMode
  routesReady?: boolean
  routes?: PlannedRoute[]
  from?: string
  to?: string
  profileDetail?: string
  /** 後端 /api/chat 的完整回應（含 camera_commands）*/
  chatResponse?: ChatResponse
}

// ── 後端 EvaluatedRoute → 前端 PlannedRoute 轉換 ─────────────────────────────

function legMode(m: 'walk' | 'metro' | 'bus'): 'walk' | 'mrt' | 'bus' {
  return m === 'metro' ? 'mrt' : m
}

function evalToPlanned(r: EvaluatedRoute, excluded: boolean, origin: string, dest: string): PlannedRoute {
  return {
    id: r.candidate_id,
    label: r.label,
    from: origin,
    to: dest,
    totalMinutes: r.duration_min,
    segments: r.legs.length,
    steps: r.legs.map(leg => ({
      type: legMode(leg.mode),
      description: leg.name,
      detail: leg.features['slope']?.detail ?? leg.features['surface']?.detail ?? undefined,
      duration: leg.duration_min,
      accessible: r.violations.filter(v => v.leg_index === leg.index).length === 0,
      hasElevator: leg.features['elevator_available']?.value === true,
      line: leg.mode === 'metro' ? '板南線' : undefined,
      // 直接沿用後端算好的座標，不要重新猜測 —— 這是畫線與模擬動畫的唯一依據。
      path: leg.path,
      geometryPrecision: leg.geometry_precision,
    })),
    fullyAccessible: r.feasible && r.violations.length === 0,
    excluded,
    reason: r.explanation ?? '',
    excludeReason: excluded
      ? r.violations.map(v => v.reason).join('；')
      : undefined,
  }
}

export function planToRoutes(plan: PlanResponse, origin = '', dest = ''): PlannedRoute[] {
  return [
    ...plan.feasible.map(r => evalToPlanned(r, false, origin, dest)),
    ...plan.excluded.map(r => evalToPlanned(r, true, origin, dest)),
  ]
}

// ── 主函數 ────────────────────────────────────────────────────────────────────

export function getMockAgentResponse(
  messages: Message[],
  userInput: string,
  _mode: AccessibilityMode,   // 現在由對話自動偵測，這個參數保留相容性
): AgentResponse {
  const info = gatherInfo(messages, userInput)

  // ── 已有足夠資訊 → 給路線 ──────────────────────────────────────────────────
  const readyForRoutes =
    info.mode &&
    info.from &&
    info.to &&
    (info.mode !== 'wheelchair' || info.askedWheelchairDetail || info.wheelchairType)

  if (readyForRoutes && info.mode && info.from && info.to) {
    const routes = buildRoutes(info.from, info.to, info.mode, info.wheelchairType)

    const profileParts: string[] = []
    if (info.wheelchairType === 'electric') profileParts.push('電動輪椅')
    else if (info.wheelchairType === 'manual') profileParts.push('手動輪椅')
    if (info.walkDuration) profileParts.push(`步行耐力 ${info.walkDuration} 分鐘`)

    const profileDetail = profileParts.join('・') || {
      general: '一般路線',
      visual: '語音友善・少轉乘',
      wheelchair: '無障礙・電梯優先',
      elderly: '少換乘・輕鬆步行',
    }[info.mode]

    const intro = {
      wheelchair: `已確認全程電梯與無障礙出口，為您篩選了 ${routes.filter(r => !r.excluded).length} 條可行路線，請在右側查看。`,
      visual: `已篩選語音友善、轉乘最少的路線，請在右側選擇。`,
      elderly: `已安排換乘最少的輕鬆路線，請在右側選擇。`,
      general: `已為您規劃從「${info.from}」到「${info.to}」的路線，請在右側選擇。`,
    }[info.mode]

    return {
      content: intro,
      detectedMode: info.mode,
      routesReady: true,
      routes,
      from: info.from,
      to: info.to,
      profileDetail,
    }
  }

  // ── 知道模式但缺起終點 → 詢問路線（+ 輪椅細節一起問）─────────────────────
  if (info.mode && (!info.from || !info.to)) {
    if (info.mode === 'wheelchair') {
      const wheelchairQ = info.wheelchairType
        ? ''
        : '\n\n另外，您使用的是**手動輪椅**還是**電動輪椅**？這有助於我確認無障礙設施是否適合。'
      return {
        content: `了解，我會為您規劃適合的無障礙路線。\n\n請告訴我您的**起點和目的地**，例如「台北車站到市政府」。${wheelchairQ}`,
        detectedMode: info.mode,
      }
    }
    const modeMsg = {
      visual: '了解，我會確認路線的語音導覽資訊。',
      elderly: '了解，我會安排換乘最少、步行距離短的路線。',
      general: '好的！',
    }[info.mode] ?? '好的！'
    return {
      content: `${modeMsg}\n\n請告訴我您的**起點和目的地**，例如「台北車站到市政府」。`,
      detectedMode: info.mode,
    }
  }

  // ── 知道輪椅模式但缺輪椅細節 → 問輪椅型號 ────────────────────────────────
  if (info.mode === 'wheelchair' && info.from && info.to && !info.wheelchairType) {
    return {
      content: `好的，${info.from}到${info.to}的路線我查到了。\n\n請問您使用的是**手動輪椅**還是**電動輪椅**？（這影響到月台服務與候車位置的安排）`,
      detectedMode: info.mode,
    }
  }

  // ── 什麼都不知道，或只有含糊輸入 → 問障礙類型 ────────────────────────────
  return {
    content: '您好！我是 Taipei Pulse 路線助理，可以為您規劃無障礙大眾運輸路線。\n\n請問您有哪些**行動需求**？例如：\n・使用輪椅（手動/電動）\n・視力障礙\n・高齡長輩\n・一般使用者\n\n直接描述您的狀況即可，我會依此為您篩選合適的路線。',
  }
}

// ── 快速問題（依模式）────────────────────────────────────────────────────────
export const QUICK_ACTIONS: Record<AccessibilityMode, string[]> = {
  general:    ['台北車站到市政府', '我使用電動輪椅', '我有視力障礙', '高齡長輩出行'],
  visual:     ['台北車站到市政府', '我有視力障礙'],
  wheelchair: ['台北車站到市政府', '我使用電動輪椅', '我使用手動輪椅'],
  elderly:    ['台北車站到市政府', '高齡長輩出行'],
}

// 初始快速動作（無模式時顯示）
export const INITIAL_QUICK_ACTIONS = [
  '我使用電動輪椅',
  '我有視力障礙',
  '高齡長輩出行',
  '一般使用者',
]

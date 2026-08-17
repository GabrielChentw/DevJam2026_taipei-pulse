/**
 * Gemini API 整合
 * 使用 Google AI Studio REST API，不依賴 SDK，零額外安裝。
 * API Key 放在 VITE_GEMINI_API_KEY（web/.env.local）。
 */

import type { AccessibilityMode, Message } from '../types'

const API_KEY = import.meta.env.VITE_GEMINI_API_KEY as string | undefined
const MODEL   = 'gemini-3.6-flash'
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`

// ── System Prompt ─────────────────────────────────────────────────────────────

function buildSystemPrompt(mode: AccessibilityMode): string {
  const modeDesc = {
    general:    '尚未指定無障礙需求（請先詢問需求）',
    visual:     '視障使用者（需要語音友善路線、少轉乘、有語音報站）',
    wheelchair: '輪椅使用者（需要全程電梯、無階梯、無障礙出口）',
    elderly:    '高齡使用者（偏好少換乘、步行距離短、座位充足）',
  }[mode]

  return `你是「Taipei Pulse 路線助理」，一個專為台北無障礙大眾運輸設計的 AI Agent。

目前使用者身份：${modeDesc}

你的核心任務：
1. 透過對話了解使用者的起點、終點與隱性需求（不要直接問太多問題，自然對話）
2. 根據使用者身份主動詢問關鍵資訊（輪椅類型、步行上限、語音需求等）
3. 找到起點和終點後，告知使用者路線正在規劃中
4. 解釋推薦原因，特別是為什麼不推薦某些路線

當你認為已掌握足夠資訊可以規劃路線時，在回覆的最後加上以下 JSON 標記（必須放在訊息最後）：

<ROUTE_READY>
{"from":"起點名稱","to":"終點名稱","profile":"使用者特徵描述，例如手動輪椅・步行≤300m"}
</ROUTE_READY>

注意事項：
- 全程使用繁體中文
- 口吻友善、清晰，不要過度正式
- 不要在同一則訊息裡問超過兩個問題
- 如果使用者直接說起點和終點，且角色不需要追問（一般/高齡），立刻回覆並加上 ROUTE_READY 標記`
}

// ── 型別 ──────────────────────────────────────────────────────────────────────

export interface GeminiResponse {
  text: string
  routeSignal?: { from: string; to: string; profile: string }
}

// ── 對話歷史轉換 ──────────────────────────────────────────────────────────────

function toGeminiHistory(messages: Message[]) {
  return messages.map(m => ({
    role: m.role === 'user' ? 'user' : 'model',
    parts: [{ text: m.content }],
  }))
}

// ── 主要函式 ──────────────────────────────────────────────────────────────────

export async function askGemini(
  messages: Message[],
  userInput: string,
  mode: AccessibilityMode,
): Promise<GeminiResponse> {
  if (!API_KEY) throw new Error('VITE_GEMINI_API_KEY 未設定')

  const history = toGeminiHistory(messages)

  const body = {
    system_instruction: { parts: [{ text: buildSystemPrompt(mode) }] },
    contents: [
      ...history,
      { role: 'user', parts: [{ text: userInput }] },
    ],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 1024,
    },
  }

  const res = await fetch(`${API_URL}?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Gemini API 錯誤 ${res.status}: ${err}`)
  }

  const data = await res.json() as {
    candidates: Array<{ content: { parts: Array<{ text: string }> } }>
  }

  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''

  // 解析 ROUTE_READY 標記
  const routeMatch = /<ROUTE_READY>\s*([\s\S]*?)\s*<\/ROUTE_READY>/.exec(raw)
  let routeSignal: GeminiResponse['routeSignal'] | undefined

  if (routeMatch) {
    try {
      routeSignal = JSON.parse(routeMatch[1]) as { from: string; to: string; profile: string }
    } catch {
      // JSON 解析失敗就忽略
    }
  }

  // 去掉標記，只保留對話文字
  const text = raw.replace(/<ROUTE_READY>[\s\S]*?<\/ROUTE_READY>/g, '').trim()

  return { text, routeSignal }
}

export const isGeminiConfigured = !!API_KEY

import type { PlannedRoute, RouteStep } from '../types'

const SPEECH_RATE_KEY = 'taipei-pulse-speech-rate'
const DEFAULT_SPEECH_RATE = 1.5

export const SPEECH_RATES = [1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const

export function getSpeechRate() {
  const saved = Number(window.localStorage.getItem(SPEECH_RATE_KEY))
  return SPEECH_RATES.includes(saved as (typeof SPEECH_RATES)[number]) ? saved : DEFAULT_SPEECH_RATE
}

export function setSpeechRate(rate: number) {
  window.localStorage.setItem(SPEECH_RATE_KEY, String(rate))
}

export function speak(text: string, rate = getSpeechRate(), onFinish?: () => void) {
  if (!('speechSynthesis' in window)) return false
  window.speechSynthesis.cancel()
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.lang = 'zh-TW'
  utterance.rate = rate
  utterance.onend = () => onFinish?.()
  utterance.onerror = () => onFinish?.()
  window.speechSynthesis.speak(utterance)
  return true
}

export function stopSpeaking() {
  if ('speechSynthesis' in window) window.speechSynthesis.cancel()
}

export function pauseSpeaking() {
  if ('speechSynthesis' in window) window.speechSynthesis.pause()
}

export function resumeSpeaking() {
  if ('speechSynthesis' in window) window.speechSynthesis.resume()
}

function cleanSpeechText(text: string) {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[*-]\s+/gm, '')
    .replace(/\*\*/g, '')
    .replace(/^-{3,}$/gm, '')
    .replace(/\r?\n+/g, '。')
    .replace(/。{2,}/g, '。')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 將一般對話縮成可自然朗讀的 2～3 個重點，不逐字念完整長文。 */
export function getAgentSpeechSummary(text: string) {
  const cleaned = cleanSpeechText(text)
  const phrases = cleaned
    .split(/(?<=[。！？])/u)
    .map(phrase => phrase.trim())
    .filter(Boolean)
    .filter(phrase => !/(不建議|不推薦|排除的路線|被排除)/.test(phrase))

  const selected: string[] = []
  let length = 0
  for (const phrase of phrases) {
    if (selected.length >= 3 || (selected.length > 0 && length + phrase.length > 130)) break
    selected.push(phrase)
    length += phrase.length
  }

  const summary = selected.join('') || cleaned.slice(0, 110)
  return /[。！？]$/.test(summary) ? summary : `${summary}。`
}

function stepSpeech(step: RouteStep, index: number) {
  const prefix = index === 0 ? '先' : '再'
  if (step.type === 'walk') return `${prefix}步行${step.duration}分鐘`
  if (step.type === 'mrt') return `${prefix}搭乘${step.line ?? '捷運'}${step.duration}分鐘`
  return `${prefix}搭乘${step.line ?? '公車'}${step.duration}分鐘`
}

export function getRouteSpeechSummary(route: PlannedRoute) {
  const steps = route.steps.map(stepSpeech).join('，')
  const transfer = route.segments <= 1 ? '免轉乘' : `需要轉乘${route.segments - 1}次`
  const accessible = route.fullyAccessible ? '，全程無障礙' : ''
  return `推薦路線是${route.label}，全程約${route.totalMinutes}分鐘。${steps}。${transfer}${accessible}。`
}

/** 只選第一條可行路線；不朗讀任何被排除或不建議路線。 */
export function getRecommendedRouteSpeech(routes: PlannedRoute[]) {
  const recommended = routes.find(route => !route.excluded)
  return recommended ? getRouteSpeechSummary(recommended) : null
}

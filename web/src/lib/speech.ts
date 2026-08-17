const SPEECH_RATE_KEY = 'taipei-pulse-speech-rate'
const DEFAULT_SPEECH_RATE = 1.5

export const SPEECH_RATES = [1, 1.25, 1.5, 1.75, 2] as const

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

import { useState, useRef, useEffect, useCallback } from 'react'
import type { AccessibilityMode, Message } from '../types'
import { sendChatMessage } from '../lib/api'
import { getMockAgentResponse, planToRoutes, sanitizeUserFacingScore, INITIAL_QUICK_ACTIONS } from '../mockData'
import type { AgentResponse } from '../mockData'
import { speak } from '../lib/speech'

// ── TTS ───────────────────────────────────────────────────────────────────────

// ── 型別 ─────────────────────────────────────────────────────────────────────

interface Props {
  mode: AccessibilityMode
  messages: Message[]
  onAddMessage: (msg: Message) => void
  onAgentResponse: (res: AgentResponse) => void
}

function ChatAvatar({ role }: { role: Message['role'] }) {
  const isAgent = role === 'agent'
  return (
    <span className={`chat-avatar ${isAgent ? 'is-agent' : 'is-user'}`} aria-hidden="true">
      {isAgent ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3v2" /><rect x="4" y="6" width="16" height="14" rx="4" />
          <circle cx="9" cy="12" r="1" fill="currentColor" /><circle cx="15" cy="12" r="1" fill="currentColor" />
          <path d="M9 16h6" />
        </svg>
      ) : (
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="8" r="4" /><path d="M4.5 21a7.5 7.5 0 0 1 15 0" />
        </svg>
      )}
    </span>
  )
}

// ── SpeechRecognition 瀏覽器相容 ─────────────────────────────────────────────

const SpeechRecognitionAPI =
  (typeof window !== 'undefined' &&
    ((window as unknown as { SpeechRecognition?: typeof SpeechRecognition }).SpeechRecognition ||
     (window as unknown as { webkitSpeechRecognition?: typeof SpeechRecognition }).webkitSpeechRecognition)) ||
  null

// ── Component ────────────────────────────────────────────────────────────────

export default function ChatPanel({ mode, messages, onAddMessage, onAgentResponse }: Props) {
  const [input, setInput]         = useState('')
  const [typing, setTyping]       = useState(false)
  const [listening, setListening] = useState(false)
  const [micError, setMicError]   = useState<string | null>(null)
  const bottomRef      = useRef<HTMLDivElement>(null)
  const textareaRef    = useRef<HTMLTextAreaElement>(null)
  const recognitionRef = useRef<InstanceType<typeof SpeechRecognition> | null>(null)
  // 同一次對話全程重複使用同一個 session id（API 合約要求）
  const sessionIdRef   = useRef(crypto.randomUUID())

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, typing])

  // ── 送出訊息（Gemini 或 Mock 降級）────────────────────────────────────────

  const send = useCallback(async (text: string) => {
    if (!text.trim() || typing) return
    const userMsg: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: text.trim(),
      timestamp: new Date(),
    }
    onAddMessage(userMsg)
    setInput('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    setTyping(true)

    // ── 優先接後端 /api/chat ──────────────────────────────────────────────────
    try {
      const chatRes = await sendChatMessage(sessionIdRef.current, text.trim())
      setTyping(false)
      const userFacingReply = sanitizeUserFacingScore(chatRes.reply)

      const agentMsg: Message = {
        id: (Date.now() + 1).toString(),
        role: 'agent',
        content: userFacingReply,
        timestamp: new Date(),
      }
      onAddMessage(agentMsg)
      if (mode === 'visual') speak(userFacingReply)

      const agentRes: AgentResponse = {
        content: userFacingReply,
        chatResponse: chatRes,
      }

      // plan 有值 → 路線出爐
      if (chatRes.plan) {
        agentRes.routesReady = true
        agentRes.routes = planToRoutes(chatRes.plan, chatRes.plan.origin, chatRes.plan.destination)
        agentRes.from = chatRes.plan.origin
        agentRes.to = chatRes.plan.destination
        agentRes.profileDetail = chatRes.plan.profile_label
      }

      onAgentResponse(agentRes)
    } catch {
      // ── 後端不在線 → Mock 降級 ──────────────────────────────────────────────
      setTimeout(() => {
        const res = getMockAgentResponse(messages, text.trim(), mode)
        setTyping(false)
        const agentMsg: Message = {
          id: (Date.now() + 1).toString(),
          role: 'agent',
          content: res.content,
          timestamp: new Date(),
        }
        onAddMessage(agentMsg)
        if (mode === 'visual') speak(res.content)
        onAgentResponse(res)
      }, 600 + Math.random() * 500)
    }
  }, [messages, mode, typing, onAddMessage, onAgentResponse])

  // ── 語音輸入 ──────────────────────────────────────────────────────────────

  const toggleMic = useCallback(() => {
    if (!SpeechRecognitionAPI) {
      setMicError('此瀏覽器不支援語音輸入，請使用 Chrome 或 Edge')
      setTimeout(() => setMicError(null), 3000)
      return
    }

    if (listening) {
      recognitionRef.current?.stop()
      return
    }

    setMicError(null)
    const rec = new SpeechRecognitionAPI()
    rec.lang = 'zh-TW'
    rec.interimResults = true
    rec.continuous = false

    rec.onstart = () => setListening(true)
    rec.onend   = () => setListening(false)
    rec.onerror = (e: SpeechRecognitionErrorEvent) => {
      setListening(false)
      if (e.error === 'not-allowed') {
        setMicError('請允許麥克風權限後再試')
      } else if (e.error !== 'no-speech') {
        setMicError(`語音辨識錯誤：${e.error}`)
      }
      setTimeout(() => setMicError(null), 3000)
    }

    rec.onresult = (e: SpeechRecognitionEvent) => {
      const transcript = Array.from(e.results)
        .map(r => r[0].transcript)
        .join('')
      setInput(transcript)
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto'
        textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 100) + 'px'
      }
      // 最後一個結果（isFinal）就直接送出
      if (e.results[e.results.length - 1].isFinal) {
        rec.stop()
        // 稍等一下再送（讓 state 更新）
        setTimeout(() => send(transcript), 80)
      }
    }

    recognitionRef.current = rec
    rec.start()
  }, [listening, send])

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(input) }
  }

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    e.target.style.height = 'auto'
    e.target.style.height = Math.min(e.target.scrollHeight, 100) + 'px'
  }

  // 有路線後就不再顯示快速選項
  const hasRoutes = messages.some(m => m.role === 'agent' && m.content.includes('右側'))

  // ── 渲染 ──────────────────────────────────────────────────────────────────

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', flex: 1, height: '100%',
      background: 'var(--bg-panel)',
      borderRight: '1.5px solid var(--border)',
    }}>

      {/* Messages */}
      <div style={{
        flex: 1, overflowY: 'auto', padding: '22px 18px',
        display: 'flex', flexDirection: 'column', gap: 18,
      }}>
        {/* 歡迎提示 */}
        {messages.length === 0 && (
          <div style={{ textAlign: 'center', padding: '28px 12px', color: 'var(--text-muted)', fontSize: 14, lineHeight: 1.8 }}>
            <div style={{
              width: 52, height: 52, borderRadius: 15, background: 'var(--green-light)',
              border: '1.5px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px',
            }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--green)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 20l-5.447-2.724A1 1 0 0 1 3 16.382V5.618a1 1 0 0 1 1.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0 0 21 18.382V7.618a1 1 0 0 0-.553-.894L15 4m0 13V4M9 7l6-3"/>
              </svg>
            </div>
            <div style={{ fontWeight: 600, color: 'var(--text-secondary)', fontSize: 15, marginBottom: 4 }}>您好，我是路線助理</div>
            告訴我您的需求，我來為您規劃最合適的無障礙路線
          </div>
        )}

        {messages.map(msg => (
          <div key={msg.id} className={`chat-message-row fade-up ${msg.role === 'user' ? 'is-user' : 'is-agent'}`}>
            <ChatAvatar role={msg.role} />
            <div className="chat-message-body">
              <div className="chat-message-author">{msg.role === 'agent' ? '路線助理' : '您'}</div>
              <div style={{ position: 'relative', maxWidth: '100%' }}>
              <div style={{
                padding: '11px 15px',
                borderRadius: msg.role === 'user' ? '16px 4px 16px 16px' : '4px 16px 16px 16px',
                background: msg.role === 'user' ? 'var(--bubble-user)' : 'var(--bubble-agent)',
                color: msg.role === 'user' ? 'var(--bubble-user-text)' : 'var(--bubble-agent-text)',
                fontSize: 14.5, lineHeight: 1.75, whiteSpace: 'pre-wrap',
                boxShadow: 'var(--shadow-xs)',
                border: msg.role === 'agent' ? '1.5px solid var(--border)' : 'none',
              }}>
                {msg.role === 'agent'
                  ? sanitizeUserFacingScore(msg.content).split(/(\*\*[^*]+\*\*)/).map((part, i) =>
                      part.startsWith('**') && part.endsWith('**')
                        ? <strong key={i}>{part.slice(2, -2)}</strong>
                        : part
                    )
                  : msg.content
                }
              </div>
              {msg.role === 'agent' && (
                <button
                  onClick={() => speak(msg.content.replace(/\*\*/g, ''))}
                  title="朗讀此訊息"
                  style={{
                    position: 'absolute', bottom: -8, right: 4,
                    width: 24, height: 24, borderRadius: 6,
                    background: 'var(--bg-card)', border: '1px solid var(--border)',
                    color: 'var(--text-muted)', cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    boxShadow: 'var(--shadow-xs)',
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                    <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
                    <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
                  </svg>
                </button>
              )}
              </div>
            </div>
          </div>
        ))}

        {/* Typing indicator */}
        {typing && (
          <div className="chat-message-row is-agent fade-up">
            <ChatAvatar role="agent" />
            <div className="chat-message-body">
              <div className="chat-message-author">路線助理</div>
              <div style={{
                display: 'inline-flex', padding: '10px 16px', gap: 5, alignItems: 'center',
                borderRadius: '4px 16px 16px 16px',
                background: 'var(--bubble-agent)', border: '1.5px solid var(--border)',
                boxShadow: 'var(--shadow-xs)',
              }}>
                {[0, 1, 2].map(i => (
                  <span key={i} className="typing-dot" style={{
                    width: 6, height: 6, borderRadius: '50%', background: 'var(--green)', display: 'inline-block',
                    animationDelay: `${i * 0.2}s`,
                  }} />
                ))}
              </div>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* 麥克風錯誤提示 */}
      {micError && (
        <div style={{
          margin: '0 18px 4px', padding: '8px 12px', borderRadius: 8,
          background: '#fff3cd', border: '1px solid #ffc107',
          color: '#856404', fontSize: 12.5,
        }}>
          ⚠️ {micError}
        </div>
      )}

      {/* 快速問題 */}
      {!hasRoutes && (
        <div style={{
          padding: '8px 18px 0', display: 'flex', gap: 6, flexWrap: 'wrap',
          borderTop: '1.5px solid var(--border)', background: 'var(--bg-card)',
        }}>
          {INITIAL_QUICK_ACTIONS.map(q => (
            <button key={q} onClick={() => void send(q)} style={{
              padding: '4px 12px', borderRadius: 20,
              border: '1.5px solid var(--border)', background: 'var(--bg-panel)',
              color: 'var(--text-secondary)', fontSize: 12.5,
              cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.15s',
            }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--green)'; e.currentTarget.style.color = 'var(--green)'; e.currentTarget.style.background = 'var(--green-light)' }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-secondary)'; e.currentTarget.style.background = 'var(--bg-panel)' }}
            >
              {q}
            </button>
          ))}
        </div>
      )}

      {/* Input bar */}
      <div style={{ padding: '10px 18px 16px', display: 'flex', gap: 8, alignItems: 'flex-end', background: 'var(--bg-card)' }}>
        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleInput}
          onKeyDown={handleKey}
          placeholder={listening ? '🎙️ 請說話…' : '輸入您的需求或起終點…'}
          rows={1}
          style={{
            flex: 1, background: listening ? 'var(--green-light)' : 'var(--bg-input)',
            border: `1.5px solid ${listening ? 'var(--green)' : 'var(--border)'}`,
            borderRadius: 12, padding: '9px 14px', color: 'var(--text-primary)',
            fontSize: 14, resize: 'none', outline: 'none',
            lineHeight: 1.5, fontFamily: 'inherit', overflow: 'hidden',
            transition: 'all 0.15s',
          }}
          onFocus={e => { if (!listening) e.target.style.borderColor = 'var(--border-focus)' }}
          onBlur={e => { if (!listening) e.target.style.borderColor = 'var(--border)' }}
        />

        {/* 麥克風按鈕 */}
        <button
          onClick={toggleMic}
          title={listening ? '停止語音輸入' : (SpeechRecognitionAPI ? '語音輸入' : '此瀏覽器不支援語音輸入')}
          style={{
            width: 38, height: 38, borderRadius: 10, flexShrink: 0,
            background: listening ? 'var(--green)' : 'var(--bg-input)',
            border: `1.5px solid ${listening ? 'var(--green)' : 'var(--border)'}`,
            color: listening ? '#fff' : (SpeechRecognitionAPI ? 'var(--text-secondary)' : 'var(--text-muted)'),
            cursor: SpeechRecognitionAPI ? 'pointer' : 'not-allowed',
            opacity: SpeechRecognitionAPI ? 1 : 0.5,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'all 0.15s',
            animation: listening ? 'mic-pulse 1s ease-in-out infinite' : 'none',
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3Z"/>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
            <line x1="12" x2="12" y1="19" y2="22"/>
          </svg>
        </button>

        {/* 送出 */}
        <button onClick={() => void send(input)} disabled={typing} style={{
          width: 38, height: 38, borderRadius: 10, flexShrink: 0,
          background: input.trim() && !typing ? 'var(--green)' : 'var(--bg-input)',
          border: '1.5px solid var(--border)',
          color: input.trim() && !typing ? '#fff' : 'var(--text-muted)',
          cursor: input.trim() && !typing ? 'pointer' : 'default',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'all 0.15s',
        }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>
          </svg>
        </button>
      </div>
    </div>
  )
}

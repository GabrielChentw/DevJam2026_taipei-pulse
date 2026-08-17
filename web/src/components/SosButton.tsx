import { useState } from 'react'

export default function SosButton() {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  const locationText = '台北市信義區忠孝東路五段 68 號附近（捷運市政府站 3 號出口）'

  const handleCopy = () => {
    navigator.clipboard.writeText(`我在這裡：${locationText}`).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <>
      <button onClick={() => setOpen(true)} style={{
        position: 'fixed', bottom: 24, right: 20, zIndex: 100,
        width: 54, height: 54, borderRadius: '50%',
        background: '#A03B3B', border: '2.5px solid #fff',
        color: '#fff', cursor: 'pointer',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2,
        boxShadow: '0 3px 14px rgba(160,59,59,0.45)',
        fontSize: 9, fontWeight: 800, letterSpacing: '0.5px',
      }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 1.27h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.84a16 16 0 0 0 6.29 6.29l1.34-1.34a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92Z"/>
        </svg>
        <span>緊急</span>
      </button>

      {open && (
        <div onClick={() => setOpen(false)} style={{
          position: 'fixed', inset: 0, zIndex: 200,
          background: 'rgba(0,0,0,0.4)',
          display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
        }}>
          <div onClick={e => e.stopPropagation()} className="slide-up" style={{
            width: '100%', maxWidth: 520,
            background: 'var(--bg-card)', borderRadius: '20px 20px 0 0',
            padding: '20px 20px 36px',
            border: '1.5px solid var(--border)', borderBottom: 'none',
            boxShadow: '0 -4px 24px rgba(0,0,0,0.12)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
              <div style={{ width: 36, height: 36, borderRadius: 10, background: 'rgba(160,59,59,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginRight: 10 }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#A03B3B" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 1.27h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.84a16 16 0 0 0 6.29 6.29l1.34-1.34a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92Z"/>
                </svg>
              </div>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>需要協助</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>目前位置</div>
              </div>
              <button onClick={() => setOpen(false)} style={{
                marginLeft: 'auto', width: 30, height: 30, borderRadius: 8,
                background: 'var(--bg-base)', border: '1px solid var(--border)',
                cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)',
              }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>

            <div style={{
              background: 'var(--bg-base)', border: '1.5px solid var(--border)',
              borderRadius: 10, padding: '12px 14px', marginBottom: 14,
              fontSize: 13.5, color: 'var(--text-primary)', lineHeight: 1.5,
            }}>
              📍 {locationText}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <button onClick={handleCopy} style={{
                padding: '12px', borderRadius: 10,
                background: copied ? 'var(--green-light)' : 'var(--bg-base)',
                border: `1.5px solid ${copied ? 'var(--green)' : 'var(--border)'}`,
                color: copied ? 'var(--green)' : 'var(--text-primary)',
                fontSize: 14, fontWeight: 600, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                transition: 'all 0.15s', fontFamily: 'inherit',
              }}>
                {copied ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                )}
                {copied ? '已複製位置！' : '複製位置文字（傳給家人）'}
              </button>

              <a href="tel:110" style={{
                padding: '12px', borderRadius: 10,
                background: '#A03B3B', border: 'none',
                color: '#fff', fontSize: 14, fontWeight: 700,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                textDecoration: 'none',
              }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round">
                  <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 1.27h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.84a16 16 0 0 0 6.29 6.29l1.34-1.34a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92Z"/>
                </svg>
                撥打 110 報警
              </a>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

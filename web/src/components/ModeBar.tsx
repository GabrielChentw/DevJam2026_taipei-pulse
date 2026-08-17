import type { AccessibilityMode } from '../types'

const MODES: { key: AccessibilityMode; label: string; color: string; bg: string }[] = [
  { key: 'visual',     label: '視障',  color: '#6B3A6B', bg: '#F2EBF2' },
  { key: 'wheelchair', label: '輪椅',  color: '#3A5E6B', bg: '#EBF1F2' },
  { key: 'elderly',    label: '高齡者', color: '#8B5E3C', bg: '#F5EFE8' },
]

interface Props {
  value: AccessibilityMode
  onChange: (mode: AccessibilityMode) => void
}

export default function ModeBar({ value, onChange }: Props) {
  return (
    <div style={{
      display: 'flex',
      background: 'var(--bg-input)',
      borderRadius: 10,
      padding: 3,
      gap: 2,
      border: '1.5px solid var(--border)',
    }}>
      {MODES.map(({ key, label, color, bg }) => {
        const active = value === key
        return (
          <button
            key={key}
            onClick={() => onChange(key)}
            style={{
              padding: '4px 12px',
              borderRadius: 7,
              border: 'none',
              background: active ? bg : 'transparent',
              color: active ? color : 'var(--text-muted)',
              fontSize: 12,
              fontWeight: active ? 700 : 400,
              cursor: 'pointer',
              transition: 'all 0.15s',
              whiteSpace: 'nowrap',
              fontFamily: 'inherit',
            }}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}

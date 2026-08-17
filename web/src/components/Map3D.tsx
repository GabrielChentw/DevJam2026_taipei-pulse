import { useEffect, useRef, useState } from 'react';
import {
  loadMaps3d,
  onAuthFailure,
  emitAuthFailure,
  getLastRawMapsMessage,
  MissingApiKeyError,
  type Map3DElementLike,
  type Maps3dLibrary,
} from '../lib/googleMaps';
import { CAMERA_PRESETS } from '../data/corridor';

export type MapStatus =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'error'; message: string; hint?: string; code?: string | null; raw?: string | null };

/**
 * 建立後開一個看門狗，檢查 Google 是否在元素內部畫了自己的錯誤框
 * （驗證失敗的細節只寫進 console，元素內只會出現一段籠統的文字）。
 *
 * 重要：看門狗只用來偵測「失敗」，不用來判定「成功」。
 * 曾經把可見性綁在 gmp-steadystate 上，結果那個事件的語意是「圖磚全部載完且相機靜止」，
 * Photorealistic 3D 圖磚常常超過 8 秒還在串流，於是地圖明明在正常運作卻被遮罩蓋住。
 * 不要把 UI 的可見性綁在一個 Preview API 的事件上。
 */
const WATCHDOG_DELAY_MS = 10000;

/** Google 的錯誤框文字（多語言）。只取足以辨識的片段。 */
const GOOGLE_ERROR_PHRASES = [
  "didn't load Google Maps correctly",
  'did not load Google Maps correctly',
  '並未正確載入 Google 地圖',
  '未正确加载 Google 地图',
];

interface Map3DProps {
  /** 地圖與 maps3d 函式庫就緒時呼叫，父層可藉此加圖層或控制相機。 */
  onReady?: (map: Map3DElementLike, lib: Maps3dLibrary) => void;
  onStatusChange?: (status: MapStatus) => void;
}

const OPENING_PRESET = CAMERA_PRESETS.find((p) => p.id === 'cityHall')!;

export function Map3D({ onReady, onStatusChange }: Map3DProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<MapStatus>({ kind: 'loading' });
  /** 圖磚是否已全部載完（gmp-steadystate）。只用於顯示提示，不影響可見性。 */
  const [settled, setSettled] = useState(false);

  // 用 ref 保存 callback，避免父層每次 render 產生新函式時重建地圖。
  const onReadyRef = useRef(onReady);
  const onStatusChangeRef = useRef(onStatusChange);
  onReadyRef.current = onReady;
  onStatusChangeRef.current = onStatusChange;

  useEffect(() => {
    onStatusChangeRef.current?.(status);
  }, [status]);

  useEffect(() => {
    let cancelled = false;
    let mapElement: Map3DElementLike | null = null;

    let watchdog: number | undefined;

    const unsubscribe = onAuthFailure((detail) => {
      if (cancelled) return;
      setStatus({
        kind: 'error',
        message: 'Google Maps 拒絕了這個 API 金鑰。',
        hint: detail.hint,
        code: detail.code,
        raw: detail.raw,
      });
    });

    void (async () => {
      try {
        const lib = await loadMaps3d();
        if (cancelled) return;

        const { Map3DElement, MapMode } = lib;

        mapElement = new Map3DElement({
          center: OPENING_PRESET.center,
          range: OPENING_PRESET.range,
          tilt: OPENING_PRESET.tilt,
          heading: OPENING_PRESET.heading,
          // mode 必須設定，否則 3D 地圖不會開始渲染。
          mode: MapMode?.SATELLITE ?? 'SATELLITE',
        });

        mapElement.style.width = '100%';
        mapElement.style.height = '100%';
        mapElement.style.display = 'block';

        const container = containerRef.current;
        if (!container) return;
        container.replaceChildren(mapElement);

        const element = mapElement;

        // 元素掛上去就讓地圖可見。圖磚會邊串流邊出現，這才是使用者期待的行為。
        setStatus({ kind: 'ready' });
        onReadyRef.current?.(element, lib);

        // gmp-steadystate 只當「圖磚載完」的額外訊號，不影響可見性。
        element.addEventListener('gmp-steadystate', () => {
          if (cancelled) return;
          setSettled(true);
        });

        // 只偵測失敗。Google 認證失敗時會在元素內畫一段籠統的錯誤文字。
        watchdog = window.setTimeout(() => {
          if (cancelled) return;

          const googleShowedError = GOOGLE_ERROR_PHRASES.some((phrase) =>
            (element.textContent ?? '').includes(phrase),
          );

          if (googleShowedError) {
            emitAuthFailure();
          }
        }, WATCHDOG_DELAY_MS);
      } catch (error) {
        if (cancelled) return;
        if (error instanceof MissingApiKeyError) {
          setStatus({ kind: 'error', message: error.message });
        } else {
          setStatus({
            kind: 'error',
            message: `載入 maps3d 函式庫失敗：${error instanceof Error ? error.message : String(error)}`,
            hint: 'Map3DElement 仍是 Preview 功能。若錯誤指向找不到函式庫，試著把 VITE_GOOGLE_MAPS_VERSION 改成 beta 或 alpha。',
            raw: getLastRawMapsMessage(),
          });
        }
      }
    })();

    return () => {
      cancelled = true;
      unsubscribe();
      if (watchdog !== undefined) window.clearTimeout(watchdog);
      mapElement?.remove();
    };
  }, []);

  return (
    <div className="map-root">
      <div ref={containerRef} className="map-canvas" aria-label="台北 3D 地圖" role="application" />

      {/* 圖磚串流中的提示。刻意做成不遮擋的小角標，讓使用者看得到地圖逐漸長出來。 */}
      {status.kind === 'ready' && !settled && (
        <div className="map-tiles-badge" role="status" aria-live="polite">
          圖磚載入中…
        </div>
      )}

      {status.kind !== 'ready' && (
        <div className="map-overlay" role="status" aria-live="polite">
          {status.kind === 'loading' ? (
            <p>載入 3D 地圖中…</p>
          ) : (
            <div className="map-error">
              <h2>3D 地圖無法載入</h2>
              <p>{status.message}</p>
              {status.code && (
                <p className="map-error-code">
                  錯誤碼 <code>{status.code}</code>
                </p>
              )}
              {status.hint && <p className="map-error-hint">{status.hint}</p>}
              {status.raw && (
                <pre className="map-error-raw">
                  <code>{status.raw}</code>
                </pre>
              )}
              <p className="map-error-hint">
                對照最小重現頁 <code>/simple-3d.html?key=...</code> 可以區分是設定問題還是本專案的程式問題。
                設定步驟見 <code>docs/setup-gcp.md</code>。
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

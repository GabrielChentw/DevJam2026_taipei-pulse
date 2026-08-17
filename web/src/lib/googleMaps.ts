/**
 * Photorealistic 3D Maps (maps3d) 目前仍是 Preview 狀態，型別定義尚未穩定進入
 * @types/google.maps，因此這裡用寬鬆型別。等它 GA 之後可以換成官方型別。
 */
export interface Maps3dLibrary {
  Map3DElement: new (options: Record<string, unknown>) => Map3DElementLike;
  Marker3DElement: new (options: Record<string, unknown>) => Marker3DElementLike;
  Marker3DInteractiveElement: new (options: Record<string, unknown>) => Marker3DElementLike;
  MarkerElement: new (options: Record<string, unknown>) => Marker3DElementLike;
  PinElement: new (options: Record<string, unknown>) => HTMLElement;
  Polyline3DElement: new (options: Record<string, unknown>) => HTMLElement;
  Model3DElement: new (options: Record<string, unknown>) => Model3DElementLike;
  Model3DInteractiveElement: new (options: Record<string, unknown>) => Model3DElementLike;
  MapMode: Record<string, string>;
  AltitudeMode: Record<string, string>;
}

export interface LatLngAltitude {
  lat: number;
  lng: number;
  altitude?: number;
}

/**
 * Marker3DElement 我們實際會用到的部分。position 是可寫屬性 ——
 * 車輛模擬動畫每一格 (frame) 都靠直接重新指派這個屬性來移動標記，
 * 不是透過動畫方法（那些是給相機用的，不是給標記用的）。
 */
export interface Marker3DElementLike extends HTMLElement {
  position: LatLngAltitude;
  label?: string;
}

/** Interactive GLB model used for colored rectangular vehicle blocks. */
export interface Model3DElementLike extends HTMLElement {
  position: LatLngAltitude;
  orientation?: { heading?: number; tilt?: number; roll?: number };
  scale?: number | { x: number; y: number; z: number };
  src?: string | URL;
}

/** Map3DElement 我們實際會用到的部分。 */
export interface Map3DElementLike extends HTMLElement {
  center: LatLngAltitude;
  cameraPosition: LatLngAltitude;
  range: number;
  tilt: number;
  heading: number;
  fov: number;
  mode: string;
  flyCameraTo(options: {
    endCamera: {
      center?: LatLngAltitude;
      cameraPosition?: LatLngAltitude;
      range?: number;
      tilt?: number;
      heading?: number;
    };
    durationMillis?: number;
  }): void;
  flyCameraAround(options: {
    camera: {
      center: LatLngAltitude;
      range?: number;
      tilt?: number;
      heading?: number;
    };
    durationMillis?: number;
    rounds?: number;
  }): void;
  stopCameraAnimation(): void;
}

/**
 * Google Maps JS API 的錯誤碼 → 可以直接動手處理的說明。
 * 錯誤碼清單：https://developers.google.com/maps/documentation/javascript/error-messages
 */
const AUTH_ERROR_HINTS: Record<string, string> = {
  BillingNotEnabledMapError:
    '這個 GCP 專案沒有連結計費帳戶。到 Console → Billing → Link a billing account，選有 credit 的那個帳戶。3D Tiles 沒有計費帳戶會完全不載入。',
  ApiNotActivatedMapError:
    'Maps JavaScript API 沒有在這個專案啟用。到 Console → APIs & Services → Library，搜尋 Maps JavaScript API 並按 Enable。注意右上角的專案選擇器要是正確的專案。',
  RefererNotAllowedMapError:
    '金鑰的 HTTP referer 限制不允許目前的網址。到 Console → Credentials → 編輯金鑰 → Application restrictions，加入 http://localhost:5173/* 與 http://127.0.0.1:5173/*。改完最多要等 5 分鐘生效。',
  InvalidKeyMapError:
    '金鑰無效。檢查 web/.env.local 裡的值有沒有多餘空白、引號或換行，以及是不是複製完整。',
  ExpiredKeyMapError: '金鑰已過期，需要重新建立一把。',
  RequestDeniedMapError: '這個金鑰被拒絕存取 Maps JavaScript API，通常是金鑰的 API restrictions 沒有勾選 Maps JavaScript API。',
  ApiTargetBlockedMapError:
    '金鑰的 API restrictions 沒有包含 Maps JavaScript API。到 Console → Credentials → 編輯金鑰 → API restrictions 勾選它。',
  ApiProjectMapError: '金鑰不屬於任何有效的專案，或專案已被刪除。',
  OverQuotaMapError: '已超出配額。檢查 Billing 的 credit 是否用完，或 Quotas 頁面的限制。',
};

export interface AuthFailureDetail {
  /** Google 回報的錯誤碼，例如 ApiNotActivatedMapError。無法解析時為 null。 */
  code: string | null;
  hint: string;
  /** Google 寫進 console 的原始訊息。解析不出錯誤碼時，這是最有用的線索。 */
  raw: string | null;
}

/**
 * Google 寫進 console 的原始訊息。不解析、原封不動保留 ——
 * 先前試著用正則抓特定格式的錯誤碼，結果 3D Maps 的訊息格式不符而完全漏接。
 * 與其猜格式，不如把原話搬到畫面上。
 */
let lastRawMessage: string | null = null;

export function getLastRawMapsMessage(): string | null {
  return lastRawMessage;
}

/**
 * Google Maps JS API 在金鑰 / 計費 / referer 設定有問題時，不會 reject promise，
 * 而是呼叫全域的 window.gm_authFailure，並且把具體錯誤碼「只」寫進 console。
 * 這是 3D 地圖最常見也最難查的失敗模式。
 *
 * 因此這裡做兩件事：
 *   1. 接上 window.gm_authFailure，知道「失敗了」
 *   2. 攔截 console.error 抓出錯誤碼，知道「為什麼失敗」
 *
 * 攔截 console 不優雅，但它把一次「去看 console 再回報」的往返變成畫面上的直接指示，
 * 對時間有限的開發很值得。
 */
const authFailureListeners = new Set<(detail: AuthFailureDetail) => void>();

let lastErrorCode: string | null = null;

export function onAuthFailure(listener: (detail: AuthFailureDetail) => void): () => void {
  authFailureListeners.add(listener);
  return () => authFailureListeners.delete(listener);
}

export function emitAuthFailure() {
  const code = lastErrorCode;
  const detail: AuthFailureDetail = {
    code,
    raw: lastRawMessage,
    hint:
      (code && AUTH_ERROR_HINTS[code]) ??
      '下面是 Google 寫進 console 的原始訊息。常見原因依機率排序：金鑰的 referer 限制不含 localhost:5173、計費帳戶沒連結、Maps JavaScript API 沒啟用。',
  };
  for (const listener of authFailureListeners) listener(detail);
}

if (typeof window !== 'undefined') {
  window.gm_authFailure = () => emitAuthFailure();

  // 攔截 console.error 與 console.warn。條件放得很寬（只要訊息跟 Google Maps 有關就留），
  // 因為目標是「不要漏接」，而不是「精準分類」。
  const patch = (method: 'error' | 'warn') => {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      const text = args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ');

      if (/google\s*maps|maps\.googleapis|googleapis\.com/i.test(text)) {
        lastRawMessage = text;

        const match = /\b([A-Za-z]*MapError|ApiNotActivatedMapError|RefererNotAllowedMapError)\b/.exec(text);
        if (match) lastErrorCode = match[1];

        emitAuthFailure();
      }

      original(...args);
    };
  };

  patch('error');
  patch('warn');
}

declare global {
  interface Window {
    gm_authFailure?: () => void;
  }
}

export class MissingApiKeyError extends Error {
  constructor() {
    super(
      'VITE_GOOGLE_MAPS_API_KEY 未設定。請將 web/.env.example 複製為 web/.env.local 並填入金鑰，然後重新啟動 dev server。',
    );
    this.name = 'MissingApiKeyError';
  }
}

interface GoogleMapsGlobal {
  maps: {
    importLibrary?: (name: string) => Promise<unknown>;
    __ib__?: () => void;
  };
}

declare global {
  interface Window {
    google?: GoogleMapsGlobal;
  }
}

let scriptPromise: Promise<void> | null = null;

/**
 * 用 Google 官方文件的 bootstrap 方式載入 Maps JavaScript API。
 *
 * 先前這裡用的是 @googlemaps/js-api-loader，但 Google 官方 3D Maps 範例走的是這條
 * inline bootstrap 路徑，而官方範例在同一台機器同一個瀏覽器可以正常出圖、我們的
 * 版本不行。與其繼續猜那個套件哪裡不一樣，直接改成跟官方一致，順便少一個依賴。
 *
 * 關鍵是 loading=async 與 callback，兩者讓 google.maps.importLibrary 這個動態載入
 * 機制就緒；3D Maps 只能透過它取得。
 */
function loadMapsScript(apiKey: string, version: string): Promise<void> {
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<void>((resolve, reject) => {
    window.google = window.google ?? { maps: {} };
    window.google.maps = window.google.maps ?? {};
    window.google.maps.__ib__ = () => resolve();

    const params = new URLSearchParams({
      key: apiKey,
      v: version,
      loading: 'async',
      callback: 'google.maps.__ib__',
    });

    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
    script.async = true;
    script.onerror = () => {
      scriptPromise = null;
      reject(new Error('Maps JavaScript API 的 script 載入失敗（網路問題或版本通道不存在）'));
    };

    document.head.append(script);
  });

  return scriptPromise;
}

let libraryPromise: Promise<Maps3dLibrary> | null = null;

/**
 * 載入 Maps JavaScript API 並取得 maps3d 函式庫。多次呼叫共用同一個 promise，
 * 避免 React StrictMode 的重複掛載造成重複載入 —— Maps API 一個 document 只能載一次。
 */
export function loadMaps3d(): Promise<Maps3dLibrary> {
  if (libraryPromise) return libraryPromise;

  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    libraryPromise = Promise.reject(new MissingApiKeyError());
    return libraryPromise;
  }

  const version = import.meta.env.VITE_GOOGLE_MAPS_VERSION || 'weekly';

  libraryPromise = loadMapsScript(apiKey, version)
    .then(() => {
      const importLibrary = window.google?.maps?.importLibrary;
      if (!importLibrary) {
        throw new Error('google.maps.importLibrary 不存在，動態載入機制沒有就緒');
      }
      return Promise.all([
        importLibrary('maps3d'),
        importLibrary('marker'),
      ]);
    })
    .then(([maps3d, marker]) => ({
      ...(maps3d as Record<string, unknown>),
      PinElement: (marker as { PinElement: Maps3dLibrary['PinElement'] }).PinElement,
    }) as unknown as Maps3dLibrary)
    .catch((error: unknown) => {
      // 讓下一次呼叫可以重試，而不是永久卡在失敗的 promise 上。
      libraryPromise = null;
      throw error;
    });

  return libraryPromise;
}

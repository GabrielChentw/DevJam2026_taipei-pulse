/**
 * 純幾何運算：沿路徑內插座標與方向。不依賴 Google Maps，方便單獨測試。
 *
 * 用途：公車模擬動畫需要「給定進度 t（0~1），車輛現在應該在路徑上的哪個點、
 * 面朝哪個方向」。這裡用累積直線距離（haversine）當進度基準，不是用「點數」——
 * 後端 leg.path 的點間距並不均勻（起訖點多、轉彎少），用點數當進度會讓車子在
 * 點稀疏的路段看起來突然加速。
 */

export interface LatLngAlt {
  lat: number;
  lng: number;
  altitude?: number | null;
}

export interface PathSample {
  point: LatLngAlt;
  /** 這一段的行進方向，羅盤角度（0 = 正北，順時針）。 */
  heading: number;
}

const EARTH_RADIUS_M = 6371000;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function toDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

/** 兩點間的地表距離（公尺），haversine 公式。 */
export function haversineMeters(a: LatLngAlt, b: LatLngAlt): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** a 到 b 的羅盤方位角（度）。 */
export function bearingDegrees(a: LatLngAlt, b: LatLngAlt): number {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  const theta = Math.atan2(y, x);
  return (toDeg(theta) + 360) % 360;
}

/**
 * path 上進度 t（0~1，依累積距離計算）的內插座標與該處的行進方向。
 * path 至少要有 2 個點；呼叫端應先檢查長度。
 */
export function pointAlongPath(path: LatLngAlt[], t: number): PathSample {
  if (path.length < 2) {
    return { point: path[0], heading: 0 };
  }

  const clamped = Math.max(0, Math.min(1, t));

  const segmentLengths: number[] = [];
  let total = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const len = haversineMeters(path[i], path[i + 1]);
    segmentLengths.push(len);
    total += len;
  }

  if (total === 0) {
    // 所有點重疊在同一位置（資料異常），退化成起點，方向設 0 而不是丟例外。
    return { point: path[0], heading: 0 };
  }

  let remaining = clamped * total;
  for (let i = 0; i < segmentLengths.length; i++) {
    const len = segmentLengths[i];
    const isLastSegment = i === segmentLengths.length - 1;
    if (remaining <= len || isLastSegment) {
      const segT = len === 0 ? 0 : Math.min(1, remaining / len);
      const a = path[i];
      const b = path[i + 1];
      const point: LatLngAlt = {
        lat: a.lat + (b.lat - a.lat) * segT,
        lng: a.lng + (b.lng - a.lng) * segT,
        altitude: (a.altitude ?? 0) + ((b.altitude ?? 0) - (a.altitude ?? 0)) * segT,
      };
      return { point, heading: bearingDegrees(a, b) };
    }
    remaining -= len;
  }

  // 理論上不會到這裡（迴圈一定會在 isLastSegment 時回傳），保留作為型別安全的退路。
  const last = path[path.length - 1];
  const secondLast = path[path.length - 2];
  return { point: last, heading: bearingDegrees(secondLast, last) };
}

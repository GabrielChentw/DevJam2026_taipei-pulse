/**
 * 路線模擬：在 3D 地圖上畫出整條路線，並可播放一次「以使用者視角出發」的
 * 模擬——鏡頭先站到起點，然後依序沿每一段路徑前進；公車段會有一個會移動的
 * 標記代表即將搭乘/正在搭乘的車輛，鏡頭跟拍。
 *
 * 目前只有公車段做「車輛跟拍」動畫（使用者需求：先完成公車）。
 * 步行與捷運段做較快速的鏡頭掃過，之後要幫這兩種也做移動標記時，
 * 把 walkLegs / metro 的處理接上跟公車一樣的 chaseLeg() 即可，不需要重寫。
 *
 * 已知限制（老實列出，不要假裝比實際完整）：
 *   - 這裡假設每個 leg.path 至少有兩個點。公車段優先使用 TDX 官方 Shape；
 *     geometry_precision 為 'approximate' 時才是端點示意線。
 *   - 動畫時長是為了「demo 好看」而定的固定秒數，不是等比例對應
 *     leg.duration_min 的真實時間（26 分鐘的公車不可能真的播 26 分鐘）。
 *   - 這段程式碼沒有在瀏覽器裡實際跑過確認畫面效果 —— 型別與 API 用法
 *     依據官方文件（Polyline3DElement / Marker3DElement / Map3DElement），
 *     但相機跟拍的手感（range/tilt 是否好看）需要實機微調。
 */
import type { Map3DElementLike, Marker3DElementLike, Maps3dLibrary } from './googleMaps';
import { pointAlongPath, type LatLngAlt } from './geo';
import type { PlannedRoute, RouteStep } from '../types';

/** demo 配速：不對應真實交通時間，只是讓動畫在可看的秒數內播完。 */
const BUS_LEG_DURATION_MS = 9000;
const OTHER_LEG_DURATION_MS = 3200;
const INTRO_SHOT_DURATION_MS = 2200;

const STEP_COLOR: Record<RouteStep['type'], string> = {
  walk: '#3A6B4F',
  mrt: '#1B5FAA',
  bus: '#8B5E3C',
};

export interface SimulationCallbacks {
  /** 每一段開始播放時呼叫，供 UI 顯示「目前正在：...」。 */
  onLegStart?: (step: RouteStep, index: number, total: number) => void;
  onFinish?: () => void;
}

export interface RouteSimulationHandle {
  /** 從頭播放一次完整模擬。若已在播放中，會先停止再重新開始。 */
  play(callbacks?: SimulationCallbacks): void;
  stop(): void;
  /** 移除這條路線畫的所有 polyline 與模擬用的標記，地圖恢復乾淨狀態。 */
  destroy(): void;
}

function usableSteps(route: PlannedRoute): RouteStep[] {
  return route.steps.filter((s) => s.path && s.path.length >= 2);
}

/**
 * 在地圖上畫出整條路線的靜態 polyline（不論之後是否播放模擬動畫都會顯示），
 * 並回傳可以觸發「跟拍模擬」動畫的控制器。
 */
export function createRouteSimulation(
  map: Map3DElementLike,
  lib: Maps3dLibrary,
  route: PlannedRoute,
): RouteSimulationHandle {
  const { Polyline3DElement, Marker3DElement, AltitudeMode } = lib;
  const clampToGround = AltitudeMode?.CLAMP_TO_GROUND ?? 'CLAMP_TO_GROUND';

  const drawnElements: HTMLElement[] = [];
  let vehicleMarker: Marker3DElementLike | null = null;
  let rafHandle: number | null = null;
  let cancelled = false;

  // ── 畫出每一段的靜態路徑 ──────────────────────────────────────────────
  for (const step of usableSteps(route)) {
    const polyline = new Polyline3DElement({
      path: step.path!.map((p) => ({ lat: p.lat, lng: p.lng })),
      strokeColor: STEP_COLOR[step.type],
      outerColor: '#FFFFFF',
      strokeWidth: step.type === 'bus' ? 6 : 4,
      outerWidth: 0.25,
      altitudeMode: clampToGround,
      drawsOccludedSegments: true,
    }) as unknown as HTMLElement;
    map.append(polyline);
    drawnElements.push(polyline);
  }

  function stop() {
    cancelled = true;
    if (rafHandle !== null) {
      cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
  }

  function destroy() {
    stop();
    for (const el of drawnElements) el.remove();
    drawnElements.length = 0;
    vehicleMarker?.remove();
    vehicleMarker = null;
  }

  /** 鏡頭直接定格到某個座標，貼近地面視角（不是俯視），面向 heading 方向。 */
  function setGroundCamera(point: LatLngAlt, heading: number, range = 220, tilt = 75) {
    map.center = { lat: point.lat, lng: point.lng, altitude: point.altitude ?? 0 };
    map.range = range;
    map.tilt = tilt;
    map.heading = heading;
  }

  /** 公車段：建立/移動車輛標記，鏡頭跟拍整段路徑。 */
  function playBusLeg(step: RouteStep, durationMs: number, onDone: () => void) {
    const path = step.path!;

    if (!vehicleMarker) {
      vehicleMarker = new Marker3DElement({
        position: { lat: path[0].lat, lng: path[0].lng, altitude: 2 },
        label: step.line ?? '公車',
        altitudeMode: AltitudeMode?.RELATIVE_TO_GROUND ?? 'RELATIVE_TO_GROUND',
        extruded: true,
      }) as unknown as Marker3DElementLike;
      map.append(vehicleMarker as unknown as HTMLElement);
      drawnElements.push(vehicleMarker as unknown as HTMLElement);
    } else {
      vehicleMarker.position = { lat: path[0].lat, lng: path[0].lng, altitude: 2 };
    }

    const startTime = performance.now();

    function frame(now: number) {
      if (cancelled) return;
      const t = Math.min(1, (now - startTime) / durationMs);
      const { point, heading } = pointAlongPath(path, t);

      if (vehicleMarker) {
        vehicleMarker.position = { lat: point.lat, lng: point.lng, altitude: 2 };
      }
      // 跟拍：鏡頭中心對準車輛目前位置，面向車輛行進方向（從後方跟拍的視角）。
      setGroundCamera(point, heading, 200, 72);

      if (t < 1) {
        rafHandle = requestAnimationFrame(frame);
      } else {
        onDone();
      }
    }

    rafHandle = requestAnimationFrame(frame);
  }

  /** 步行 / 捷運段：暫時只做起訖點之間的鏡頭掃過，不放移動標記。 */
  function playFlyoverLeg(step: RouteStep, durationMs: number, onDone: () => void) {
    const path = step.path!;
    const startTime = performance.now();

    function frame(now: number) {
      if (cancelled) return;
      const t = Math.min(1, (now - startTime) / durationMs);
      const { point, heading } = pointAlongPath(path, t);
      setGroundCamera(point, heading, 320, 68);

      if (t < 1) {
        rafHandle = requestAnimationFrame(frame);
      } else {
        onDone();
      }
    }

    rafHandle = requestAnimationFrame(frame);
  }

  function play(callbacks?: SimulationCallbacks) {
    stop();
    cancelled = false;

    const steps = usableSteps(route);
    if (steps.length === 0) {
      callbacks?.onFinish?.();
      return;
    }

    const firstPoint = steps[0].path![0];
    const secondPoint = steps[0].path![1] ?? firstPoint;
    const introHeading = firstPoint === secondPoint ? 0 : bearingBetween(firstPoint, secondPoint);

    // 開場：鏡頭站到使用者出發點，面向即將前進的方向（貼近地面的第一人稱視角）。
    setGroundCamera(firstPoint, introHeading, 180, 80);

    window.setTimeout(() => {
      if (cancelled) return;
      runLeg(0);
    }, INTRO_SHOT_DURATION_MS);

    function runLeg(index: number) {
      if (cancelled) return;
      if (index >= steps.length) {
        callbacks?.onFinish?.();
        return;
      }

      const step = steps[index];
      callbacks?.onLegStart?.(step, index, steps.length);

      if (step.type === 'bus') {
        playBusLeg(step, BUS_LEG_DURATION_MS, () => runLeg(index + 1));
      } else {
        playFlyoverLeg(step, OTHER_LEG_DURATION_MS, () => runLeg(index + 1));
      }
    }
  }

  return { play, stop, destroy };
}

function bearingBetween(a: LatLngAlt, b: LatLngAlt): number {
  return pointAlongPath([a, b], 1).heading;
}

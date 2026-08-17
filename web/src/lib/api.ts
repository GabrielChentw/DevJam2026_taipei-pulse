/**
 * 後端 API 的薄封裝。所有呼叫都走 /api 前綴，dev 模式下由 vite.config.ts 的
 * proxy 轉去 http://127.0.0.1:8000，所以前端不需要知道後端網址、也不會碰到 CORS。
 *
 * 使用方式見 docs/api-contract.md。
 */

import type {
  ChatRequest,
  ChatResponse,
  CompareResponse,
  PlanRequest,
  PlanResponse,
  ProfileSummary,
  TransitArrivalSnapshot,
  TrafficSceneSnapshot,
  UserPreferences,
  UserPreferencesSnapshot,
} from '../types/api';

export interface TrafficSceneTarget {
  mode: 'metro' | 'bus';
  routeName: string;
  routeUid: string;
  direction: number;
  boardingStopUid?: string | null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`API ${path} 回傳 ${response.status}：${body}`);
  }

  return response.json() as Promise<T>;
}

export function fetchProfiles(): Promise<ProfileSummary[]> {
  return request('/profiles');
}

export function fetchUserPreferences(userId: string): Promise<UserPreferencesSnapshot> {
  return request(`/users/${encodeURIComponent(userId)}/preferences`);
}

export function saveUserPreferences(
  userId: string,
  preferences: UserPreferences,
): Promise<UserPreferencesSnapshot> {
  return request(`/users/${encodeURIComponent(userId)}/preferences`, {
    method: 'PUT',
    body: JSON.stringify(preferences),
  });
}

export function fetchCorridor(): Promise<unknown> {
  return request('/corridor');
}

export function fetchTransitArrivals(
  routeName: string,
  routeUid: string,
  direction: number,
  boardingStopUid: string,
  refresh = false,
): Promise<TransitArrivalSnapshot> {
  const params = new URLSearchParams({
    route_name: routeName,
    route_uid: routeUid,
    direction: String(direction),
    boarding_stop_uid: boardingStopUid,
  });
  if (refresh) params.set('refresh', 'true');
  return request(`/transit/arrivals?${params.toString()}`);
}

export function fetchTrafficScene(
  target?: TrafficSceneTarget | null,
  refresh = false,
): Promise<TrafficSceneSnapshot> {
  const params = new URLSearchParams();
  if (target) {
    params.set('target_mode', target.mode);
    params.set('target_route_name', target.routeName);
    params.set('target_route_uid', target.routeUid);
    params.set('target_direction', String(target.direction));
    if (target.boardingStopUid) params.set('target_boarding_stop_uid', target.boardingStopUid);
  }
  if (refresh) params.set('refresh', 'true');
  return request(`/transit/scene${params.size ? `?${params.toString()}` : ''}`);
}

export function planRoute(body: PlanRequest): Promise<PlanResponse> {
  return request('/plan', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function compareProfiles(
  origin: string,
  destination: string,
  profileIds: string[],
): Promise<CompareResponse> {
  const params = new URLSearchParams({
    origin,
    destination,
    profiles: profileIds.join(','),
  });
  return request(`/compare?${params.toString()}`);
}

/**
 * 對話式路線規劃。sessionId 由呼叫端產生並在整次對話中重複使用
 * （例如 crypto.randomUUID()，存在 useState 或 useRef 裡，不要每次訊息都重新產生）。
 */
export function sendChatMessage(sessionId: string, message: string): Promise<ChatResponse> {
  const body: ChatRequest = { session_id: sessionId, message };
  return request('/chat', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

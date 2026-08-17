/**
 * 後端 API 的薄封裝。所有呼叫都走 /api 前綴，dev 模式下由 vite.config.ts 的
 * proxy 轉去 http://127.0.0.1:8000，所以前端不需要知道後端網址、也不會碰到 CORS。
 *
 * 使用方式見 docs/api-contract.md。
 */

import type {
  CompareResponse,
  PlanRequest,
  PlanResponse,
  ProfileSummary,
} from '../types/api';

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

export function fetchCorridor(): Promise<unknown> {
  return request('/corridor');
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

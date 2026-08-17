/**
 * 後端 API 的型別定義，手動對照 api/app/models.py 維護。
 *
 * 一日專案沒有時間搭 openapi-typescript 這類自動產生工具，所以這份是手寫的。
 * 若後端改了 models.py，這裡要跟著改 —— 有疑問時以 http://127.0.0.1:8000/docs
 * 的 schema 為準。
 *
 * 讀這份之前務必先看 docs/api-contract.md，裡面解釋了幾個型別長這樣的原因
 * （尤其是 Feature.value 為什麼可能是 null，以及 path 為什麼可能是空陣列）。
 */

export type Confidence = 'verified' | 'regulatory' | 'estimated' | 'unknown';

export type GeometryPrecision = 'approximate' | 'missing';

export interface LatLngPoint {
  lat: number;
  lng: number;
  altitude?: number | null;
}

/**
 * 一項客觀特徵。value 為 null 代表「沒有這筆資料」，不是「否」。
 * 畫面上請把這兩種情況區分開來顯示，不要把 null 當成 false 處理。
 */
export interface Feature {
  value: unknown;
  confidence: Confidence;
  source?: string | null;
  detail?: string | null;
}

export interface AnnotatedLeg {
  index: number;
  mode: 'walk' | 'metro' | 'bus';
  name: string;
  duration_min: number;
  features: Record<string, Feature>;
  /**
   * 可直接餵給 Polyline3DElement 的座標陣列。
   * 空陣列（length === 0）代表沒有幾何資料，這段不該畫線，但仍可用
   * name / duration_min 顯示文字說明。長度不會是 1（至少兩點才構成線段）。
   */
  path: LatLngPoint[];
  /**
   * 'approximate'：端點有依據，但點與點之間是直線，不是真實道路 / 軌道 shape。
   *   畫成虛線或加註「示意路線」有助於誠實呈現。
   * 'missing'：path 為空陣列時必為此值。
   */
  geometry_precision: GeometryPrecision;
}

export interface Violation {
  rule_feature: string;
  leg_index: number | null;
  leg_name: string | null;
  reason: string;
  actual: unknown;
  required: unknown;
  /** true 代表排除原因是資料缺漏（安全考量下不猜測），而非確定不可行。 */
  caused_by_missing_data: boolean;
}

export interface Warning {
  feature: string;
  leg_index: number | null;
  leg_name: string | null;
  message: string;
}

export interface ScoreBreakdown {
  feature: string;
  raw_value: number;
  weight: number;
  contribution: number;
}

export interface EvaluatedRoute {
  candidate_id: string;
  label: string;
  feasible: boolean;
  /** feasible === false 時為 null。 */
  score: number | null;
  duration_min: number;
  total_walk_meters: number;
  transfers: number;
  legs: AnnotatedLeg[];
  violations: Violation[];
  warnings: Warning[];
  breakdown: ScoreBreakdown[];
  /**
   * '最推薦' | '最快可行' | '最少步行' | '最少轉乘' | null。
   * 只在 feasible === true 的路線上出現。同一條路線可能只掛一個標籤
   * （目前分數最低的那條優先拿'最推薦'，其他標籤才會給別的路線）。
   */
  recommendation_tag: string | null;
  /** 給人看的完整解釋，可直接顯示，不需要自己拼字串。 */
  explanation: string | null;
}

export interface PlanRequest {
  origin: string;
  destination: string;
  profile_id: string;
  /** 覆寫 profile 的硬條件門檻，例如 { total_walk_meters: 300 }。供對話式調整用。 */
  overrides?: Record<string, number>;
}

export interface PlanResponse {
  origin: string;
  destination: string;
  profile_id: string;
  profile_label: string;
  applied_overrides: Record<string, number>;
  /** 可行路線，已按分數排序（分數越低越前面）。 */
  feasible: EvaluatedRoute[];
  /** 被排除的路線。刻意保留並附上原因，不要在 UI 上完全隱藏這些。 */
  excluded: EvaluatedRoute[];
  summary: string;
}

export interface ProfileSummary {
  id: string;
  label: string;
  summary: string;
  user_overridable: Record<string, unknown>;
}

export interface CompareResponse {
  origin: string;
  destination: string;
  /** key 是 profile_id，例如 { wheelchair: {...}, low_vision: {...} }。 */
  results: Record<string, PlanResponse>;
  /** 兩個 profile 的建議是否不同、為什麼不同的人類可讀說明。 */
  divergence: string;
}

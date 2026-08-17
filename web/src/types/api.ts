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

export type GeometryPrecision = 'transit_shape' | 'road_snapped' | 'approximate' | 'missing';

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
   * 'transit_shape'：公車段來自 TDX 官方營運路線 Shape，並裁切至上下車站。
   * 'road_snapped'：來自 Routes API WALK／DRIVE 路網幾何；仍不保證完整的人行道或公車營運線形。
   * 'approximate'：端點有依據，但點與點之間是直線，不是真實道路 / 軌道 shape。
   *   畫成虛線或加註「示意路線」有助於誠實呈現。
   * 'missing'：path 為空陣列時必為此值。
   */
  geometry_precision: GeometryPrecision;
  transit_route_name?: string | null;
  transit_route_uid?: string | null;
  transit_direction?: number | null;
  boarding_stop_uid?: string | null;
  alighting_stop_uid?: string | null;
}

export interface TransitVehicleArrival {
  vehicle_id: string;
  plate_number: string;
  eta_seconds: number;
  position: LatLngPoint;
  current_stop_uid?: string | null;
  current_stop_name?: string | null;
  is_low_floor?: boolean | null;
  has_ramp?: boolean | null;
  suitable_for_wheelchair: boolean;
  timing_source: string;
  position_source: string;
  accessibility_source: string;
  gps_time?: string | null;
}

export interface TransitArrivalSnapshot {
  route_name: string;
  route_uid: string;
  direction: number;
  boarding_stop_uid: string;
  boarding_stop_name: string;
  generated_at: string;
  data_mode: string;
  notices: string[];
  arrivals: TransitVehicleArrival[];
}

export type TrafficClockMode = 'realtime' | 'schedule_playback';

/** 一個由即時位置或公開時刻表驅動的 3D 交通物件。 */
export interface TrafficVehicle {
  vehicle_id: string;
  mode: 'metro' | 'bus';
  route_name: string;
  route_uid: string;
  direction: number;
  label: string;
  position: LatLngPoint;
  path: LatLngPoint[];
  progress: number;
  segment_duration_seconds: number;
  bearing: number;
  next_stop_name?: string | null;
  destination_name?: string | null;
  eta_seconds?: number | null;
  scheduled_time?: string | null;
  source: string;
  is_target: boolean;
  plate_number?: string | null;
  suitable_for_wheelchair?: boolean | null;
  accessibility_source: string;
}

export interface TrafficSceneSnapshot {
  generated_at: string;
  clock_time: string;
  clock_mode: TrafficClockMode;
  timezone: string;
  notices: string[];
  vehicles: TrafficVehicle[];
}

export interface UserPreferences {
  accessibility_mode: 'general' | 'wheelchair' | 'visual' | 'elderly';
  profile_detail: string;
  speech_rate: number;
  theme: 'light' | 'dark';
}

export interface UserPreferencesSnapshot extends UserPreferences {
  user_id: string;
  updated_at?: string | null;
  storage_mode: 'firestore' | 'memory' | 'memory_fallback';
  notices: string[];
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

// ---------- Agent 對話 ----------

/**
 * Agent 要求地圖執行的相機動作。這是 agent 與地圖唯一的耦合點：
 * agent 不直接操作 Map3DElement，只回傳「意圖」，前端保留呈現方式的決定權
 * （動畫時長、緩動曲線都由前端決定）。
 */
export interface CameraCommand {
  action: 'fly_to' | 'show_route' | 'orbit';
  /** fly_to / orbit 必填。 */
  center?: LatLngPoint | null;
  range?: number | null;
  tilt?: number | null;
  heading?: number | null;
  /** show_route 必填，對應 EvaluatedRoute.candidate_id。 */
  route_candidate_id?: string | null;
}

export interface ChatMessage {
  role: 'user' | 'agent';
  text: string;
}

export interface ChatRequest {
  /** 前端產生一個穩定的 id（例如 crypto.randomUUID()），同一次對話全程帶同一個。 */
  session_id: string;
  message: string;
}

export interface ChatResponse {
  session_id: string;
  reply: string;
  camera_commands: CameraCommand[];
  /** agent 這輪若呼叫了規劃工具，完整結果會在這裡；否則為 null。 */
  plan: PlanResponse | null;
  compare: CompareResponse | null;
  /** 完整對話歷史，含這一輪剛送出的訊息與回覆。 */
  history: ChatMessage[];
}

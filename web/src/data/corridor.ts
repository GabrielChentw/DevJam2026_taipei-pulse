import type { LatLngAltitude } from '../lib/googleMaps';

/**
 * 示範走廊：捷運板南線 台北車站 ↔ 市政府。
 *
 * 座標為站體大致中心，用於相機定位與標記。無障礙設施的詳細標註在後端的
 * 種子資料裡（data/corridor.json），這裡只放前端定位需要的最小資訊。
 */
export interface CorridorStation {
  id: string;
  name: string;
  nameEn: string;
  position: LatLngAltitude;
}

export const BANNAN_CORRIDOR: CorridorStation[] = [
  { id: 'BL12', name: '台北車站', nameEn: 'Taipei Main Station', position: { lat: 25.0478, lng: 121.517, altitude: 20 } },
  { id: 'BL13', name: '善導寺', nameEn: 'Shandao Temple', position: { lat: 25.0446, lng: 121.5252, altitude: 20 } },
  { id: 'BL14', name: '忠孝新生', nameEn: 'Zhongxiao Xinsheng', position: { lat: 25.0424, lng: 121.533, altitude: 20 } },
  { id: 'BL15', name: '忠孝復興', nameEn: 'Zhongxiao Fuxing', position: { lat: 25.0416, lng: 121.5434, altitude: 20 } },
  { id: 'BL16', name: '忠孝敦化', nameEn: 'Zhongxiao Dunhua', position: { lat: 25.0416, lng: 121.5497, altitude: 20 } },
  { id: 'BL17', name: '國父紀念館', nameEn: 'SYS Memorial Hall', position: { lat: 25.0413, lng: 121.5576, altitude: 20 } },
  { id: 'BL18', name: '市政府', nameEn: 'Taipei City Hall', position: { lat: 25.041, lng: 121.5679, altitude: 20 } },
];

export interface CameraPreset {
  id: string;
  label: string;
  center: LatLngAltitude;
  range: number;
  tilt: number;
  heading: number;
}

/** Demo 用的相機定位點。開場鏡頭用 cityHall。 */
export const CAMERA_PRESETS: CameraPreset[] = [
  {
    id: 'corridor',
    label: '整條走廊',
    center: { lat: 25.0444, lng: 121.5425, altitude: 30 },
    range: 7000,
    tilt: 55,
    heading: 90,
  },
  {
    id: 'cityHall',
    label: '市政府站',
    center: { lat: 25.041, lng: 121.5679, altitude: 20 },
    range: 900,
    tilt: 67.5,
    heading: 30,
  },
  {
    id: 'mainStation',
    label: '台北車站',
    center: { lat: 25.0478, lng: 121.517, altitude: 20 },
    range: 900,
    tilt: 67.5,
    heading: 200,
  },
  {
    id: 'taipei101',
    label: '台北 101',
    center: { lat: 25.0339, lng: 121.5645, altitude: 60 },
    range: 1200,
    tilt: 70,
    heading: 320,
  },
];

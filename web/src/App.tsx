import { useCallback, useRef, useState } from 'react';
import { Map3D, type MapStatus } from './components/Map3D';
import { BANNAN_CORRIDOR, CAMERA_PRESETS, type CameraPreset } from './data/corridor';
import type { Map3DElementLike, Maps3dLibrary } from './lib/googleMaps';

export default function App() {
  const mapRef = useRef<Map3DElementLike | null>(null);
  const [status, setStatus] = useState<MapStatus>({ kind: 'loading' });
  const [activePreset, setActivePreset] = useState<string>('cityHall');

  const handleReady = useCallback((map: Map3DElementLike, lib: Maps3dLibrary) => {
    mapRef.current = map;

    // 沿走廊放上車站標記。這同時驗證 Marker3DElement 可用，
    // 是後面「電梯 / 障礙點」標記圖層的基礎。
    const { Marker3DElement, AltitudeMode } = lib;
    for (const station of BANNAN_CORRIDOR) {
      const marker = new Marker3DElement({
        position: station.position,
        label: station.name,
        altitudeMode: AltitudeMode?.RELATIVE_TO_GROUND ?? 'RELATIVE_TO_GROUND',
        extruded: true,
      });
      map.append(marker);
    }
  }, []);

  const flyTo = useCallback((preset: CameraPreset) => {
    const map = mapRef.current;
    if (!map) return;
    setActivePreset(preset.id);
    map.flyCameraTo({
      endCamera: {
        center: preset.center,
        range: preset.range,
        tilt: preset.tilt,
        heading: preset.heading,
      },
      durationMillis: 2500,
    });
  }, []);

  const orbit = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const preset = CAMERA_PRESETS.find((p) => p.id === activePreset) ?? CAMERA_PRESETS[1];
    map.flyCameraAround({
      camera: {
        center: preset.center,
        range: preset.range,
        tilt: preset.tilt,
        heading: preset.heading,
      },
      durationMillis: 12000,
      rounds: 1,
    });
  }, [activePreset]);

  const mapReady = status.kind === 'ready';

  return (
    <div className="app">
      <header className="app-header">
        <h1>Taipei Pulse</h1>
        <p className="app-tagline">無障礙大眾運輸 3D 導引 · 板南線示範走廊</p>
        <span className={`status-pill status-${status.kind}`}>
          {status.kind === 'loading' && '載入中'}
          {status.kind === 'ready' && '3D 地圖就緒'}
          {status.kind === 'error' && '載入失敗'}
        </span>
      </header>

      <main className="app-body">
        <Map3D onReady={handleReady} onStatusChange={setStatus} />
      </main>

      <nav className="camera-bar" aria-label="相機定位">
        {CAMERA_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            onClick={() => flyTo(preset)}
            disabled={!mapReady}
            aria-pressed={activePreset === preset.id}
            className={activePreset === preset.id ? 'is-active' : undefined}
          >
            {preset.label}
          </button>
        ))}
        <button type="button" onClick={orbit} disabled={!mapReady}>
          環繞一圈
        </button>
      </nav>
    </div>
  );
}

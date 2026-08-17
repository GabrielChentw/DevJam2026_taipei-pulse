/**
 * Small traffic-object layer inspired by mini-tokyo-3d's separation between
 * timetable data, a shared clock and rendered objects. Google Maps 3D markers
 * replace its large Three.js instancing system for this corridor-sized MVP.
 */
import type { TrafficSceneSnapshot, TrafficVehicle } from '../types/api';
import { pointAlongPath } from './geo';
import type { Map3DElementLike, Maps3dLibrary, Model3DElementLike } from './googleMaps';

interface RenderedVehicle {
  model: Model3DElementLike;
  vehicle: TrafficVehicle;
  receivedAt: number;
}

export interface TrafficLayerHandle {
  update(snapshot: TrafficSceneSnapshot): void;
  destroy(): void;
}

function modelSource(vehicle: TrafficVehicle): string {
  if (vehicle.is_target) return '/models/vehicle-target.glb';
  return vehicle.mode === 'metro'
    ? '/models/vehicle-metro.glb'
    : '/models/vehicle-bus.glb';
}

function modelScale(vehicle: TrafficVehicle): { x: number; y: number; z: number } {
  // Models use world-space metres, unlike screen-preserved pins. Deliberately
  // exaggerate their footprint so they remain legible in the corridor view.
  const scale = vehicle.mode === 'metro'
    ? { x: 8, y: 7, z: 40 }
    : { x: 7, y: 6.5, z: 28 };
  const emphasis = vehicle.is_target ? 1.5 : 1;
  return {
    x: scale.x * emphasis,
    y: scale.y * emphasis,
    z: scale.z * emphasis,
  };
}

function altitude(vehicle: TrafficVehicle): number {
  // MRT positions are schedule projections over an underground line. Lift
  // them above the photorealistic surface so the demo object remains visible.
  return vehicle.mode === 'metro' ? 30 : vehicle.is_target ? 7 : 5;
}

export function createTrafficLayer(
  map: Map3DElementLike,
  lib: Maps3dLibrary,
  onSelect: (vehicle: TrafficVehicle) => void,
): TrafficLayerHandle {
  const rendered = new Map<string, RenderedVehicle>();
  const { Model3DInteractiveElement, Model3DElement, AltitudeMode } = lib;
  const Model = Model3DInteractiveElement ?? Model3DElement;
  let frame: number | null = null;
  let destroyed = false;

  const animate = (now: number) => {
    if (destroyed) return;
    for (const item of rendered.values()) {
      const { vehicle } = item;
      const duration = Math.max(1, vehicle.segment_duration_seconds);
      const elapsed = Math.max(0, (now - item.receivedAt) / 1000);
      const progress = Math.min(1, vehicle.progress + elapsed / duration);
      const sample = vehicle.path.length >= 2
        ? pointAlongPath(vehicle.path, progress)
        : { point: vehicle.position, heading: vehicle.bearing };
      item.model.position = { lat: sample.point.lat, lng: sample.point.lng, altitude: altitude(vehicle) };
      item.model.orientation = { heading: sample.heading, tilt: 0, roll: 0 };
    }
    frame = window.requestAnimationFrame(animate);
  };

  frame = window.requestAnimationFrame(animate);

  return {
    update(snapshot) {
      // The selected bus already has a dedicated marker controlled by the
      // route-preview animation. Keep it out of this background layer so it
      // does not appear twice; its info remains in the scene panel.
      const vehicles = snapshot.vehicles.filter(vehicle => !(vehicle.mode === 'bus' && vehicle.is_target));
      const nextIds = new Set(vehicles.map(vehicle => vehicle.vehicle_id));
      for (const [id, item] of rendered) {
        if (!nextIds.has(id)) {
          item.model.remove();
          rendered.delete(id);
        }
      }

      for (const vehicle of vehicles) {
        const existing = rendered.get(vehicle.vehicle_id);
        if (existing) {
          existing.vehicle = vehicle;
          existing.receivedAt = performance.now();
          existing.model.src = modelSource(vehicle);
          existing.model.scale = modelScale(vehicle);
          continue;
        }

        const model = new Model({
          position: { ...vehicle.position, altitude: altitude(vehicle) },
          orientation: { heading: vehicle.bearing, tilt: 0, roll: 0 },
          scale: modelScale(vehicle),
          src: modelSource(vehicle),
          altitudeMode: AltitudeMode?.RELATIVE_TO_GROUND ?? 'RELATIVE_TO_GROUND',
        }) as Model3DElementLike;
        const select = () => onSelect(vehicle);
        model.addEventListener('gmp-click', select);
        model.addEventListener('click', select);
        map.append(model);
        rendered.set(vehicle.vehicle_id, { model, vehicle, receivedAt: performance.now() });
      }
    },
    destroy() {
      destroyed = true;
      if (frame !== null) window.cancelAnimationFrame(frame);
      for (const item of rendered.values()) item.model.remove();
      rendered.clear();
    },
  };
}

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
  label: Model3DElementLike;
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

export function vehicleModelScale(vehicle: TrafficVehicle): { x: number; y: number; z: number } {
  // The GLB uses Y as its vertical axis. Keep Y deliberately shallow so the
  // simplified vehicle reads as a body lying along the road/track, not a pin.
  // X is the width and Z is the body length in model space.
  const scale = vehicle.mode === 'metro'
    ? { x: 12, y: 3.8, z: 21 }
    : { x: 10.5, y: 3.5, z: 17 };
  const emphasis = vehicle.is_target ? 1.16 : 1;
  return {
    x: scale.x * emphasis,
    y: scale.y * (vehicle.is_target ? 1.1 : 1),
    z: scale.z * emphasis,
  };
}

export function vehicleAltitude(vehicle: TrafficVehicle): number {
  // MRT positions are schedule projections over an underground line. Lift
  // them above the photorealistic surface so the demo object remains visible.
  return vehicle.mode === 'metro' ? 30 : vehicle.is_target ? 2 : 1.5;
}

export function vehicleLabelAltitude(vehicle: TrafficVehicle): number {
  return vehicleAltitude(vehicle) + (vehicle.mode === 'metro' ? 9 : vehicle.is_target ? 9 : 8);
}

function vehicleAltitudeMode(
  vehicle: TrafficVehicle,
  altitudeMode: Record<string, string> | undefined,
): string {
  // Bus coordinates follow roads, so anchor them to the visible photorealistic
  // mesh instead of the terrain beneath it. This prevents the low cuboid from
  // being swallowed by road/building geometry. Metro remains a raised overlay.
  return vehicle.mode === 'bus'
    ? altitudeMode?.RELATIVE_TO_MESH ?? altitudeMode?.RELATIVE_TO_GROUND ?? 'RELATIVE_TO_GROUND'
    : altitudeMode?.RELATIVE_TO_GROUND ?? 'RELATIVE_TO_GROUND';
}

function conciseVehicleDetail(vehicle: TrafficVehicle): string {
  const destination = vehicle.destination_name ? `往 ${vehicle.destination_name}` : null;
  const nextStop = vehicle.next_stop_name ? `下一站 ${vehicle.next_stop_name}` : null;
  const eta = vehicle.eta_seconds == null
    ? null
    : vehicle.eta_seconds <= 45
      ? '即將抵達'
      : `${Math.max(1, Math.ceil(vehicle.eta_seconds / 60))} 分鐘`;
  if (vehicle.is_target) {
    return ['目標車', vehicle.suitable_for_wheelchair ? '無障礙' : null, eta].filter(Boolean).join(' · ');
  }
  return [destination ?? nextStop ?? (vehicle.mode === 'metro' ? '捷運' : '公車'), eta].filter(Boolean).join(' · ');
}

function labelContent(vehicle: TrafficVehicle): HTMLDivElement {
  const content = document.createElement('div');
  content.className = `traffic-map-label traffic-map-label-${vehicle.mode}${vehicle.is_target ? ' is-target' : ''}`;

  const route = document.createElement('strong');
  route.textContent = vehicle.route_name;
  const detail = document.createElement('span');
  detail.textContent = conciseVehicleDetail(vehicle);
  content.append(route, detail);
  return content;
}

export function createTrafficLabelMarker(
  lib: Maps3dLibrary,
  vehicle: TrafficVehicle,
): Model3DElementLike {
  const { MarkerElement, AltitudeMode } = lib;
  const marker = new MarkerElement({
    position: { ...vehicle.position, altitude: vehicleLabelAltitude(vehicle) },
    altitudeMode: vehicleAltitudeMode(vehicle, AltitudeMode),
    anchorLeft: '-50%',
    anchorTop: '-115%',
    title: `${vehicle.route_name} · ${conciseVehicleDetail(vehicle)}`,
  }) as Model3DElementLike;
  marker.append(labelContent(vehicle));
  return marker;
}

export function updateTrafficLabelMarker(
  marker: Model3DElementLike,
  vehicle: TrafficVehicle,
): void {
  marker.position = { ...vehicle.position, altitude: vehicleLabelAltitude(vehicle) };
  marker.title = `${vehicle.route_name} · ${conciseVehicleDetail(vehicle)}`;
  marker.replaceChildren(labelContent(vehicle));
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
      item.model.position = { lat: sample.point.lat, lng: sample.point.lng, altitude: vehicleAltitude(vehicle) };
      item.model.orientation = { heading: sample.heading, tilt: 0, roll: 0 };
      item.label.position = { lat: sample.point.lat, lng: sample.point.lng, altitude: vehicleLabelAltitude(vehicle) };
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
          item.label.remove();
          rendered.delete(id);
        }
      }

      for (const vehicle of vehicles) {
        const existing = rendered.get(vehicle.vehicle_id);
        if (existing) {
          existing.vehicle = vehicle;
          existing.receivedAt = performance.now();
          existing.model.src = modelSource(vehicle);
          existing.model.scale = vehicleModelScale(vehicle);
          updateTrafficLabelMarker(existing.label, vehicle);
          continue;
        }

        const model = new Model({
          position: { ...vehicle.position, altitude: vehicleAltitude(vehicle) },
          orientation: { heading: vehicle.bearing, tilt: 0, roll: 0 },
          scale: vehicleModelScale(vehicle),
          src: modelSource(vehicle),
          altitudeMode: vehicleAltitudeMode(vehicle, AltitudeMode),
        }) as Model3DElementLike;
        const label = createTrafficLabelMarker(lib, vehicle);
        const select = () => onSelect(rendered.get(vehicle.vehicle_id)?.vehicle ?? vehicle);
        model.addEventListener('gmp-click', select);
        model.addEventListener('click', select);
        label.addEventListener('gmp-click', select);
        label.addEventListener('click', select);
        map.append(model);
        map.append(label);
        rendered.set(vehicle.vehicle_id, { model, label, vehicle, receivedAt: performance.now() });
      }
    },
    destroy() {
      destroyed = true;
      if (frame !== null) window.cancelAnimationFrame(frame);
      for (const item of rendered.values()) {
        item.model.remove();
        item.label.remove();
      }
      rendered.clear();
    },
  };
}

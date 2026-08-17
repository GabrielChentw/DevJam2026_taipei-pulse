/** Generate tiny dependency-free GLB cuboids used by the 3D traffic layer. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'public', 'models');

const faces = [
  // normal, four corners. Unit cube is centered on X/Z and rests on Y=0.
  [[0, 0, 1],  [[-.5, 0, .5], [.5, 0, .5], [.5, 1, .5], [-.5, 1, .5]]],
  [[0, 0, -1], [[.5, 0, -.5], [-.5, 0, -.5], [-.5, 1, -.5], [.5, 1, -.5]]],
  [[1, 0, 0],  [[.5, 0, .5], [.5, 0, -.5], [.5, 1, -.5], [.5, 1, .5]]],
  [[-1, 0, 0], [[-.5, 0, -.5], [-.5, 0, .5], [-.5, 1, .5], [-.5, 1, -.5]]],
  [[0, 1, 0],  [[-.5, 1, .5], [.5, 1, .5], [.5, 1, -.5], [-.5, 1, -.5]]],
  [[0, -1, 0], [[-.5, 0, -.5], [.5, 0, -.5], [.5, 0, .5], [-.5, 0, .5]]],
];

function padded(buffer, byte = 0) {
  const padding = (4 - buffer.length % 4) % 4;
  return padding ? Buffer.concat([buffer, Buffer.alloc(padding, byte)]) : buffer;
}

function createGlb(baseColor, emissive = [0, 0, 0]) {
  const positions = [];
  const normals = [];
  const indices = [];
  for (const [normal, corners] of faces) {
    const offset = positions.length / 3;
    for (const corner of corners) {
      positions.push(...corner);
      normals.push(...normal);
    }
    indices.push(offset, offset + 1, offset + 2, offset, offset + 2, offset + 3);
  }

  const positionBuffer = Buffer.from(new Float32Array(positions).buffer);
  const normalBuffer = Buffer.from(new Float32Array(normals).buffer);
  const indexBuffer = Buffer.from(new Uint16Array(indices).buffer);
  const binary = padded(Buffer.concat([positionBuffer, normalBuffer, indexBuffer]));
  const normalOffset = positionBuffer.length;
  const indexOffset = normalOffset + normalBuffer.length;
  const json = {
    asset: { version: '2.0', generator: 'Taipei Pulse vehicle-block generator' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
    materials: [{
      name: 'vehicle-color',
      pbrMetallicRoughness: {
        baseColorFactor: [...baseColor, 1],
        metallicFactor: 0.05,
        roughnessFactor: 0.55,
      },
      emissiveFactor: emissive,
      doubleSided: false,
    }],
    buffers: [{ byteLength: binary.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positionBuffer.length, target: 34962 },
      { buffer: 0, byteOffset: normalOffset, byteLength: normalBuffer.length, target: 34962 },
      { buffer: 0, byteOffset: indexOffset, byteLength: indexBuffer.length, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 24, type: 'VEC3', min: [-.5, 0, -.5], max: [.5, 1, .5] },
      { bufferView: 1, componentType: 5126, count: 24, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: 36, type: 'SCALAR', min: [0], max: [23] },
    ],
  };

  const jsonChunk = padded(Buffer.from(JSON.stringify(json)), 0x20);
  const totalLength = 12 + 8 + jsonChunk.length + 8 + binary.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(totalLength, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonChunk.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binary.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHeader, jsonChunk, binHeader, binary]);
}

mkdirSync(output, { recursive: true });
const models = {
  'vehicle-bus.glb': createGlb([0.95, 0.38, 0.02]),
  'vehicle-metro.glb': createGlb([0.04, 0.34, 0.92]),
  // Target is deliberately mode-independent so the boarding vehicle can be
  // recognized immediately. A small emissive component improves contrast.
  'vehicle-target.glb': createGlb([0.35, 0.95, 0.08], [0.08, 0.25, 0.02]),
};

for (const [name, bytes] of Object.entries(models)) {
  writeFileSync(resolve(output, name), bytes);
  console.log(`${name}: ${bytes.length} bytes`);
}

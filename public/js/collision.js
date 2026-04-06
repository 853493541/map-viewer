/**
 * Collision System - Ground height from terrain heightmap.
 * Entity mesh collision disabled (InstancedMesh is not raycast-compatible per-instance).
 */
import * as THREE from 'three';

export class CollisionSystem {
  constructor(terrainSystem) {
    this.terrainSystem = terrainSystem;
  }

  setEntityMeshes(meshes) { /* no-op with instanced rendering */ }

  getGroundHeight(x, y, z) {
    if (this.terrainSystem) {
      const th = this.terrainSystem.getHeightAt(x, z);
      if (th !== null) return th;
    }
    return null;
  }
}

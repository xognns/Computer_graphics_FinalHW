import * as THREE from 'three';

export type DirectLightSample = {
  position: THREE.Vector3;
  color: THREE.Color;
  intensity: number;
  radius: number;
  direction?: THREE.Vector3;
  spotCosine?: number;
};

type DDGIProbe = {
  gridPosition: THREE.Vector3;
  position: THREE.Vector3;
  sh: THREE.Vector3[];
  prevSH: THREE.Vector3[];
  surfacePoint: THREE.Vector3 | null;
  surfaceNormal: THREE.Vector3 | null;
  surfaceDistance: number;
  debugMarker: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
};

type FloatingGIObject = {
  group: THREE.Group;
  position: THREE.Vector3;
  linkedProbeIndex: number;
  phase: number;
  debugMarker: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  markerReveal: number;
};

const GRID_X = 18;
const GRID_Y = 2;
const GRID_Z = 12;
const PROBE_SPACING = 3.5;
const RAYS_PER_PROBE = 18;
const PROBES_PER_FRAME = 8;
const FLOATING_VISIBILITY_PER_FRAME = 36;
const TEMPORAL_BLEND = 0.18;
const FEEDBACK_STRENGTH = 0.55;
const DARK_FLOATING_MULTIPLIER = 0.06;
const SH_C0 = 0.282095;
const SH_C1 = 0.488603;

export class DDGIManager {
  readonly group = new THREE.Group();

  private readonly probes: DDGIProbe[] = [];
  private readonly floatingObjects: FloatingGIObject[] = [];
  private readonly floatingRaycastTargets: THREE.Object3D[] = [];
  private readonly raycaster = new THREE.Raycaster();
  private readonly rayDirections = this.createRayDirections(RAYS_PER_PROBE);
  private readonly probeOrigin = new THREE.Vector3(
    -((GRID_X - 1) * PROBE_SPACING) / 2,
    0.8,
    -((GRID_Z - 1) * PROBE_SPACING) / 2,
  );
  private updateCursor = 0;
  private floatingVisibilityCursor = 0;
  private debugVisible = false;

  constructor() {
    this.group.name = 'FloatingDDGIProbeObjects';
    this.group.visible = true;
    this.createProbeGrid();
    this.createFloatingGIObjects();
  }

  toggleDebug() {
    this.debugVisible = !this.debugVisible;
    if (!this.debugVisible) {
      for (const probe of this.probes) {
        probe.debugMarker.visible = false;
      }
      return;
    }

    this.updateProbeVisuals();
  }

  update(lightSamples: DirectLightSample[], raycastTargets: THREE.Object3D[]) {
    if (raycastTargets.length === 0) {
      return;
    }

    for (let i = 0; i < PROBES_PER_FRAME; i += 1) {
      const probe = this.probes[this.updateCursor];
      this.updateProbe(probe, lightSamples, raycastTargets);
      this.updateCursor = (this.updateCursor + 1) % this.probes.length;
    }

    this.updateProbeVisuals();
  }

  sampleIrradiance(position: THREE.Vector3, normal: THREE.Vector3) {
    const localX = (position.x - this.probeOrigin.x) / PROBE_SPACING;
    const localY = (position.y - this.probeOrigin.y) / PROBE_SPACING;
    const localZ = (position.z - this.probeOrigin.z) / PROBE_SPACING;

    const x0 = THREE.MathUtils.clamp(Math.floor(localX), 0, GRID_X - 1);
    const y0 = THREE.MathUtils.clamp(Math.floor(localY), 0, GRID_Y - 1);
    const z0 = THREE.MathUtils.clamp(Math.floor(localZ), 0, GRID_Z - 1);
    const x1 = THREE.MathUtils.clamp(x0 + 1, 0, GRID_X - 1);
    const y1 = THREE.MathUtils.clamp(y0 + 1, 0, GRID_Y - 1);
    const z1 = THREE.MathUtils.clamp(z0 + 1, 0, GRID_Z - 1);
    const tx = THREE.MathUtils.clamp(localX - x0, 0, 1);
    const ty = THREE.MathUtils.clamp(localY - y0, 0, 1);
    const tz = THREE.MathUtils.clamp(localZ - z0, 0, 1);

    const result = new THREE.Vector3();

    for (const [x, wx] of [
      [x0, 1 - tx],
      [x1, tx],
    ] as const) {
      for (const [y, wy] of [
        [y0, 1 - ty],
        [y1, ty],
      ] as const) {
        for (const [z, wz] of [
          [z0, 1 - tz],
          [z1, tz],
        ] as const) {
          const weight = wx * wy * wz;
          result.addScaledVector(this.evaluateSH(this.probeAt(x, y, z).sh, normal), weight);
        }
      }
    }

    return result;
  }

  getAverageIntensity() {
    let total = 0;

    for (const probe of this.probes) {
      total += probe.sh[0].length();
    }

    return total / this.probes.length;
  }

  getStrongestProbeNear(origin: THREE.Vector3, radius: number) {
    const normal = new THREE.Vector3(0, 1, 0);
    let bestProbe: {
      position: THREE.Vector3;
      score: number;
      indirect: number;
      direct: number;
    } | null = null;

    for (const probe of this.probes) {
      if (probe.gridPosition.distanceTo(origin) > radius) continue;

      const indirect = this.evaluateSH(probe.sh, normal).length();
      if (!bestProbe || indirect > bestProbe.score) {
        bestProbe = {
          position: probe.position.clone(),
          score: indirect,
          indirect,
          direct: 0,
        };
      }
    }

    return bestProbe;
  }

  getStrongestVisibleProbe(origin: THREE.Vector3, raycastTargets: THREE.Object3D[]) {
    const normal = new THREE.Vector3(0, 1, 0);
    let bestProbe: {
      position: THREE.Vector3;
      score: number;
      indirect: number;
      direct: number;
    } | null = null;

    for (const probe of this.probes) {
      if (!this.canSeePoint(origin, probe.position, raycastTargets)) continue;

      const indirect = this.evaluateSH(probe.sh, normal).length();
      if (!bestProbe || indirect > bestProbe.score) {
        bestProbe = {
          position: probe.position.clone(),
          score: indirect,
          indirect,
          direct: 0,
        };
      }
    }

    return bestProbe;
  }

  getProbeDebugSamples(normal = new THREE.Vector3(0, 1, 0)) {
    return this.probes.map((probe) => {
      const irradiance = this.evaluateSH(probe.sh, normal);
      const direction = this.getDominantDirection(probe.sh);
      return {
        position: probe.position.clone(),
        irradiance,
        intensity: irradiance.length(),
        direction,
        surfacePoint: probe.surfacePoint?.clone() ?? null,
        surfaceNormal: probe.surfaceNormal?.clone() ?? null,
        surfaceDistance: probe.surfaceDistance,
        hasSurface: probe.surfacePoint !== null,
      };
    });
  }

  getFloatingObjectSamples(normal = new THREE.Vector3(0, 1, 0)) {
    return this.floatingObjects.map((object) => {
      const probe = this.probes[object.linkedProbeIndex];
      const irradiance = this.evaluateSH(probe.sh, normal);
      const direction = this.getDominantDirection(probe.sh);

      return {
        position: object.group.position.clone(),
        probePosition: probe.position.clone(),
        irradiance,
        intensity: irradiance.length(),
        direction,
      };
    });
  }

  getRaycastTargets() {
    return this.floatingRaycastTargets;
  }

  updateFloatingObjectVisibility(
    sampleIrradiance: (position: THREE.Vector3) => THREE.Vector3,
    directLights: DirectLightSample[],
    observerPosition: THREE.Vector3,
    occluders: THREE.Object3D[],
    brightnessDebug = false,
  ) {
    const count = Math.min(FLOATING_VISIBILITY_PER_FRAME, this.floatingObjects.length);

    for (let i = 0; i < count; i += 1) {
      const object = this.floatingObjects[this.floatingVisibilityCursor];
      const position = object.group.getWorldPosition(new THREE.Vector3());
      const indirect = sampleIrradiance(position);
      const direct = this.computeDirectReveal(position, directLights, occluders);
      const flashlightDirect = this.computeDirectReveal(
        position,
        directLights.filter((light) => light.direction && light.spotCosine !== undefined),
        occluders,
      );
      const observerVisibility = brightnessDebug
        ? 1
        : this.canObserverSeeObject(
          observerPosition,
          position,
          occluders,
        );
      const reveal = Math.max(
        brightnessDebug ? 0.84 : 0,
        THREE.MathUtils.clamp(
          indirect.length() * 0.65 + direct.length() * 0.09,
          0,
          1,
        ) * observerVisibility,
      );
      const lightColor = new THREE.Color(
        THREE.MathUtils.clamp(indirect.x * 0.35 + direct.x * 0.05, 0.02, 1),
        THREE.MathUtils.clamp(indirect.y * 0.35 + direct.y * 0.05, 0.02, 1),
        THREE.MathUtils.clamp(indirect.z * 0.35 + direct.z * 0.05, 0.02, 1),
      );

      this.applyFloatingObjectLighting(object.group, lightColor, reveal);
      this.updateFloatingProbeMarker(object, flashlightDirect.length() * observerVisibility);
      this.floatingVisibilityCursor = (this.floatingVisibilityCursor + 1) % this.floatingObjects.length;
    }
  }

  updateFloatingObjectMotion(lowGravity: boolean, elapsedSeconds: number) {
    for (const object of this.floatingObjects) {
      if (lowGravity) {
        object.group.position.set(
          object.position.x,
          object.position.y + Math.sin(elapsedSeconds * 1.2 + object.phase) * 0.08,
          object.position.z,
        );
        object.debugMarker.position.copy(object.group.position);
        object.debugMarker.position.y += 0.42;
        object.group.rotation.y += 0.006;
        continue;
      }

      object.group.position.set(object.position.x, 0.2, object.position.z);
      object.debugMarker.position.copy(object.group.position);
      object.debugMarker.position.y += 0.42;
      object.group.rotation.x = 0;
      object.group.rotation.z = 0;
    }
  }

  private getDominantDirection(sh: THREE.Vector3[]) {
    const direction = new THREE.Vector3(
      sh[3].x + sh[3].y + sh[3].z,
      sh[1].x + sh[1].y + sh[1].z,
      sh[2].x + sh[2].y + sh[2].z,
    );

    if (direction.lengthSq() < 0.000001) {
      return new THREE.Vector3(0, 1, 0);
    }

    return direction.normalize();
  }

  private canSeePoint(
    origin: THREE.Vector3,
    target: THREE.Vector3,
    raycastTargets: THREE.Object3D[],
  ) {
    const toTarget = target.clone().sub(origin);
    const distance = toTarget.length();
    if (distance < 0.001) return true;

    const direction = toTarget.normalize();
    this.raycaster.set(origin.clone().addScaledVector(direction, 0.08), direction);
    this.raycaster.far = Math.max(distance - 0.16, 0.001);

    return this.raycaster.intersectObjects(raycastTargets, true).length === 0;
  }

  private updateProbe(
    probe: DDGIProbe,
    lightSamples: DirectLightSample[],
    raycastTargets: THREE.Object3D[],
  ) {
    const nextSH = this.createEmptySH();
    let nearestSurfacePoint: THREE.Vector3 | null = null;
    let nearestSurfaceNormal: THREE.Vector3 | null = null;
    let nearestSurfaceDistance = Infinity;

    for (const direction of this.rayDirections) {
      this.raycaster.set(probe.position, direction);
      this.raycaster.far = 18;

      const hit = this.raycaster.intersectObjects(raycastTargets, true)[0];
      if (!hit) continue;

      const hitNormal = hit.face
        ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize()
        : direction.clone().multiplyScalar(-1);

      if (hit.distance < nearestSurfaceDistance) {
        nearestSurfaceDistance = hit.distance;
        nearestSurfacePoint = hit.point.clone();
        nearestSurfaceNormal = hitNormal.clone();
      }

      const radiance = this.computeRadiance(
        hit.point,
        hitNormal,
        lightSamples,
        raycastTargets,
      );
      const feedback = this.sampleNearestPrevious(hit.point, hitNormal).multiplyScalar(
        FEEDBACK_STRENGTH,
      );
      radiance.add(feedback);
      this.accumulateSH(nextSH, direction, radiance);
    }

    probe.surfacePoint = nearestSurfacePoint;
    probe.surfaceNormal = nearestSurfaceNormal;
    probe.surfaceDistance = nearestSurfaceDistance;
    probe.position.copy(probe.gridPosition);

    for (let i = 0; i < 4; i += 1) {
      nextSH[i].multiplyScalar(1 / RAYS_PER_PROBE);
      probe.prevSH[i].copy(probe.sh[i]);
      probe.sh[i].lerp(nextSH[i], TEMPORAL_BLEND);
    }
  }

  private computeRadiance(
    point: THREE.Vector3,
    normal: THREE.Vector3,
    lightSamples: DirectLightSample[],
    raycastTargets: THREE.Object3D[],
  ) {
    const radiance = new THREE.Vector3();

    for (const light of lightSamples) {
      const toLight = light.position.clone().sub(point);
      const distance = Math.max(toLight.length(), 0.001);

      if (distance > light.radius) continue;

      toLight.normalize();
      if (!this.canReachLight(point, toLight, distance, raycastTargets)) continue;

      const normalTerm = Math.max(normal.dot(toLight), 0.08);
      let spotTerm = 1;

      if (light.direction && light.spotCosine !== undefined) {
        const fromLight = point.clone().sub(light.position).normalize();
        const coneDot = light.direction.dot(fromLight);
        spotTerm = THREE.MathUtils.smoothstep(coneDot, light.spotCosine, 1);
      }

      const attenuation = light.intensity / (1 + distance * distance * 0.22);
      radiance.add(
        new THREE.Vector3(light.color.r, light.color.g, light.color.b).multiplyScalar(
          attenuation * normalTerm * spotTerm,
        ),
      );
    }

    return radiance;
  }

  private canReachLight(
    point: THREE.Vector3,
    directionToLight: THREE.Vector3,
    distanceToLight: number,
    raycastTargets: THREE.Object3D[],
  ) {
    const origin = point.clone().addScaledVector(directionToLight, 0.06);
    this.raycaster.set(origin, directionToLight);
    this.raycaster.far = Math.max(distanceToLight - 0.12, 0.001);

    return this.raycaster.intersectObjects(raycastTargets, true).length === 0;
  }

  private sampleNearestPrevious(position: THREE.Vector3, normal: THREE.Vector3) {
    let nearest = this.probes[0];
    let nearestDistance = Infinity;

    for (const probe of this.probes) {
      const distance = probe.gridPosition.distanceToSquared(position);
      if (distance < nearestDistance) {
        nearest = probe;
        nearestDistance = distance;
      }
    }

    return this.evaluateSH(nearest.prevSH, normal);
  }

  private accumulateSH(sh: THREE.Vector3[], direction: THREE.Vector3, radiance: THREE.Vector3) {
    const basis = [
      SH_C0,
      SH_C1 * direction.y,
      SH_C1 * direction.z,
      SH_C1 * direction.x,
    ];

    for (let i = 0; i < 4; i += 1) {
      sh[i].addScaledVector(radiance, basis[i]);
    }
  }

  private evaluateSH(sh: THREE.Vector3[], normal: THREE.Vector3) {
    const basis = [SH_C0, SH_C1 * normal.y, SH_C1 * normal.z, SH_C1 * normal.x];
    const result = new THREE.Vector3();

    for (let i = 0; i < 4; i += 1) {
      result.addScaledVector(sh[i], basis[i]);
    }

    return result.max(new THREE.Vector3(0, 0, 0));
  }

  private updateProbeVisuals() {
    if (!this.debugVisible) {
      return;
    }

    for (let index = 0; index < this.probes.length; index += 1) {
      const probe = this.probes[index];
      const color = this.evaluateSH(probe.sh, new THREE.Vector3(0, 1, 0));
      const intensity = THREE.MathUtils.clamp(color.length() * 0.6, 0, 1);
      const displayColor = new THREE.Color().setRGB(
        THREE.MathUtils.clamp(color.x * 0.5, 0.02, 1),
        THREE.MathUtils.clamp(color.y * 0.5, 0.02, 1),
        THREE.MathUtils.clamp(color.z * 0.5, 0.02, 1),
      );
      probe.debugMarker.position.copy(probe.position);
      probe.debugMarker.visible = this.debugVisible;
      probe.debugMarker.material.color.copy(displayColor);
      probe.debugMarker.scale.setScalar(0.75 + intensity * 1.2);
    }

  }

  private createProbeGrid() {
    for (let y = 0; y < GRID_Y; y += 1) {
      for (let z = 0; z < GRID_Z; z += 1) {
        for (let x = 0; x < GRID_X; x += 1) {
          const position = new THREE.Vector3(
            this.probeOrigin.x + x * PROBE_SPACING,
            this.probeOrigin.y + y * PROBE_SPACING,
            this.probeOrigin.z + z * PROBE_SPACING,
          );
          const debugMarker = this.createProbeMarker();
          debugMarker.position.copy(position);
          debugMarker.visible = this.debugVisible;
          this.group.add(debugMarker);
          this.probes.push({
            gridPosition: position.clone(),
            position,
            sh: this.createEmptySH(),
            prevSH: this.createEmptySH(),
            surfacePoint: null,
            surfaceNormal: null,
            surfaceDistance: Infinity,
            debugMarker,
          });
        }
      }
    }
  }

  private createFloatingGIObjects() {
    const placements = this.createFloatingObjectPlacements();

    placements.forEach((placement, index) => {
      const visualObject = this.createFloatingProbeObject(index);
      visualObject.position.copy(placement.position);
      visualObject.rotation.set(placement.rotation.x, placement.rotation.y, placement.rotation.z);
      visualObject.scale.setScalar(placement.scale);
      this.group.add(visualObject);
      this.floatingRaycastTargets.push(visualObject);

      const debugMarker = this.createFloatingObjectProbeMarker();
      debugMarker.position.copy(placement.position);
      debugMarker.position.y += 0.42;
      debugMarker.visible = this.debugVisible;
      this.group.add(debugMarker);

      this.floatingObjects.push({
        group: visualObject,
        position: placement.position.clone(),
        linkedProbeIndex: this.findNearestProbeIndex(placement.position),
        phase: placement.phase,
        debugMarker,
        markerReveal: 0,
      });
    });
  }

  private updateFloatingProbeMarker(object: FloatingGIObject, flashlightIntensity: number) {
    if (!this.debugVisible) {
      object.markerReveal = 0;
      object.debugMarker.visible = false;
      return;
    }

    object.markerReveal = THREE.MathUtils.lerp(
      object.markerReveal,
      THREE.MathUtils.clamp(flashlightIntensity * 0.42, 0, 1),
      0.45,
    );

    if (object.markerReveal < 0.035) {
      object.debugMarker.visible = false;
      return;
    }

    const probe = this.probes[object.linkedProbeIndex];
    const color = this.evaluateSH(probe.sh, new THREE.Vector3(0, 1, 0));
    const displayColor = new THREE.Color().setRGB(
      THREE.MathUtils.clamp(color.x * 0.62 + 0.1, 0.12, 1),
      THREE.MathUtils.clamp(color.y * 0.62 + 0.08, 0.1, 1),
      THREE.MathUtils.clamp(color.z * 0.72 + 0.28, 0.32, 1),
    );

    object.debugMarker.visible = true;
    object.debugMarker.material.color.copy(displayColor);
    object.debugMarker.material.opacity = THREE.MathUtils.lerp(0.28, 0.96, object.markerReveal);
    object.debugMarker.scale.setScalar(0.72 + object.markerReveal * 1.2);
  }

  private createFloatingObjectPlacements() {
    const clusters = [
      { center: new THREE.Vector3(-27.0, 1.05, -17.0), count: 3, spread: new THREE.Vector3(1.8, 0.7, 1.4) },
      { center: new THREE.Vector3(-22.8, 1.3, -15.0), count: 3, spread: new THREE.Vector3(2.2, 0.9, 1.6) },
      { center: new THREE.Vector3(-15.6, 1.2, -17.1), count: 3, spread: new THREE.Vector3(2.1, 0.8, 1.3) },
      { center: new THREE.Vector3(-26.5, 1.25, -6.5), count: 3, spread: new THREE.Vector3(2.0, 0.8, 1.9) },
      { center: new THREE.Vector3(-22.4, 1.35, -3.0), count: 2, spread: new THREE.Vector3(1.7, 0.7, 1.4) },
      { center: new THREE.Vector3(-27.4, 1.1, 5.1), count: 3, spread: new THREE.Vector3(2.0, 0.8, 1.5) },
      { center: new THREE.Vector3(-24.0, 1.4, 13.2), count: 3, spread: new THREE.Vector3(2.2, 0.9, 1.8) },
      { center: new THREE.Vector3(-16.0, 1.15, 16.0), count: 3, spread: new THREE.Vector3(1.8, 0.8, 1.6) },
      { center: new THREE.Vector3(-14.0, 1.3, 5.0), count: 3, spread: new THREE.Vector3(1.7, 0.8, 2.0) },
      { center: new THREE.Vector3(-6.0, 1.2, -16.5), count: 3, spread: new THREE.Vector3(2.0, 0.8, 1.5) },
      { center: new THREE.Vector3(-2.0, 1.35, -14.0), count: 3, spread: new THREE.Vector3(1.6, 0.9, 1.8) },
      { center: new THREE.Vector3(-6.2, 1.2, -6.0), count: 3, spread: new THREE.Vector3(1.7, 0.8, 1.5) },
      { center: new THREE.Vector3(-3.6, 1.3, 3.6), count: 3, spread: new THREE.Vector3(1.8, 0.8, 1.9) },
      { center: new THREE.Vector3(-5.0, 1.25, 14.8), count: 3, spread: new THREE.Vector3(1.8, 0.8, 1.7) },
      { center: new THREE.Vector3(4.2, 1.2, -17.0), count: 3, spread: new THREE.Vector3(1.7, 0.7, 1.4) },
      { center: new THREE.Vector3(4.8, 1.35, -5.4), count: 3, spread: new THREE.Vector3(1.7, 0.8, 1.4) },
      { center: new THREE.Vector3(3.0, 1.3, 4.5), count: 3, spread: new THREE.Vector3(1.9, 0.8, 1.7) },
      { center: new THREE.Vector3(4.0, 1.45, 15.2), count: 3, spread: new THREE.Vector3(1.8, 0.9, 1.5) },
      { center: new THREE.Vector3(14.0, 1.2, -16.0), count: 3, spread: new THREE.Vector3(2.0, 0.8, 1.4) },
      { center: new THREE.Vector3(17.6, 1.3, -6.0), count: 3, spread: new THREE.Vector3(1.8, 0.8, 1.7) },
      { center: new THREE.Vector3(13.6, 1.2, 4.5), count: 3, spread: new THREE.Vector3(1.6, 0.7, 1.7) },
      { center: new THREE.Vector3(15.8, 1.4, 14.6), count: 3, spread: new THREE.Vector3(1.8, 0.9, 1.5) },
      { center: new THREE.Vector3(25.0, 1.2, -16.2), count: 3, spread: new THREE.Vector3(2.0, 0.8, 1.6) },
      { center: new THREE.Vector3(25.5, 1.3, -5.5), count: 3, spread: new THREE.Vector3(1.8, 0.8, 1.5) },
      { center: new THREE.Vector3(24.0, 1.25, 5.0), count: 3, spread: new THREE.Vector3(1.8, 0.8, 1.7) },
      { center: new THREE.Vector3(25.4, 1.45, 15.5), count: 3, spread: new THREE.Vector3(2.0, 0.9, 1.6) },
      { center: new THREE.Vector3(-14.5, 1.2, -3.8), count: 2, spread: new THREE.Vector3(1.3, 0.7, 1.4) },
      { center: new THREE.Vector3(13.0, 1.2, 16.8), count: 2, spread: new THREE.Vector3(1.4, 0.7, 1.2) },
      { center: new THREE.Vector3(27.0, 1.2, 1.8), count: 2, spread: new THREE.Vector3(1.2, 0.7, 1.5) },
      { center: new THREE.Vector3(-1.5, 1.25, 17.0), count: 2, spread: new THREE.Vector3(1.5, 0.8, 1.2) },
    ];
    const placements: Array<{
      position: THREE.Vector3;
      rotation: THREE.Euler;
      scale: number;
      phase: number;
    }> = [];

    clusters.forEach((cluster, clusterIndex) => {
      const objectsInCluster = cluster.count + 2;
      for (let i = 0; i < objectsInCluster; i += 1) {
        const seed = clusterIndex * 19 + i * 7 + 3;
        const offset = new THREE.Vector3(
          (this.seededNoise(seed) - 0.5) * cluster.spread.x,
          (this.seededNoise(seed + 1) - 0.5) * cluster.spread.y,
          (this.seededNoise(seed + 2) - 0.5) * cluster.spread.z,
        );
        placements.push({
          position: cluster.center.clone().add(offset),
          rotation: new THREE.Euler(
            this.seededNoise(seed + 3) * Math.PI,
            this.seededNoise(seed + 4) * Math.PI * 2,
            this.seededNoise(seed + 5) * Math.PI,
          ),
          scale: THREE.MathUtils.lerp(0.78, 1.25, this.seededNoise(seed + 6)),
          phase: this.seededNoise(seed + 7) * Math.PI * 2,
        });
      }
    });

    return placements;
  }

  private findNearestProbeIndex(position: THREE.Vector3) {
    let nearestIndex = 0;
    let nearestDistance = Infinity;

    for (let index = 0; index < this.probes.length; index += 1) {
      const distance = this.probes[index].gridPosition.distanceToSquared(position);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    }

    return nearestIndex;
  }

  private seededNoise(seed: number) {
    const value = Math.sin(seed * 12.9898) * 43758.5453;
    return value - Math.floor(value);
  }

  private computeDirectReveal(
    point: THREE.Vector3,
    directLights: DirectLightSample[],
    occluders: THREE.Object3D[],
  ) {
    const result = new THREE.Vector3();

    for (const light of directLights) {
      if (light.intensity <= 0) continue;

      const fromLightToPoint = point.clone().sub(light.position);
      const distance = fromLightToPoint.length();
      if (distance <= 0.001 || distance > light.radius) continue;

      const direction = fromLightToPoint.normalize();
      let spotTerm = 1;

      if (light.direction && light.spotCosine !== undefined) {
        const coneDot = light.direction.dot(direction);
        if (coneDot < light.spotCosine) continue;
        spotTerm = THREE.MathUtils.smoothstep(coneDot, light.spotCosine, 1);
      }

      if (!this.canReachPoint(light.position, direction, distance, occluders)) {
        continue;
      }

      const attenuation = (light.intensity * spotTerm) / (1 + distance * distance * 0.16);
      result.add(
        new THREE.Vector3(light.color.r, light.color.g, light.color.b).multiplyScalar(
          attenuation,
        ),
      );
    }

    return result;
  }

  private canObserverSeeObject(
    observerPosition: THREE.Vector3,
    targetPosition: THREE.Vector3,
    occluders: THREE.Object3D[],
  ) {
    const origin = observerPosition.clone().add(new THREE.Vector3(0, 0.75, 0));
    const target = targetPosition.clone();
    const toTarget = target.sub(origin);
    const distance = toTarget.length();
    if (distance < 0.001) return 1;

    return this.canReachPoint(origin, toTarget.normalize(), Math.max(distance - 0.08, 0.001), occluders)
      ? 1
      : 0;
  }

  private canReachPoint(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    distance: number,
    occluders: THREE.Object3D[],
  ) {
    this.raycaster.set(origin.clone().addScaledVector(direction, 0.08), direction);
    this.raycaster.far = Math.max(distance - 0.12, 0.001);
    return this.raycaster.intersectObjects(occluders, true).length === 0;
  }

  private applyFloatingObjectLighting(object: THREE.Group, lightColor: THREE.Color, reveal: number) {
    object.traverse((child) => {
      const mesh = child as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
      if (!mesh.isMesh || !mesh.material) return;

      const baseColor = mesh.userData.baseColor as THREE.Color | undefined;
      if (!baseColor) return;

      const visibleColor = baseColor.clone().multiplyScalar(
        THREE.MathUtils.lerp(DARK_FLOATING_MULTIPLIER, 1, reveal),
      );
      mesh.material.color.copy(visibleColor.lerp(lightColor, reveal * 0.35));
      mesh.material.opacity = THREE.MathUtils.lerp(0.18, 0.9, reveal);
    });
  }

  private createFloatingProbeObject(index: number) {
    const group = new THREE.Group();
    group.name = 'FloatingProbeObject';

    const variant = index % 4;
    if (variant === 0) {
      this.addElectronicProbeGeometry(group);
    } else if (variant === 1) {
      this.addFoodPackProbeGeometry(group);
    } else if (variant === 2) {
      this.addNoteProbeGeometry(group);
    } else {
      this.addBedrollProbeGeometry(group);
    }

    return group;
  }

  private createProbeMarker() {
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.11, 10, 8),
      new THREE.MeshBasicMaterial({
        color: 0x94f7ff,
        transparent: true,
        opacity: 0.92,
        depthWrite: false,
        depthTest: false,
      }),
    );
    marker.name = 'DDGIProbeMarker';
    marker.renderOrder = 20;
    return marker;
  }

  private createFloatingObjectProbeMarker() {
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 12, 8),
      new THREE.MeshBasicMaterial({
        color: 0xc76bff,
        transparent: true,
        opacity: 0.96,
        depthWrite: false,
        depthTest: false,
      }),
    );
    marker.name = 'FloatingObjectLinkedProbeMarker';
    marker.renderOrder = 24;
    return marker;
  }

  private addProbeMesh(group: THREE.Group, mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>) {
    mesh.material.depthWrite = false;
    mesh.material.transparent = true;
    mesh.material.opacity = 0.88;
    mesh.userData.baseColor = mesh.material.color.clone();
    group.add(mesh);
  }

  private addElectronicProbeGeometry(group: THREE.Group) {
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.72, 0.34, 0.48),
      new THREE.MeshBasicMaterial({ color: 0x51606c }),
    );
    this.addProbeMesh(group, body);

    const screen = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.03, 0.3),
      new THREE.MeshBasicMaterial({ color: 0x2df1ff }),
    );
    screen.position.set(0, 0.18, -0.04);
    this.addProbeMesh(group, screen);

    const antenna = new THREE.Mesh(
      new THREE.CylinderGeometry(0.025, 0.025, 0.55, 6),
      new THREE.MeshBasicMaterial({ color: 0xb8c7d4 }),
    );
    antenna.position.set(0.34, 0.4, 0.18);
    antenna.rotation.z = 0.55;
    this.addProbeMesh(group, antenna);
  }

  private addFoodPackProbeGeometry(group: THREE.Group) {
    const pack = new THREE.Mesh(
      new THREE.BoxGeometry(0.62, 0.12, 0.44),
      new THREE.MeshBasicMaterial({ color: 0xe7d58a }),
    );
    pack.rotation.z = 0.12;
    this.addProbeMesh(group, pack);

    const label = new THREE.Mesh(
      new THREE.BoxGeometry(0.28, 0.025, 0.24),
      new THREE.MeshBasicMaterial({ color: 0xff5f75 }),
    );
    label.position.y = 0.08;
    this.addProbeMesh(group, label);
  }

  private addNoteProbeGeometry(group: THREE.Group) {
    const note = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.03, 0.38),
      new THREE.MeshBasicMaterial({ color: 0xf5f1c9 }),
    );
    note.rotation.set(0.2, 0.12, -0.28);
    this.addProbeMesh(group, note);

    for (let i = 0; i < 3; i += 1) {
      const line = new THREE.Mesh(
        new THREE.BoxGeometry(0.32 - i * 0.04, 0.012, 0.018),
        new THREE.MeshBasicMaterial({ color: 0x62707a }),
      );
      line.position.set(0, 0.03, -0.1 + i * 0.1);
      line.rotation.copy(note.rotation);
      this.addProbeMesh(group, line);
    }
  }

  private addBedrollProbeGeometry(group: THREE.Group) {
    const roll = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.18, 0.68, 4, 10),
      new THREE.MeshBasicMaterial({ color: 0x6f7fa4 }),
    );
    roll.rotation.z = Math.PI / 2;
    this.addProbeMesh(group, roll);

    const strap = new THREE.Mesh(
      new THREE.BoxGeometry(0.08, 0.42, 0.08),
      new THREE.MeshBasicMaterial({ color: 0x232a34 }),
    );
    strap.position.x = 0.08;
    this.addProbeMesh(group, strap);
  }

  private probeAt(x: number, y: number, z: number) {
    return this.probes[y * GRID_X * GRID_Z + z * GRID_X + x];
  }

  private createEmptySH() {
    return [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  }

  private createRayDirections(count: number) {
    const directions: THREE.Vector3[] = [];
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));

    for (let i = 0; i < count; i += 1) {
      const y = 1 - (i / (count - 1)) * 2;
      const radius = Math.sqrt(1 - y * y);
      const theta = goldenAngle * i;
      directions.push(
        new THREE.Vector3(Math.cos(theta) * radius, y, Math.sin(theta) * radius).normalize(),
      );
    }

    return directions;
  }
}

import * as THREE from 'three';
import { InputManager } from './InputManager';
import { StationMap } from './StationMap';

const PLAYER_RADIUS = 0.38;
const PLAYER_SPEED = 5.4;
const LOW_GRAVITY_SPEED_MULTIPLIER = 1.24;
const LOW_GRAVITY_STEERING = 0.045;
const LOW_GRAVITY_DAMPING = 0.985;
const FLASHLIGHT_CONE_HALF_ANGLE = THREE.MathUtils.degToRad(10);
const FLASHLIGHT_LIGHT_HALF_ANGLE = FLASHLIGHT_CONE_HALF_ANGLE;
const FLASHLIGHT_RANGE = 76;
const FLASHLIGHT_CONE_LENGTH = FLASHLIGHT_RANGE;
const FLASHLIGHT_CONE_NEAR_OFFSET = 0.25;
const FLASHLIGHT_CONE_COLOR = 0x9fb8c4;
const FLASHLIGHT_CONE_OPACITY = 0.44;
const FLASHLIGHT_CONE_SEGMENTS = 36;

function createFlashlightConeGeometry(length: number) {
  const positions: number[] = [];
  const ranges: number[] = [];
  const origin = new THREE.Vector3(0, 0, 0);
  const arcDistance = Math.max(length, FLASHLIGHT_CONE_NEAR_OFFSET + 0.1);

  for (let index = 0; index < FLASHLIGHT_CONE_SEGMENTS; index += 1) {
    const t0 = index / FLASHLIGHT_CONE_SEGMENTS;
    const t1 = (index + 1) / FLASHLIGHT_CONE_SEGMENTS;
    const angle0 = THREE.MathUtils.lerp(-FLASHLIGHT_CONE_HALF_ANGLE, FLASHLIGHT_CONE_HALF_ANGLE, t0);
    const angle1 = THREE.MathUtils.lerp(-FLASHLIGHT_CONE_HALF_ANGLE, FLASHLIGHT_CONE_HALF_ANGLE, t1);
    const p0 = new THREE.Vector3(
      Math.sin(angle0) * arcDistance,
      0,
      -Math.cos(angle0) * arcDistance,
    );
    const p1 = new THREE.Vector3(
      Math.sin(angle1) * arcDistance,
      0,
      -Math.cos(angle1) * arcDistance,
    );

    positions.push(origin.x, origin.y, origin.z, p0.x, p0.y, p0.z, p1.x, p1.y, p1.z);
    ranges.push(0, 1, 1);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aRange', new THREE.Float32BufferAttribute(ranges, 1));
  geometry.computeVertexNormals();
  return geometry;
}

function createFlashlightConeMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide,
    uniforms: {
      color: { value: new THREE.Color(FLASHLIGHT_CONE_COLOR) },
      opacity: { value: FLASHLIGHT_CONE_OPACITY },
    },
    vertexShader: `
      attribute float aRange;
      varying float vRange;

      void main() {
        vRange = aRange;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 color;
      uniform float opacity;
      varying float vRange;

      void main() {
        float nearFade = smoothstep(0.0, 0.08, vRange);
        float farFade = 1.0 - smoothstep(0.72, 1.0, vRange);
        float alpha = opacity * max(nearFade * farFade, 0.18);
        if (alpha <= 0.002) discard;
        gl_FragColor = vec4(color, alpha);
      }
    `,
  });
}

export class PlayerController {
  readonly object: THREE.Group;
  readonly flashlight: THREE.SpotLight;
  
  private readonly body: THREE.Mesh;
  private readonly flashlightCone: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly flashlightTarget = new THREE.Object3D();
  private readonly flashlightRaycaster = new THREE.Raycaster();
  private readonly heading = new THREE.Vector3(0, 0, -1);
  private readonly velocity = new THREE.Vector2();
  private currentFlashlightConeLength = FLASHLIGHT_CONE_LENGTH;
  private flashlightEnabled = false;

  constructor(
    private readonly input: InputManager,
    private readonly stationMap: StationMap,
  ) {
    this.object = new THREE.Group();
    this.object.name = 'Isaac';
    this.object.position.set(-27.0, 0, -17.8);

    this.body = new THREE.Mesh(
      new THREE.CapsuleGeometry(PLAYER_RADIUS, 1.05, 8, 16),
      new THREE.MeshStandardMaterial({
        color: 0xf2f4ff,
        roughness: 0.42,
        metalness: 0.28,
      }),
    );
    this.body.position.y = 0.82;
    this.object.add(this.body);
    this.createAstronautDetails();

    this.flashlight = new THREE.SpotLight(
      0xdcecff,
      4.5,
      FLASHLIGHT_RANGE,
      FLASHLIGHT_LIGHT_HALF_ANGLE,
      0.55,
      1.4,
    );
    this.flashlight.position.set(0, 1.05, -0.38);
    this.flashlight.target = this.flashlightTarget;
    this.flashlight.castShadow = true;
    this.flashlight.shadow.mapSize.set(512, 512);
    this.flashlight.shadow.camera.near = 0.1;
    this.flashlight.shadow.camera.far = this.flashlight.distance;
    this.flashlight.visible = this.flashlightEnabled;
    this.object.add(this.flashlight);
    this.object.add(this.flashlightTarget);

    this.flashlightCone = new THREE.Mesh(
      createFlashlightConeGeometry(FLASHLIGHT_CONE_LENGTH),
      createFlashlightConeMaterial(),
    );
    this.flashlightCone.name = 'FlashlightCone';
    this.flashlightCone.position.set(0, 0.08, 0);
    this.flashlightCone.renderOrder = 8;
    this.flashlightCone.visible = this.flashlightEnabled;
    this.object.add(this.flashlightCone);

    this.updateFlashlightTarget();
  }

  private createAstronautDetails() {
    const suitMaterial = new THREE.MeshStandardMaterial({
      color: 0xe7edf6,
      roughness: 0.48,
      metalness: 0.24,
    });
    const jointMaterial = new THREE.MeshStandardMaterial({
      color: 0x6f7b88,
      roughness: 0.62,
      metalness: 0.28,
    });
    const packMaterial = new THREE.MeshStandardMaterial({
      color: 0x3b4652,
      roughness: 0.58,
      metalness: 0.36,
    });
    const visorMaterial = new THREE.MeshStandardMaterial({
      color: 0x66f6ff,
      emissive: 0x146f86,
      emissiveIntensity: 0.55,
      roughness: 0.28,
      metalness: 0.45,
    });

    const helmet = new THREE.Mesh(
      new THREE.SphereGeometry(0.36, 24, 16),
      suitMaterial,
    );
    helmet.position.set(0, 1.45, -0.02);
    helmet.scale.set(1, 0.9, 1);
    this.object.add(helmet);

    const visor = new THREE.Mesh(
      new THREE.BoxGeometry(0.44, 0.18, 0.08),
      visorMaterial,
    );
    visor.position.set(0, 1.45, -0.31);
    this.object.add(visor);

    const backpack = new THREE.Mesh(
      new THREE.BoxGeometry(0.54, 0.72, 0.22),
      packMaterial,
    );
    backpack.position.set(0, 0.93, 0.37);
    this.object.add(backpack);

    const chestPanel = new THREE.Mesh(
      new THREE.BoxGeometry(0.42, 0.26, 0.06),
      new THREE.MeshStandardMaterial({
        color: 0x2f9ab0,
        emissive: 0x0e4b5a,
        emissiveIntensity: 0.35,
        roughness: 0.4,
        metalness: 0.35,
      }),
    );
    chestPanel.position.set(0, 0.92, -0.36);
    this.object.add(chestPanel);

    for (const side of [-1, 1]) {
      const arm = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.09, 0.42, 6, 10),
        suitMaterial,
      );
      arm.position.set(side * 0.42, 0.92, -0.02);
      arm.rotation.z = side * 0.32;
      this.object.add(arm);

      const glove = new THREE.Mesh(
        new THREE.SphereGeometry(0.12, 12, 8),
        jointMaterial,
      );
      glove.position.set(side * 0.52, 0.64, -0.04);
      this.object.add(glove);

      const leg = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.11, 0.46, 6, 10),
        suitMaterial,
      );
      leg.position.set(side * 0.16, 0.31, 0.02);
      leg.rotation.z = side * 0.08;
      this.object.add(leg);

      const boot = new THREE.Mesh(
        new THREE.BoxGeometry(0.22, 0.12, 0.32),
        jointMaterial,
      );
      boot.position.set(side * 0.18, 0.08, -0.08);
      this.object.add(boot);
    }

    const oxygenHose = new THREE.Mesh(
      new THREE.TorusGeometry(0.31, 0.018, 8, 28, Math.PI * 1.25),
      jointMaterial,
    );
    oxygenHose.position.set(-0.28, 1.12, 0.16);
    oxygenHose.rotation.set(Math.PI / 2, 0.15, 0.75);
    this.object.add(oxygenHose);
  }

  update(deltaSeconds: number, lowGravity: boolean) {
    const movement = this.input.getMovement();

    if (!lowGravity && movement.lengthSq() === 0) {
      return;
    }

    if (lowGravity) {
      const targetVelocity = movement
        .clone()
        .multiplyScalar(PLAYER_SPEED * LOW_GRAVITY_SPEED_MULTIPLIER);
      this.velocity.lerp(targetVelocity, LOW_GRAVITY_STEERING);
      this.velocity.multiplyScalar(Math.pow(LOW_GRAVITY_DAMPING, deltaSeconds * 60));
    } else {
      this.velocity.copy(movement).multiplyScalar(PLAYER_SPEED);
    }

    const dx = this.velocity.x * deltaSeconds;
    const dz = this.velocity.y * deltaSeconds;

    this.tryMove(dx, 0);
    this.tryMove(0, dz);
    this.updateFlashlightConeLength();
  }

  get position() {
    return this.object.position;
  }

  get forward() {
    return this.heading;
  }

  isFlashlightEnabled() {
    return this.flashlightEnabled;
  }

  toggleFlashlight() {
    this.flashlightEnabled = !this.flashlightEnabled;
    this.flashlight.visible = this.flashlightEnabled;
    this.flashlightCone.visible = this.flashlightEnabled;
  }

  aimAt(target: THREE.Vector3) {
    const dx = target.x - this.object.position.x;
    const dz = target.z - this.object.position.z;

    if (dx * dx + dz * dz < 0.001) {
      return;
    }

    this.heading.set(dx, 0, dz).normalize();
    this.applyHeading();
  }

  private tryMove(dx: number, dz: number) {
    const nextX = this.object.position.x + dx;
    const nextZ = this.object.position.z + dz;

    if (this.stationMap.isWalkable(nextX, nextZ, PLAYER_RADIUS)) {
      this.object.position.x = nextX;
      this.object.position.z = nextZ;
    }
  }

  private applyHeading() {
    this.object.rotation.y = Math.atan2(-this.heading.x, -this.heading.z);
    this.updateFlashlightTarget();
    this.updateFlashlightConeLength();
  }

  private updateFlashlightTarget() {
    this.flashlightTarget.position.set(
      this.heading.x * FLASHLIGHT_RANGE,
      0.35,
      this.heading.z * FLASHLIGHT_RANGE,
    );
  }

  private updateFlashlightConeLength() {
    const origin = this.object.position
      .clone()
      .add(new THREE.Vector3(0, 1.05, 0))
      .addScaledVector(this.heading, 0.42);
    this.flashlightRaycaster.set(origin, this.heading);
    this.flashlightRaycaster.far = FLASHLIGHT_CONE_LENGTH;

    const hit = this.flashlightRaycaster.intersectObject(this.stationMap.group, true)[0];
    const length = Math.max(
      FLASHLIGHT_CONE_NEAR_OFFSET,
      Math.min(hit?.distance ?? FLASHLIGHT_CONE_LENGTH, FLASHLIGHT_CONE_LENGTH),
    );

    this.setFlashlightConeLength(length);
  }

  private setFlashlightConeLength(length: number) {
    if (Math.abs(length - this.currentFlashlightConeLength) < 0.03) {
      return;
    }

    this.currentFlashlightConeLength = length;
    this.flashlightCone.geometry.dispose();
    this.flashlightCone.geometry = createFlashlightConeGeometry(length);
  }
}

import * as THREE from 'three';
import { InputManager } from './InputManager';

export type GravityUiState = {
  lowGravity: boolean;
  prompt: string;
  status: string;
  repairProgress: number;
  normalGravitySeconds: number;
};

const NORMAL_GRAVITY_SECONDS = 10;
const REPAIR_SECONDS = 2.0;
const CONTROLLER_RADIUS = 1.8;

export class GravitySystem {
  readonly group = new THREE.Group();
  readonly controller: THREE.Group;

  private normalGravityRemaining = 0;
  private repairProgress = 0;
  private lowGravity = true;
  private prompt = '';
  private status = 'Zero gravity active';

  constructor() {
    this.group.name = 'GravitySystem';
    this.controller = this.createController();
    this.controller.position.set(0, 0, 0);
    this.group.add(this.controller);
  }

  update(deltaSeconds: number, playerPosition: THREE.Vector3, input: InputManager) {
    let gravityRestored = false;
    this.prompt = '';

    if (this.lowGravity) {
      const distance = playerPosition.distanceTo(this.controller.position);
      if (distance <= CONTROLLER_RADIUS) {
        this.prompt = 'Hold E to activate gravity for 10 seconds';

        if (input.isActionPressed()) {
          this.repairProgress = Math.min(this.repairProgress + deltaSeconds, REPAIR_SECONDS);

          if (this.repairProgress >= REPAIR_SECONDS) {
            this.activateGravityWindow();
            gravityRestored = true;
          }
        }
      } else {
        this.repairProgress = Math.max(0, this.repairProgress - deltaSeconds * 0.5);
      }
      this.status = 'Zero gravity active · repair controller for temporary gravity';
    } else {
      this.normalGravityRemaining = Math.max(0, this.normalGravityRemaining - deltaSeconds);
      this.status = `Gravity active · ${this.normalGravityRemaining.toFixed(0)}s remaining`;
      this.repairProgress = 0;

      if (this.normalGravityRemaining <= 0) {
        this.lowGravity = true;
        this.status = 'Zero gravity resumed';
      }
    }

    this.updateVisualState();
    return gravityRestored;
  }

  getUiState(): GravityUiState {
    return {
      lowGravity: this.lowGravity,
      prompt: this.prompt,
      status: this.status,
      repairProgress: this.repairProgress / REPAIR_SECONDS,
      normalGravitySeconds: this.normalGravityRemaining,
    };
  }

  isLowGravity() {
    return this.lowGravity;
  }

  private activateGravityWindow() {
    this.lowGravity = false;
    this.normalGravityRemaining = NORMAL_GRAVITY_SECONDS;
    this.repairProgress = 0;
    this.status = `Gravity active · ${NORMAL_GRAVITY_SECONDS}s remaining`;
  }

  private updateVisualState() {
    const panel = this.controller.getObjectByName('GravityPanel') as
      | THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>
      | undefined;

    if (!panel) return;

    if (this.lowGravity) {
      panel.material.emissive.setHex(0xff3355);
      panel.material.emissiveIntensity = 1.3;
    } else {
      panel.material.emissive.setHex(0x2d8cff);
      panel.material.emissiveIntensity = 0.65;
    }
  }

  private createController() {
    const group = new THREE.Group();
    group.name = 'GravityController';

    const base = new THREE.Mesh(
      new THREE.BoxGeometry(1.3, 1.1, 1.3),
      new THREE.MeshStandardMaterial({
        color: 0x33404c,
        roughness: 0.54,
        metalness: 0.35,
      }),
    );
    base.position.y = 0.55;
    group.add(base);

    const panel = new THREE.Mesh(
      new THREE.BoxGeometry(0.92, 0.12, 0.72),
      new THREE.MeshStandardMaterial({
        color: 0x75bdff,
        emissive: 0x2d8cff,
        emissiveIntensity: 0.65,
      }),
    );
    panel.name = 'GravityPanel';
    panel.position.set(0, 1.12, -0.28);
    group.add(panel);

    const light = new THREE.PointLight(0x2d8cff, 5, 6, 1.8);
    light.position.set(0, 1.5, 0);
    group.add(light);

    return group;
  }
}

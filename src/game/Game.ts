import * as THREE from 'three';
import { InputManager } from './InputManager';
import { GameStatus } from './GameState';
import { GravitySystem } from './GravitySystem';
import { ObjectiveManager } from './ObjectiveManager';
import { PlayerController } from './PlayerController';
import { StationMap } from './StationMap';
import { LumenAttractionTarget, LumenController } from '../ai/LumenController';
import { DDGIManager, DirectLightSample } from '../gi/DDGIManager';
import { TopDownCamera } from '../rendering/TopDownCamera';

const NEON_BALL_LIFETIME_SECONDS = 5;
const DIRECT_LIGHT_DEBUG_RADIAL_RAYS = 12;
const DIRECT_LIGHT_DEBUG_SPOT_RAYS = 31;
const INDIRECT_DEBUG_MAX_MARKERS = 72;
const INDIRECT_DEBUG_ARROW_COLOR = new THREE.Color(0xff43ff);
const MISSION_PROMPT_ANIMATION_MS = 7400;

export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly clock = new THREE.Clock();
  private readonly input: InputManager;
  private readonly stationMap = new StationMap();
  private readonly player: PlayerController;
  private readonly objectives = new ObjectiveManager();
  private readonly lumens = new LumenController();
  private readonly ddgi = new DDGIManager();
  private readonly gravitySystem = new GravitySystem();
  private readonly topDownCamera: TopDownCamera;
  private readonly hud: HTMLDivElement;
  private readonly missionPrompt: HTMLDivElement;
  private readonly itemSlots: HTMLDivElement;
  private readonly touchControls: HTMLDivElement;
  private readonly touchControlDisposers: Array<() => void> = [];
  private readonly aimPoint = new THREE.Vector3();
  private readonly visibilityRaycaster = new THREE.Raycaster();
  private readonly directLightDebugGroup = new THREE.Group();
  private readonly ambientLight = new THREE.AmbientLight(0x102033, 0.025);
  private readonly overheadLight = new THREE.DirectionalLight(0xa9c7ff, 0.08);
  private raycastTargets: THREE.Object3D[] = [];
  private lightDebugRaycastTargets: THREE.Object3D[] = [];
  private readonly neonBalls: Array<{
    group: THREE.Group;
    velocity: THREE.Vector3;
    age: number;
    active: boolean;
  }> = [];

  private gameStatus: GameStatus = 'playing';
  private neonBallsRemaining = 3;
  private animationFrameId = 0;
  private ddgiDebugEnabled = false;
  private directLightDebugEnabled = false;
  private brightnessDebugEnabled = false;
  private visibilityUpdateFrame = 0;
  private previousRepairedGenerators = 0;
  private missionPromptPlaying = false;
  private missionPromptTimeout = 0;
  private neonSlotFlashTimeout = 0;
  private readonly missionPromptQueue: string[] = [];

  constructor(private readonly app: HTMLDivElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor(0x03050a);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.app.appendChild(this.renderer.domElement);

    this.scene.fog = new THREE.FogExp2(0x03050a, 0.035);
    this.topDownCamera = new TopDownCamera(window.innerWidth, window.innerHeight);
    this.input = new InputManager(this.renderer.domElement);
    this.player = new PlayerController(this.input, this.stationMap);
    this.hud = this.createHud();
    this.missionPrompt = this.createMissionPrompt();
    this.itemSlots = this.createItemSlots();
    this.touchControls = this.createTouchControls();

    this.setupScene();
    this.raycastTargets = [
      this.stationMap.group,
      ...this.objectives.getRaycastTargets(),
      this.gravitySystem.group,
    ];
    this.lightDebugRaycastTargets = [this.stationMap.group, this.gravitySystem.group];
    requestAnimationFrame(() => {
      this.enqueueMissionPrompt('Repair Generators in this space station.');
    });
    window.addEventListener('resize', this.resize);
  }

  start() {
    this.clock.start();
    this.animate();
  }

  dispose() {
    cancelAnimationFrame(this.animationFrameId);
    window.removeEventListener('resize', this.resize);
    this.input.dispose();
    this.renderer.dispose();
    this.hud.remove();
    this.missionPrompt.remove();
    this.itemSlots.remove();
    this.touchControls.remove();
    for (const disposeTouchControl of this.touchControlDisposers) {
      disposeTouchControl();
    }
    window.clearTimeout(this.missionPromptTimeout);
    window.clearTimeout(this.neonSlotFlashTimeout);
  }

  private setupScene() {
    this.scene.add(this.ambientLight);

    this.overheadLight.position.set(-5, 12, -6);
    this.scene.add(this.overheadLight);

    this.scene.add(this.stationMap.group);
    this.scene.add(this.player.object);
    this.scene.add(this.objectives.group);
    this.scene.add(this.lumens.group);
    this.scene.add(this.ddgi.group);
    this.scene.add(this.gravitySystem.group);
    this.scene.add(this.directLightDebugGroup);
  }

  private animate = () => {
    const deltaSeconds = Math.min(this.clock.getDelta(), 0.05);
    const elapsed = this.clock.elapsedTime;

    if (this.input.isRestartPressed() && this.gameStatus !== 'playing') {
      window.location.reload();
      return;
    }

    if (this.gameStatus === 'playing') {
      this.topDownCamera.screenToGround(this.input.getPointerNdc(), this.aimPoint);
      this.player.aimAt(this.aimPoint);
      if (this.input.consumeFlashlightTogglePressed()) {
        this.player.toggleFlashlight();
      }
      if (this.input.consumeDirectLightDebugPressed()) {
        this.directLightDebugEnabled = !this.directLightDebugEnabled;
        if (!this.directLightDebugEnabled) {
          this.clearDirectLightDebug();
        }
      }
      if (this.input.consumeBrightnessDebugPressed()) {
        this.brightnessDebugEnabled = !this.brightnessDebugEnabled;
        this.updateBrightnessDebugLights();
      }
      this.player.update(deltaSeconds, this.gravitySystem.isLowGravity());
      this.handleNeonThrow();
    }

    if (this.input.consumeDdgiDebugPressed()) {
      this.ddgiDebugEnabled = !this.ddgiDebugEnabled;
      this.ddgi.toggleDebug();
    }

    const previousGameStatus = this.gameStatus;
    const objectiveStatus = this.objectives.update(
      deltaSeconds,
      this.player.position,
      this.input,
      this.gameStatus,
    );
    this.gameStatus = objectiveStatus;
    this.handleObjectiveAnnouncements();
    this.handleGameStatusAnnouncements(previousGameStatus);
    const gravityRestored = this.gravitySystem.update(deltaSeconds, this.player.position, this.input);
    if (gravityRestored) {
      this.enqueueMissionPrompt('Gravity restored');
    }
    const floatingObjectSamples = this.ddgi.getFloatingObjectSamples();

    if (
      this.gameStatus === 'playing' &&
      this.lumens.update(
        deltaSeconds,
        elapsed,
        this.player.position,
        (lumen) => this.collectVisibleLumenLightTargets(lumen),
        (lumen) => this.findStrongestProbeRayTargetingLumen(lumen, floatingObjectSamples),
        (x, z, radius) => this.stationMap.isWalkable(x, z, radius),
      )
    ) {
      this.gameStatus = 'gameOver';
    }

    this.topDownCamera.update(this.player.position);
    this.updateNeonBalls(deltaSeconds);
    this.stationMap.updateLowGravityProps(this.gravitySystem.isLowGravity(), elapsed);
    this.ddgi.updateFloatingObjectMotion(this.gravitySystem.isLowGravity(), elapsed);
    const directLights = this.collectDirectLights();
    this.ddgi.update(directLights, this.collectDdgiRaycastTargets());
    this.updateDirectLightDebug(directLights);
    this.objectives.updateGeneratorLightPrompts(
      this.collectFlashlightDirectLight(),
      this.collectLightDebugRaycastTargets(),
    );
    this.visibilityUpdateFrame = (this.visibilityUpdateFrame + 1) % 2;
    if (this.visibilityUpdateFrame === 0 || this.brightnessDebugEnabled) {
      this.stationMap.updateLightingVisibility(
        (position) => this.ddgi.sampleIrradiance(position, new THREE.Vector3(0, 1, 0)),
        directLights,
        this.player.position,
        this.brightnessDebugEnabled,
      );
      this.objectives.updateLightingVisibility(
        (position) => this.ddgi.sampleIrradiance(position, new THREE.Vector3(0, 1, 0)),
        directLights,
        this.player.position,
        this.collectLightDebugRaycastTargets(),
        this.brightnessDebugEnabled,
      );
    }
    this.ddgi.updateFloatingObjectVisibility(
      (position) => this.ddgi.sampleIrradiance(position, new THREE.Vector3(0, 1, 0)),
      directLights,
      this.player.position,
      this.collectRaycastTargets(),
      this.brightnessDebugEnabled,
    );
    this.updateHud();

    this.renderer.render(this.scene, this.topDownCamera.camera);
    this.animationFrameId = requestAnimationFrame(this.animate);
  };

  private updateBrightnessDebugLights() {
    this.ambientLight.intensity = this.brightnessDebugEnabled ? 0.42 : 0.025;
    this.overheadLight.intensity = this.brightnessDebugEnabled ? 0.7 : 0.08;
  }

  private updateHud() {
    const objectiveState = this.objectives.getUiState();
    const gravityState = this.gravitySystem.getUiState();

    this.hud.querySelector('[data-generators-left]')!.textContent =
      `Generators left ${objectiveState.totalGenerators - objectiveState.repairedGenerators}`;
    this.hud.querySelector('[data-flashlight]')!.textContent =
      `Flashlight ${this.player.isFlashlightEnabled() ? 'on' : 'off'}`;
    this.hud.querySelector('[data-neon]')!.textContent =
      `Q Throw neon ${this.neonBallsRemaining}/3`;
    this.hud.querySelector('[data-gravity]')!.textContent = gravityState.lowGravity
      ? 'Gravity zero'
      : `Gravity normal ${gravityState.normalGravitySeconds.toFixed(0)}s`;
    this.hud.querySelector('[data-direct-light-debug]')!.textContent =
      `R Rays ${this.directLightDebugEnabled ? 'on' : 'off'}`;
    this.hud.querySelector('[data-brightness]')!.textContent =
      `B Bright map ${this.brightnessDebugEnabled ? 'on' : 'off'}`;
    this.hud.querySelector('[data-probes]')!.textContent =
      `P Probes ${this.ddgiDebugEnabled ? 'on' : 'off'}`;
    this.updateItemSlots();

    const progress = this.hud.querySelector<HTMLDivElement>('[data-progress]');
    if (progress) {
      progress.style.transform = `scaleX(${Math.max(
        objectiveState.repairProgress,
        gravityState.repairProgress,
      )})`;
    }
  }

  private resize = () => {
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.topDownCamera.resize(window.innerWidth, window.innerHeight);
  };

  private createHud() {
    const hud = document.createElement('div');
    hud.className = 'hud';
    hud.innerHTML = `
      <strong>Residual Light</strong>
      <span>WASD Move</span>
      <span data-flashlight>Flashlight on</span>
      <span data-neon>Q Throw neon 3/3</span>
      <span data-generators-left>Generators left 6</span>
      <span data-gravity>Gravity zero</span>
      <span data-direct-light-debug>R Rays off</span>
      <span data-brightness>B Bright map off</span>
      <span data-probes>P Probes off</span>
      <div class="progress-track"><div class="progress-fill" data-progress></div></div>
    `;
    this.app.appendChild(hud);
    return hud;
  }

  private createMissionPrompt() {
    const prompt = document.createElement('div');
    prompt.className = 'mission-prompt';
    this.app.appendChild(prompt);
    return prompt;
  }

  private createItemSlots() {
    const slots = document.createElement('div');
    slots.className = 'item-slots';
    slots.innerHTML = `
      <div class="item-slot" data-flashlight-slot>
        <span class="item-slot-icon">FLASH</span>
        <span class="item-slot-key">Left click</span>
      </div>
      <div class="item-slot" data-neon-slot>
        <span class="item-slot-count" data-neon-slot-count>3/3</span>
        <span class="item-slot-icon">NEON</span>
        <span class="item-slot-key">Q</span>
      </div>
    `;
    this.app.appendChild(slots);
    return slots;
  }

  private createTouchControls() {
    const controls = document.createElement('div');
    controls.className = 'touch-controls';
    controls.innerHTML = `
      <div class="touch-dpad" aria-label="Movement controls">
        <button class="touch-button touch-up" type="button" data-move="up" aria-label="Move up">U</button>
        <button class="touch-button touch-left" type="button" data-move="left" aria-label="Move left">L</button>
        <button class="touch-button touch-right" type="button" data-move="right" aria-label="Move right">R</button>
        <button class="touch-button touch-down" type="button" data-move="down" aria-label="Move down">D</button>
      </div>
      <div class="touch-actions" aria-label="Action controls">
        <button class="touch-button" type="button" data-action="use" aria-label="Use">E</button>
        <button class="touch-button" type="button" data-action="flashlight" aria-label="Toggle flashlight">LIGHT</button>
        <button class="touch-button" type="button" data-action="throw" aria-label="Throw neon">NEON</button>
        <button class="touch-button" type="button" data-action="restart" aria-label="Restart">R</button>
      </div>
    `;
    this.app.appendChild(controls);

    const pressedDirections = new Set<string>();
    const updateMovement = () => {
      const x = Number(pressedDirections.has('right')) - Number(pressedDirections.has('left'));
      const y = Number(pressedDirections.has('down')) - Number(pressedDirections.has('up'));
      this.input.setVirtualMovement(x, y);
    };

    const bindPress = (
      button: HTMLButtonElement,
      onPress: () => void,
      onRelease?: () => void,
    ) => {
      const releaseOnLostCapture = () => {
        onRelease?.();
      };
      const press = (event: PointerEvent) => {
        event.preventDefault();
        button.setPointerCapture(event.pointerId);
        onPress();
      };
      const release = (event: PointerEvent) => {
        event.preventDefault();
        if (button.hasPointerCapture(event.pointerId)) {
          button.releasePointerCapture(event.pointerId);
        }
        onRelease?.();
      };

      button.addEventListener('pointerdown', press);
      button.addEventListener('pointerup', release);
      button.addEventListener('pointercancel', release);
      button.addEventListener('lostpointercapture', releaseOnLostCapture);
      this.touchControlDisposers.push(() => {
        button.removeEventListener('pointerdown', press);
        button.removeEventListener('pointerup', release);
        button.removeEventListener('pointercancel', release);
        button.removeEventListener('lostpointercapture', releaseOnLostCapture);
      });
    };

    for (const button of controls.querySelectorAll<HTMLButtonElement>('[data-move]')) {
      const direction = button.dataset.move;
      if (!direction) continue;
      bindPress(
        button,
        () => {
          pressedDirections.add(direction);
          updateMovement();
        },
        () => {
          pressedDirections.delete(direction);
          updateMovement();
        },
      );
    }

    for (const button of controls.querySelectorAll<HTMLButtonElement>('[data-action]')) {
      const action = button.dataset.action;
      if (action === 'use') {
        bindPress(
          button,
          () => this.input.setVirtualActionPressed(true),
          () => this.input.setVirtualActionPressed(false),
        );
      } else if (action === 'restart') {
        bindPress(
          button,
          () => this.input.setVirtualRestartPressed(true),
          () => this.input.setVirtualRestartPressed(false),
        );
      } else if (action === 'flashlight') {
        bindPress(button, () => this.input.requestFlashlightToggle());
      } else if (action === 'throw') {
        bindPress(button, () => this.input.requestThrow());
      }
    }

    return controls;
  }

  private updateItemSlots() {
    const flashlightSlot = this.itemSlots.querySelector('[data-flashlight-slot]');
    flashlightSlot?.classList.toggle('item-slot-active', this.player.isFlashlightEnabled());

    const neonCount = this.itemSlots.querySelector('[data-neon-slot-count]');
    if (neonCount) {
      neonCount.textContent = `${this.neonBallsRemaining}/3`;
    }
  }

  private flashNeonSlot() {
    const neonSlot = this.itemSlots.querySelector('[data-neon-slot]');
    if (!neonSlot) return;

    neonSlot.classList.add('item-slot-active');
    window.clearTimeout(this.neonSlotFlashTimeout);
    this.neonSlotFlashTimeout = window.setTimeout(() => {
      neonSlot.classList.remove('item-slot-active');
    }, 260);
  }

  private handleObjectiveAnnouncements() {
    const objectiveState = this.objectives.getUiState();

    if (objectiveState.repairedGenerators <= this.previousRepairedGenerators) {
      return;
    }

    for (
      let repaired = this.previousRepairedGenerators + 1;
      repaired <= objectiveState.repairedGenerators;
      repaired += 1
    ) {
      this.enqueueMissionPrompt(
        `Generator restored ${repaired}/${objectiveState.totalGenerators}`,
      );
    }

    if (objectiveState.repairedGenerators === objectiveState.totalGenerators) {
      this.enqueueMissionPrompt('Go to report power restoration!');
    }

    this.previousRepairedGenerators = objectiveState.repairedGenerators;
  }

  private handleGameStatusAnnouncements(previousGameStatus: GameStatus) {
    if (previousGameStatus !== 'victory' && this.gameStatus === 'victory') {
      this.enqueueMissionPrompt('MISSION COMPLETE');
    }
  }

  private enqueueMissionPrompt(message: string) {
    this.missionPromptQueue.push(message);
    this.playNextMissionPrompt();
  }

  private playNextMissionPrompt() {
    if (this.missionPromptPlaying) return;

    const nextMessage = this.missionPromptQueue.shift();
    if (!nextMessage) return;

    this.missionPromptPlaying = true;
    this.missionPrompt.textContent = nextMessage;
    this.missionPrompt.classList.remove('mission-prompt-active');
    this.missionPrompt.style.opacity = '0';
    void this.missionPrompt.offsetWidth;
    this.missionPrompt.style.opacity = '';
    this.missionPrompt.classList.add('mission-prompt-active');

    this.missionPromptTimeout = window.setTimeout(() => {
      this.missionPrompt.classList.remove('mission-prompt-active');
      this.missionPromptPlaying = false;
      this.playNextMissionPrompt();
    }, MISSION_PROMPT_ANIMATION_MS);
  }

  private createNeonBall() {
    const group = new THREE.Group();
    group.name = 'M1NeonBall';

    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(0.35, 32, 16),
      new THREE.MeshStandardMaterial({
        color: 0x66f6ff,
        emissive: 0x1be8ff,
        emissiveIntensity: 1.8,
      }),
    );
    sphere.position.y = 0.42;
    group.add(sphere);

    const light = new THREE.PointLight(0x66f6ff, 18, 9, 1.7);
    light.name = 'M1NeonLight';
    light.position.set(0, 0.42, 0);
    group.add(light);

    return group;
  }

  private handleNeonThrow() {
    if (!this.input.consumeThrowPressed() || this.neonBallsRemaining <= 0) {
      return;
    }

    const group = this.createNeonBall();
    group.name = 'ThrownNeonBall';
    group.position.copy(this.player.position);
    group.position.y = 0;
    group.position.addScaledVector(this.player.forward, 0.85);

    const velocity = this.player.forward.clone().multiplyScalar(9.2);
    velocity.y = 0;

    this.neonBalls.push({ group, velocity, age: 0, active: true });
    this.neonBallsRemaining -= 1;
    this.scene.add(group);
    this.flashNeonSlot();
  }

  private updateNeonBalls(deltaSeconds: number) {
    for (let index = this.neonBalls.length - 1; index >= 0; index -= 1) {
      const neonBall = this.neonBalls[index];
      neonBall.age += deltaSeconds;

      if (neonBall.age >= NEON_BALL_LIFETIME_SECONDS) {
        this.scene.remove(neonBall.group);
        this.neonBalls.splice(index, 1);
        continue;
      }

      if (neonBall.active) {
        const nextX = neonBall.group.position.x + neonBall.velocity.x * deltaSeconds;
        const nextZ = neonBall.group.position.z + neonBall.velocity.z * deltaSeconds;

        if (this.stationMap.isWalkable(nextX, nextZ, 0.32)) {
          neonBall.group.position.x = nextX;
          neonBall.group.position.z = nextZ;
          neonBall.velocity.multiplyScalar(Math.pow(0.18, deltaSeconds));

          if (neonBall.velocity.lengthSq() < 0.08) {
            neonBall.active = false;
          }
        } else {
          neonBall.active = false;
          neonBall.velocity.set(0, 0, 0);
        }
      }

      const hover = neonBall.active ? 0.22 : 0.08;
      neonBall.group.position.y = 0.45 + Math.sin(neonBall.age * 8) * hover;
    }
  }

  private collectDirectLights(): DirectLightSample[] {
    const samples: DirectLightSample[] = [
      ...this.objectives.getDirectLightSamples(),
      this.collectFlashlightDirectLight(),
    ];

    for (const neonBall of this.neonBalls) {
      samples.push({
        position: neonBall.group.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.55, 0)),
        color: new THREE.Color(0x66f6ff),
        intensity: neonBall.active ? 18 : 12,
        radius: 10,
      });
    }

    return samples;
  }

  private collectFlashlightDirectLight(): DirectLightSample {
    return {
      position: this.player.flashlight.getWorldPosition(new THREE.Vector3()),
      color: new THREE.Color(0xdcecff),
      intensity: this.player.isFlashlightEnabled() ? this.player.flashlight.intensity : 0,
      radius: this.player.flashlight.distance,
      direction: this.player.forward.clone(),
      spotCosine: Math.cos(this.player.flashlight.angle),
    };
  }

  private collectRaycastTargets() {
    return this.raycastTargets;
  }

  private collectDdgiRaycastTargets() {
    return [
      ...this.raycastTargets,
      ...this.ddgi.getRaycastTargets(),
    ];
  }

  private collectLightDebugRaycastTargets() {
    return this.lightDebugRaycastTargets;
  }

  private updateDirectLightDebug(lightSamples: DirectLightSample[]) {
    if (!this.directLightDebugEnabled) {
      return;
    }

    this.clearDirectLightDebug();

    for (const light of lightSamples) {
      if (light.intensity <= 0) continue;

      if (light.direction) {
        this.addSpotLightDebugRays(light);
        continue;
      }

      for (let index = 0; index < DIRECT_LIGHT_DEBUG_RADIAL_RAYS; index += 1) {
        const angle = (index / DIRECT_LIGHT_DEBUG_RADIAL_RAYS) * Math.PI * 2;
        const direction = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
        this.addDirectLightDebugRay(light.position, direction, light.radius, light.color);
      }
    }

    this.addIndirectLightingDebug();
  }

  private addSpotLightDebugRays(light: DirectLightSample) {
    if (!light.direction || light.spotCosine === undefined) return;

    const halfAngle = Math.acos(light.spotCosine);
    const centerAngle = Math.atan2(light.direction.z, light.direction.x);
    const rayCount = Math.max(DIRECT_LIGHT_DEBUG_SPOT_RAYS, 3);

    for (let index = 0; index < rayCount; index += 1) {
      const t = rayCount === 1 ? 0.5 : index / (rayCount - 1);
      const angleOffset = THREE.MathUtils.lerp(-halfAngle, halfAngle, t);
      const angle = centerAngle + angleOffset;
      const direction = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
      this.addDirectLightDebugRay(light.position, direction, light.radius, light.color);
    }
  }

  private addDirectLightDebugRay(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    radius: number,
    color: THREE.Color,
  ) {
    const normalizedDirection = direction.clone().normalize();
    const rayOrigin = origin.clone().addScaledVector(normalizedDirection, 0.08);
    this.visibilityRaycaster.set(rayOrigin, normalizedDirection);
    this.visibilityRaycaster.far = radius;

    const hit = this.visibilityRaycaster.intersectObjects(
      this.collectLightDebugRaycastTargets(),
      true,
    )[0];
    const length = Math.min(hit?.distance ?? radius, radius);
    const end = rayOrigin.clone().addScaledVector(normalizedDirection, length);
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([rayOrigin, end]),
      new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: 0.72,
        depthTest: false,
      }),
    );
    line.renderOrder = 18;
    this.directLightDebugGroup.add(line);
  }

  private addIndirectLightingDebug() {
    const samples = this.ddgi
      .getFloatingObjectSamples()
      .sort((a, b) => b.intensity - a.intensity)
      .slice(0, INDIRECT_DEBUG_MAX_MARKERS);

    for (const sample of samples) {
      if (sample.intensity <= 0.0001) continue;

      const color = INDIRECT_DEBUG_ARROW_COLOR.clone().lerp(
        new THREE.Color(
          THREE.MathUtils.clamp(sample.irradiance.x * 0.9, 0.08, 1),
          THREE.MathUtils.clamp(sample.irradiance.y * 0.9, 0.08, 1),
          THREE.MathUtils.clamp(sample.irradiance.z * 0.9, 0.08, 1),
        ),
        0.35,
      );
      const length = THREE.MathUtils.clamp(sample.intensity * 2.4, 0.8, 3.8);
      const start = sample.position.clone();
      const end = start.clone().addScaledVector(sample.direction, length);
      const arrow = this.createDebugArrow(start, end, color, 0.045);
      this.directLightDebugGroup.add(arrow);

      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(THREE.MathUtils.clamp(sample.intensity * 0.14, 0.13, 0.34), 10, 8),
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.95,
          depthTest: false,
        }),
      );
      marker.position.copy(end);
      marker.renderOrder = 20;
      this.directLightDebugGroup.add(marker);
    }
  }

  private findStrongestProbeRayTargetingLumen(
    lumen: THREE.Group,
    floatingObjectSamples: ReturnType<DDGIManager['getFloatingObjectSamples']>,
  ) {
    let bestProbe: {
      position: THREE.Vector3;
      score: number;
      indirect: number;
      direct: number;
    } | null = null;

    for (const sample of floatingObjectSamples) {
      if (sample.intensity <= 0.0001) continue;

      const targetDistance = sample.position.distanceTo(this.getLumenAimPoint(lumen));
      const rayLength = Math.max(targetDistance + 0.5, 1);
      if (!this.doesRayHitLumenFirst(sample.position, sample.direction, rayLength, lumen)) {
        continue;
      }

      const score = Math.max(sample.intensity, 0.5);
      if (!bestProbe || score > bestProbe.score) {
        bestProbe = {
          position: sample.position.clone(),
          score,
          indirect: sample.intensity,
          direct: 0,
        };
      }
    }

    return bestProbe;
  }

  private createDebugArrow(start: THREE.Vector3, end: THREE.Vector3, color: THREE.Color, radius: number) {
    const direction = end.clone().sub(start);
    const length = direction.length();
    const group = new THREE.Group();
    group.renderOrder = 20;

    if (length < 0.001) {
      return group;
    }

    const shaftLength = Math.max(length - 0.22, 0.05);
    const midpoint = start.clone().addScaledVector(direction, 0.5 * (shaftLength / length));
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.92,
      depthTest: false,
    });
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius, shaftLength, 8),
      material,
    );
    shaft.position.copy(midpoint);
    shaft.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.clone().normalize());
    shaft.renderOrder = 20;
    group.add(shaft);

    const head = new THREE.Mesh(
      new THREE.ConeGeometry(radius * 2.8, 0.34, 10),
      material.clone(),
    );
    head.position.copy(end);
    head.quaternion.copy(shaft.quaternion);
    head.renderOrder = 21;
    group.add(head);

    return group;
  }

  private clearDirectLightDebug() {
    this.directLightDebugGroup.traverse((child) => {
      const object = child as THREE.Mesh<THREE.BufferGeometry, THREE.Material> | THREE.Line<
        THREE.BufferGeometry,
        THREE.LineBasicMaterial
      >;
      object.geometry?.dispose();

      if (Array.isArray(object.material)) {
        object.material.forEach((material) => material.dispose());
      } else {
        object.material?.dispose();
      }
    });

    this.directLightDebugGroup.clear();
  }

  private computeLightRecognitionScore(lumen: THREE.Group, light: DirectLightSample) {
    if (light.intensity <= 0) {
      return 0;
    }

    if (light.direction && light.spotCosine !== undefined) {
      const hitScore = this.getSpotLightLumenHitScore(lumen, light);
      if (hitScore <= 0) {
        return 0;
      }

      return light.intensity * hitScore;
    }

    if (!this.doesRayHitLumenFirst(light.position, this.getLumenAimPoint(lumen), light.radius, lumen)) {
      return 0;
    }

    return light.intensity;
  }

  private collectVisibleLumenLightTargets(lumen: THREE.Group): LumenAttractionTarget[] {
    const observer = this.getLumenAimPoint(lumen);
    const targets: Array<{
      label: LumenAttractionTarget['label'];
      position: THREE.Vector3;
      light: DirectLightSample;
    }> = [];

    const flashlightSample: DirectLightSample = {
      position: this.player.flashlight.getWorldPosition(new THREE.Vector3()),
      color: new THREE.Color(0xdcecff),
      intensity: this.player.isFlashlightEnabled() ? this.player.flashlight.intensity : 0,
      radius: this.player.flashlight.distance,
      direction: this.player.forward.clone(),
      spotCosine: Math.cos(this.player.flashlight.angle),
    };

    targets.push({
      label: 'isaac',
      position: this.player.position.clone(),
      light: flashlightSample,
    });

    for (const objectiveTarget of this.objectives.getAttractionTargets()) {
      targets.push({
        label: objectiveTarget.label,
        position: objectiveTarget.position.clone(),
        light: {
          position: objectiveTarget.position.clone(),
          color: new THREE.Color(0xff4f8b),
          intensity: 3,
          radius: 6,
        },
      });
    }

    for (const neonBall of this.neonBalls) {
      const position = neonBall.group
        .getWorldPosition(new THREE.Vector3())
        .add(new THREE.Vector3(0, 0.55, 0));
      targets.push({
        label: 'neon',
        position,
        light: {
          position: position.clone(),
          color: new THREE.Color(0x66f6ff),
          intensity: neonBall.active ? 18 : 12,
          radius: 10,
        },
      });
    }

    return targets.flatMap((target) => {
      const directAtObserver = this.computeLightRecognitionScore(lumen, target.light);
      if (directAtObserver <= 0) {
        return [];
      }

      const indirect = this.ddgi
        .sampleIrradiance(observer, new THREE.Vector3(0, 1, 0))
        .length();
      return [{
        label: target.label,
        position: target.position,
        indirect,
        direct: directAtObserver,
        score: indirect * 1.0 + directAtObserver * 0.7,
      }];
    });
  }

  private getSpotLightLumenHitScore(lumen: THREE.Group, light: DirectLightSample) {
    if (!light.direction || light.spotCosine === undefined) return 0;

    const halfAngle = Math.acos(light.spotCosine);
    const centerAngle = Math.atan2(light.direction.z, light.direction.x);
    let bestScore = 0;

    for (let index = 0; index < DIRECT_LIGHT_DEBUG_SPOT_RAYS; index += 1) {
      const t = index / (DIRECT_LIGHT_DEBUG_SPOT_RAYS - 1);
      const angleOffset = THREE.MathUtils.lerp(-halfAngle, halfAngle, t);
      const direction = new THREE.Vector3(
        Math.cos(centerAngle + angleOffset),
        0,
        Math.sin(centerAngle + angleOffset),
      );

      if (this.doesRayHitLumenFirst(light.position, direction, light.radius, lumen)) {
        const normalizedOffset = halfAngle > 0 ? Math.abs(angleOffset) / halfAngle : 0;
        bestScore = Math.max(bestScore, THREE.MathUtils.lerp(1, 0.25, normalizedOffset));
      }
    }

    return bestScore;
  }

  private doesRayHitLumenFirst(
    origin: THREE.Vector3,
    directionOrTarget: THREE.Vector3,
    radius: number,
    lumen: THREE.Group,
  ) {
    const direction = directionOrTarget.clone();
    let maxDistance = radius;

    if (direction.length() > 1.01) {
      direction.sub(origin);
      maxDistance = Math.min(direction.length(), radius);
    }

    if (direction.lengthSq() < 0.001) {
      return false;
    }

    direction.normalize();
    const rayOrigin = origin.clone().addScaledVector(direction, 0.08);
    this.visibilityRaycaster.set(rayOrigin, direction);
    this.visibilityRaycaster.far = maxDistance;

    const hits = this.visibilityRaycaster.intersectObjects(
      [...this.collectLightDebugRaycastTargets(), lumen],
      true,
    );
    const firstHit = hits[0];
    return !!firstHit && this.isDescendantOf(firstHit.object, lumen);
  }

  private getLumenAimPoint(lumen: THREE.Group) {
    return lumen.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.7, 0));
  }

  private isDescendantOf(object: THREE.Object3D, parent: THREE.Object3D) {
    let current: THREE.Object3D | null = object;

    while (current) {
      if (current === parent) return true;
      current = current.parent;
    }

    return false;
  }

}

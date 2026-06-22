import * as THREE from 'three';

export class InputManager {
  private readonly pressedKeys = new Set<string>();
  private readonly moveVector = new THREE.Vector2();
  private readonly virtualMoveVector = new THREE.Vector2();
  private readonly pointerNdc = new THREE.Vector2();
  private throwRequested = false;
  private flashlightToggleRequested = false;
  private virtualActionPressed = false;
  private virtualRestartPressed = false;
  private ddgiDebugRequested = false;
  private directLightDebugRequested = false;
  private brightnessDebugRequested = false;

  constructor(private readonly element: HTMLElement) {
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', this.clear);
    this.element.addEventListener('pointermove', this.handlePointerMove);
    this.element.addEventListener('pointerdown', this.handlePointerDown);
    this.element.addEventListener('contextmenu', this.preventContextMenu);
  }

  dispose() {
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('blur', this.clear);
    this.element.removeEventListener('pointermove', this.handlePointerMove);
    this.element.removeEventListener('pointerdown', this.handlePointerDown);
    this.element.removeEventListener('contextmenu', this.preventContextMenu);
  }

  getMovement() {
    const x =
      Number(this.isPressed('KeyD') || this.isPressed('ArrowRight')) -
      Number(this.isPressed('KeyA') || this.isPressed('ArrowLeft'));
    const y =
      Number(this.isPressed('KeyS') || this.isPressed('ArrowDown')) -
      Number(this.isPressed('KeyW') || this.isPressed('ArrowUp'));

    this.moveVector.set(x + this.virtualMoveVector.x, y + this.virtualMoveVector.y);

    if (this.moveVector.lengthSq() > 1) {
      this.moveVector.normalize();
    }

    return this.moveVector;
  }

  isActionPressed() {
    return this.isPressed('KeyE') || this.virtualActionPressed;
  }

  isRestartPressed() {
    return this.isPressed('KeyR') || this.virtualRestartPressed;
  }

  getPointerNdc() {
    return this.pointerNdc;
  }

  consumeThrowPressed() {
    const wasRequested = this.throwRequested;
    this.throwRequested = false;
    return wasRequested;
  }

  consumeFlashlightTogglePressed() {
    const wasRequested = this.flashlightToggleRequested;
    this.flashlightToggleRequested = false;
    return wasRequested;
  }

  consumeDdgiDebugPressed() {
    const wasRequested = this.ddgiDebugRequested;
    this.ddgiDebugRequested = false;
    return wasRequested;
  }

  consumeDirectLightDebugPressed() {
    const wasRequested = this.directLightDebugRequested;
    this.directLightDebugRequested = false;
    return wasRequested;
  }

  consumeBrightnessDebugPressed() {
    const wasRequested = this.brightnessDebugRequested;
    this.brightnessDebugRequested = false;
    return wasRequested;
  }

  setVirtualMovement(x: number, y: number) {
    this.virtualMoveVector.set(
      THREE.MathUtils.clamp(x, -1, 1),
      THREE.MathUtils.clamp(y, -1, 1),
    );
  }

  setVirtualActionPressed(pressed: boolean) {
    this.virtualActionPressed = pressed;
  }

  setVirtualRestartPressed(pressed: boolean) {
    this.virtualRestartPressed = pressed;
  }

  requestThrow() {
    this.throwRequested = true;
  }

  requestFlashlightToggle() {
    this.flashlightToggleRequested = true;
  }

  private isPressed(code: string) {
    return this.pressedKeys.has(code);
  }

  private readonly handleKeyDown = (event: KeyboardEvent) => {
    this.pressedKeys.add(event.code);

    if (event.code === 'KeyQ') {
      this.throwRequested = true;
      event.preventDefault();
    }

    if (event.code === 'F2') {
      this.ddgiDebugRequested = true;
      event.preventDefault();
    }

    if (event.code === 'KeyP' && !event.repeat) {
      this.ddgiDebugRequested = true;
      event.preventDefault();
    }

    if (event.code === 'KeyR' && !event.repeat) {
      this.directLightDebugRequested = true;
      event.preventDefault();
    }

    if (event.code === 'KeyB' && !event.repeat) {
      this.brightnessDebugRequested = true;
      event.preventDefault();
    }
  };

  private readonly handleKeyUp = (event: KeyboardEvent) => {
    this.pressedKeys.delete(event.code);
  };

  private readonly clear = () => {
    this.pressedKeys.clear();
    this.virtualMoveVector.set(0, 0);
    this.virtualActionPressed = false;
    this.virtualRestartPressed = false;
  };

  private readonly handlePointerMove = (event: PointerEvent) => {
    const rect = this.element.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    const y = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
    this.pointerNdc.set(x, y);
  };

  private readonly handlePointerDown = (event: PointerEvent) => {
    this.handlePointerMove(event);

    if (event.button === 0) {
      this.flashlightToggleRequested = true;
    }
  };

  private readonly preventContextMenu = (event: MouseEvent) => {
    event.preventDefault();
  };
}

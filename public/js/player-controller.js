/**
 * Player Controller - FPS camera with fast movement for large maps
 */
import * as THREE from 'three';

export class PlayerController {
  constructor(camera, canvas, collisionSystem) {
    this.camera = camera;
    this.canvas = canvas;
    this.collision = collisionSystem;

    this.velocity = new THREE.Vector3();
    this.baseSpeed = 8000;    // fast base for large map
    this.sprintMult = 3;
    this.gravity = 3000;
    this.jumpSpeed = 1200;
    this.playerHeight = 180;
    this.isOnGround = false;
    this.gravityEnabled = false; // start in fly mode

    this.yaw = 0;
    this.pitch = -0.3; // slightly looking down
    this.mouseSensitivity = 0.002;
    this.isPointerLocked = false;

    this.keys = {};
    this.speedLevel = 6;      // 1-15, default 6
    this.speedChanged = 0;    // timestamp for UI

    this.setupInput();
  }

  get currentSpeed() {
    return this.baseSpeed * Math.pow(1.4, this.speedLevel - 6);
  }

  setupInput() {
    document.addEventListener('keydown', (e) => {
      this.keys[e.code] = true;
      if (e.code === 'KeyG') this.gravityEnabled = !this.gravityEnabled;
    });
    document.addEventListener('keyup', (e) => { this.keys[e.code] = false; });

    // Pointer lock via short click only (not drag). App sets _blockPointerLock during drag-select.
    let _mouseDownTime = 0;
    let _mouseDownX = 0, _mouseDownY = 0;
    this.canvas.addEventListener('mousedown', (e) => {
      _mouseDownTime = performance.now();
      _mouseDownX = e.clientX;
      _mouseDownY = e.clientY;
    });
    this.canvas.addEventListener('mouseup', (e) => {
      if (this._blockPointerLock) return;
      const dt = performance.now() - _mouseDownTime;
      const dx = Math.abs(e.clientX - _mouseDownX);
      const dy = Math.abs(e.clientY - _mouseDownY);
      // Only lock on short click with minimal movement
      if (dt < 300 && dx < 6 && dy < 6) {
        this.canvas.requestPointerLock();
      }
    });
    document.addEventListener('pointerlockchange', () => {
      this.isPointerLocked = document.pointerLockElement === this.canvas;
    });

    document.addEventListener('mousemove', (e) => {
      if (!this.isPointerLocked) return;
      this.yaw -= e.movementX * this.mouseSensitivity;
      this.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01,
        this.pitch - e.movementY * this.mouseSensitivity));
    });

    document.addEventListener('wheel', (e) => {
      if (e.deltaY < 0) this.speedLevel = Math.min(this.speedLevel + 1, 15);
      else this.speedLevel = Math.max(this.speedLevel - 1, 1);
      this.speedChanged = performance.now();
    }, { passive: true });
  }

  setPosition(x, y, z) {
    this.camera.position.set(x, y, z);
  }

  teleport(x, y, z) {
    this.camera.position.set(x, y, z);
    this.velocity.set(0, 0, 0);
  }

  update(delta) {
    const speed = this.currentSpeed;
    const actualSpeed = this.keys['ShiftLeft'] ? speed * this.sprintMult : speed;
    const euler = new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ');

    if (this.gravityEnabled) {
      const forward = new THREE.Vector3(0, 0, -1);
      const right = new THREE.Vector3(1, 0, 0);
      forward.applyEuler(new THREE.Euler(0, this.yaw, 0));
      right.applyEuler(new THREE.Euler(0, this.yaw, 0));

      const dir = new THREE.Vector3();
      if (this.keys['KeyW']) dir.add(forward);
      if (this.keys['KeyS']) dir.sub(forward);
      if (this.keys['KeyD']) dir.add(right);
      if (this.keys['KeyA']) dir.sub(right);
      dir.y = 0;
      if (dir.lengthSq() > 0) dir.normalize();

      if (!this.isOnGround) this.velocity.y -= this.gravity * delta;
      if (this.keys['Space'] && this.isOnGround) {
        this.velocity.y = this.jumpSpeed;
        this.isOnGround = false;
      }

      const pos = this.camera.position;
      pos.x += dir.x * actualSpeed * delta;
      pos.z += dir.z * actualSpeed * delta;
      pos.y += this.velocity.y * delta;

      const gh = this.collision.getGroundHeight(pos.x, pos.y, pos.z);
      if (gh !== null) {
        if (pos.y - this.playerHeight <= gh) {
          pos.y = gh + this.playerHeight;
          this.velocity.y = 0;
          this.isOnGround = true;
        } else {
          this.isOnGround = false;
        }
      }
    } else {
      // Free-fly
      const flyFwd = new THREE.Vector3(0, 0, -1).applyEuler(euler);
      const flyRight = new THREE.Vector3(1, 0, 0).applyEuler(new THREE.Euler(0, this.yaw, 0));
      const dir = new THREE.Vector3();
      if (this.keys['KeyW']) dir.add(flyFwd);
      if (this.keys['KeyS']) dir.sub(flyFwd);
      if (this.keys['KeyD']) dir.add(flyRight);
      if (this.keys['KeyA']) dir.sub(flyRight);
      if (this.keys['Space']) dir.y += 1;
      if (this.keys['ControlLeft'] && this.isPointerLocked) dir.y -= 1; // only in FPS mode
      if (dir.lengthSq() > 0) dir.normalize();

      this.camera.position.addScaledVector(dir, actualSpeed * delta);
      this.isOnGround = false;
    }

    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');

    // Save camera state every 3 seconds
    const now = performance.now();
    if (!this._lastSave || now - this._lastSave > 3000) {
      this._saveCameraState();
      this._lastSave = now;
    }
  }

  loadSavedState() {
    try {
      const raw = localStorage.getItem('jx3-camera');
      if (!raw) return;
      const s = JSON.parse(raw);
      this.camera.position.set(s.x, s.y, s.z);
      this.yaw   = s.yaw   ?? this.yaw;
      this.pitch = s.pitch ?? this.pitch;
      this.speedLevel = s.speedLevel ?? this.speedLevel;
      this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    } catch {}
  }

  _saveCameraState() {
    try {
      localStorage.setItem('jx3-camera', JSON.stringify({
        x: this.camera.position.x,
        y: this.camera.position.y,
        z: this.camera.position.z,
        yaw:        this.yaw,
        pitch:      this.pitch,
        speedLevel: this.speedLevel,
      }));
    } catch {}
  }
}

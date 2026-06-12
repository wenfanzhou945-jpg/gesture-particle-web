import * as THREE from "three";
import {
  clamp,
  createRadialGlowTexture,
  createSnowCrystalTexture,
  isLikelyMobile,
  lerp,
  qualityToCount,
  type QualityMode,
  type Vec3,
} from "./utils";
import { type HandGestureState } from "./gestures";

type FrameState = HandGestureState | null;

const SPRING_BASE = 0.06;
const DAMPING_BASE = 0.82;
const BASE_RADIUS = 8.2;

export interface ParticleSceneOptions {
  container: HTMLElement;
  quality: QualityMode;
  onFps?: (fps: number) => void;
}

export class ParticleScene {
  private readonly container: HTMLElement;
  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private points!: THREE.Points;
  private geometry!: THREE.BufferGeometry;
  private material!: THREE.PointsMaterial;
  private glow!: THREE.Sprite;
  private animationId = 0;
  private active = false;

  private count = 0;
  private quality: QualityMode;
  private onFps?: (fps: number) => void;

  private positions!: Float32Array;
  private velocities!: Float32Array;
  private basePositions!: Float32Array;
  private randomSeeds!: Float32Array;
  private randomDirs!: Float32Array;
  private colors!: Float32Array;
  private baseColors!: Float32Array;
  private sizes!: Float32Array;
  private positionAttribute!: THREE.BufferAttribute;
  private colorAttribute!: THREE.BufferAttribute;

  private currentState: FrameState = null;
  private burstStrength = 0;
  private width = 0;
  private height = 0;
  private fpsCounter = 0;
  private fpsLastTs = 0;
  private lastTs = 0;
  private burstOrigin: Vec3 | null = null;
  private previousHandWorld: Vec3 | null = null;
  private handWind: Vec3 = { x: 0, y: 0, z: 0 };

  private resizeObserver?: ResizeObserver;

  constructor(options: ParticleSceneOptions) {
    this.container = options.container;
    this.quality = options.quality;
    this.onFps = options.onFps;
    this.initRenderer();
    this.buildScene(qualityToCount(this.quality));
    this.resize();
    this.start();
  }

  public setQuality(quality: QualityMode): void {
    if (this.quality === quality) return;
    this.quality = quality;
    this.updatePixelRatio();
    this.buildScene(qualityToCount(quality));
  }

  public setInteractionState(state: FrameState): void {
    this.currentState = state;
    if (state?.pinchRelease) {
      this.burstStrength = Math.max(this.burstStrength, 0.8 + state.pinchStrength * 0.85);
      this.burstOrigin = this.screenToWorld(state.handCenter);
    }
    if (!state?.detected && state?.pinchRelease) {
      this.burstOrigin = this.screenToWorld(state.handCenter);
    }
  }

  public resize(): void {
    if (!this.camera || !this.renderer) return;
    this.width = Math.max(this.container.clientWidth, 1);
    this.height = Math.max(this.container.clientHeight, 1);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.updatePixelRatio();
    this.renderer.setSize(this.width, this.height, false);
  }

  public dispose(): void {
    this.stop();
    this.resizeObserver?.disconnect();
    this.geometry?.dispose();
    this.material?.map?.dispose();
    this.material?.dispose();
    this.scene?.remove(this.points);
    this.glow?.material && (this.glow.material as THREE.Material).dispose();
    this.renderer?.dispose();
    while (this.container.firstChild) {
      this.container.removeChild(this.container.firstChild);
    }
  }

  private initRenderer(): void {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x060011);
    this.scene.fog = new THREE.Fog(0x090018, 12, 30);

    const ambient = new THREE.AmbientLight(0x5a3070, 1.1);
    const rim = new THREE.PointLight(0xffd6ff, 0.28, 60, 1);
    rim.position.set(0, 0, 18);
    this.scene.add(ambient, rim);

    this.camera = new THREE.PerspectiveCamera(48, 1, 0.1, 80);
    this.camera.position.set(0, 0, 25);

    this.renderer = new THREE.WebGLRenderer({
      antialias: !isLikelyMobile(),
      alpha: false,
      powerPreference: "high-performance",
    });
    this.updatePixelRatio();
    this.renderer.setClearColor(0x060011, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.container.appendChild(this.renderer.domElement);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);

    this.createGlowSprite();
  }

  private updatePixelRatio(): void {
    if (!this.renderer) return;
    const maxRatio = isLikelyMobile() ? (this.quality === "low" ? 1.1 : 1.35) : 2;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxRatio));
  }

  private createGlowSprite(): void {
    const texture = createRadialGlowTexture();
    const spriteMat = new THREE.SpriteMaterial({
      map: texture,
      color: 0xffddff,
      transparent: true,
      blending: THREE.AdditiveBlending,
      opacity: 0.28,
      depthWrite: false,
      depthTest: false,
    });
    this.glow = new THREE.Sprite(spriteMat);
    this.glow.position.set(0, 0, -7);
    this.glow.scale.set(20, 20, 1);
    this.scene.add(this.glow);
  }

  private buildScene(count: number): void {
    if (this.points) {
      this.scene.remove(this.points);
      this.geometry?.dispose();
      this.material?.map?.dispose();
      this.material?.dispose();
    }

    this.count = count;
    this.positions = new Float32Array(this.count * 3);
    this.velocities = new Float32Array(this.count * 3);
    this.basePositions = new Float32Array(this.count * 3);
    this.randomSeeds = new Float32Array(this.count);
    this.randomDirs = new Float32Array(this.count * 3);
    this.colors = new Float32Array(this.count * 3);
    this.baseColors = new Float32Array(this.count * 3);
    this.sizes = new Float32Array(this.count);

    for (let i = 0; i < this.count; i += 1) {
      const i3 = i * 3;
      const u = Math.random() * Math.PI * 2;
      const v = Math.acos(2 * Math.random() - 1);
      const r = BASE_RADIUS + (Math.random() - 0.5) * 1.2;
      const x = r * Math.sin(v) * Math.cos(u);
      const y = r * Math.sin(v) * Math.sin(u);
      const z = r * Math.cos(v);

      this.basePositions[i3 + 0] = x;
      this.basePositions[i3 + 1] = y;
      this.basePositions[i3 + 2] = z;
      this.positions[i3 + 0] = x;
      this.positions[i3 + 1] = y;
      this.positions[i3 + 2] = z;
      this.velocities[i3 + 0] = 0;
      this.velocities[i3 + 1] = 0;
      this.velocities[i3 + 2] = 0;

      const seed = Math.random();
      this.randomSeeds[i] = seed;
      this.sizes[i] = 1.25 + seed * 1.35;

      const theta = seed * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      this.randomDirs[i3 + 0] = Math.sin(phi) * Math.cos(theta);
      this.randomDirs[i3 + 1] = Math.cos(phi);
      this.randomDirs[i3 + 2] = Math.sin(phi) * Math.sin(theta);

      const hue = seed < 0.62 ? lerp(214 / 360, 276 / 360, seed / 0.62) : lerp(292 / 360, 326 / 360, (seed - 0.62) / 0.38);
      const color = new THREE.Color().setHSL(hue, 0.92, 0.62 + 0.22 * seed);
      this.colors[i3 + 0] = color.r;
      this.colors[i3 + 1] = color.g;
      this.colors[i3 + 2] = color.b;
      this.baseColors[i3 + 0] = color.r;
      this.baseColors[i3 + 1] = color.g;
      this.baseColors[i3 + 2] = color.b;
    }

    this.geometry = new THREE.BufferGeometry();
    this.positionAttribute = new THREE.BufferAttribute(this.positions, 3);
    this.colorAttribute = new THREE.BufferAttribute(this.colors, 3);
    const sizeAttribute = new THREE.BufferAttribute(this.sizes, 1);

    this.geometry.setAttribute("position", this.positionAttribute);
    this.geometry.setAttribute("color", this.colorAttribute);
    this.geometry.setAttribute("size", sizeAttribute);

    this.material = new THREE.PointsMaterial({
      map: createSnowCrystalTexture(),
      size: isLikelyMobile() ? 0.24 : 0.2,
      vertexColors: true,
      transparent: true,
      opacity: 0.92,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      alphaTest: 0.015,
      sizeAttenuation: true,
      toneMapped: false,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.scene.add(this.points);
  }

  private start(): void {
    this.active = true;
    this.lastTs = performance.now();
    this.fpsLastTs = this.lastTs;
    this.animationId = requestAnimationFrame(this.render);
  }

  private stop(): void {
    this.active = false;
    cancelAnimationFrame(this.animationId);
  }

  private render = (): void => {
    if (!this.active) return;
    const now = performance.now();
    const dt = Math.min((now - this.lastTs) / 16.666, 2.2);
    this.lastTs = now;

    this.tick(dt);
    this.fpsCounter += 1;
    if (now - this.fpsLastTs >= 1000) {
      const fps = this.fpsCounter / ((now - this.fpsLastTs) / 1000);
      this.fpsCounter = 0;
      this.fpsLastTs = now;
      this.onFps?.(Math.round(fps));
    }

    this.renderer.render(this.scene, this.camera);
    this.animationId = requestAnimationFrame(this.render);
  };

  private tick(dt: number): void {
    const state = this.currentState;
    const hasHand = !!state?.detected;
    const openPalm = state?.openPalmStrength ?? 0;
    const handWorld = hasHand ? this.screenToWorld(state!.handCenter) : this.burstOrigin;
    const indexWorld = hasHand ? this.screenToWorld(state!.indexTip) : handWorld;
    const pinchHold = state?.pinchHold ?? false;
    const pinchStart = state?.pinchStart ?? false;
    const pinchStrength = state?.pinchStrength ?? 0;

    const scale = 1 + openPalm * 0.72;
    const spring = SPRING_BASE * (1 + openPalm * 0.58 + (pinchHold ? 1.2 : 0));
    const damping = pinchHold ? 0.84 : DAMPING_BASE - openPalm * 0.035;
    const t = performance.now();
    const seconds = t * 0.001;

    if (hasHand && handWorld) {
      if (this.previousHandWorld) {
        this.handWind.x = lerp(this.handWind.x, handWorld.x - this.previousHandWorld.x, 0.34);
        this.handWind.y = lerp(this.handWind.y, handWorld.y - this.previousHandWorld.y, 0.34);
        this.handWind.z = lerp(this.handWind.z, handWorld.z - this.previousHandWorld.z, 0.34);
      }
      this.previousHandWorld = { ...handWorld };
    } else {
      this.previousHandWorld = null;
      this.handWind.x *= 0.9;
      this.handWind.y *= 0.9;
      this.handWind.z *= 0.9;
    }

    for (let i = 0; i < this.count; i += 1) {
      const i3 = i * 3;
      const seed = this.randomSeeds[i];
      let distToHand = Number.POSITIVE_INFINITY;
      const baseX = this.basePositions[i3 + 0];
      const baseY = this.basePositions[i3 + 1];
      const baseZ = this.basePositions[i3 + 2];
      const phase = seconds * (0.34 + seed * 0.58) + seed * 31.7;
      const orbit = 0.28 + openPalm * 0.48;
      const fall = Math.sin(seconds * (0.38 + seed * 0.2) + seed * 19) * (0.2 + seed * 0.22);
      let targetX = (baseX * Math.cos(phase * 0.12) - baseZ * Math.sin(phase * 0.12) * 0.42) * scale;
      let targetY = baseY * scale + fall;
      let targetZ = (baseZ * Math.cos(phase * 0.1) + baseX * Math.sin(phase * 0.1) * 0.32) * scale;

      targetX += this.randomDirs[i3 + 0] * Math.sin(phase * 1.7) * orbit;
      targetY += this.randomDirs[i3 + 1] * Math.cos(phase * 1.25) * orbit;
      targetZ += this.randomDirs[i3 + 2] * Math.sin(phase * 1.45) * orbit;

      if (hasHand && handWorld && indexWorld) {
        const px = this.positions[i3 + 0];
        const py = this.positions[i3 + 1];
        const pz = this.positions[i3 + 2];
        distToHand = Math.hypot(px - handWorld.x, py - handWorld.y, pz - handWorld.z);

        if (pinchHold || pinchStart) {
          // 捏合时向食指聚拢，形成能量团
          const gatherRadius = 0.42 + (1 - pinchStrength) * 1.55 + seed * 0.95;
          const dir = {
            x: this.randomDirs[i3 + 0],
            y: this.randomDirs[i3 + 1],
            z: this.randomDirs[i3 + 2],
          };
          const falloff = 1 + clamp(1 - distToHand * 0.12, 0, 1);
          const vortex = phase * 5.5 + pinchStrength * 4;
          const ringX = Math.cos(vortex) * gatherRadius;
          const ringY = Math.sin(vortex) * gatherRadius;
          targetX = indexWorld.x + ringX * 0.85 + dir.x * gatherRadius * 0.55 * falloff;
          targetY = indexWorld.y + ringY * 0.85 + dir.y * gatherRadius * 0.55 * falloff;
          targetZ = indexWorld.z + dir.z * gatherRadius * falloff;

          this.velocities[i3 + 0] += (-ringY * 0.014 + this.handWind.x * 0.025) * dt;
          this.velocities[i3 + 1] += (ringX * 0.014 + this.handWind.y * 0.025) * dt;
          this.velocities[i3 + 2] += Math.sin(vortex) * 0.008 * dt;
        } else if (openPalm > 0.3) {
          // 张开手掌时整体放大扩散
          const disperse = 1 + openPalm * 0.82;
          targetX = baseX * disperse + this.randomDirs[i3 + 0] * openPalm * 2.2;
          targetY = baseY * disperse + this.randomDirs[i3 + 1] * openPalm * 2.2;
          targetZ = baseZ * disperse + this.randomDirs[i3 + 2] * openPalm * 2.2;
          this.velocities[i3 + 0] += this.handWind.x * (0.04 + seed * 0.03) * dt;
          this.velocities[i3 + 1] += this.handWind.y * (0.04 + seed * 0.03) * dt;
        } else {
          // 手掌靠近时产生风场和指尖涟漪，移动越快拖尾越明显。
          const attract = clamp(1.08 - distToHand * 0.2, 0, 1);
          targetX += (handWorld.x - targetX) * attract * 0.16 + this.handWind.x * attract * 0.9;
          targetY += (handWorld.y - targetY) * attract * 0.16 + this.handWind.y * attract * 0.9;
          targetZ += (handWorld.z - targetZ) * attract * 0.12;

          const toIndex = Math.hypot(px - indexWorld.x, py - indexWorld.y, pz - indexWorld.z);
          const wave = clamp(3.5 - toIndex, 0, 1);
          const ripple = Math.sin(phase * 4.2 - toIndex * 3.4) * wave * 0.72;
          targetX += this.randomDirs[i3 + 0] * ripple - (py - indexWorld.y) * wave * 0.03;
          targetY += this.randomDirs[i3 + 1] * ripple + (px - indexWorld.x) * wave * 0.03;
          targetZ += this.randomDirs[i3 + 2] * ripple;
        }
      } else {
        // 无手状态回到发光球体，同时保留慢速漂浮感。
        const drift = Math.sin(phase * 1.6 + seed * 9) * 0.18;
        targetX += this.randomDirs[i3 + 0] * drift;
        targetY += this.randomDirs[i3 + 1] * drift;
        targetZ += this.randomDirs[i3 + 2] * drift;
      }

      if (this.burstStrength > 0 && this.burstOrigin) {
        const origin = this.burstOrigin;
        const dx = this.positions[i3 + 0] - origin.x;
        const dy = this.positions[i3 + 1] - origin.y;
        const dz = this.positions[i3 + 2] - origin.z;
        const len = Math.max(Math.hypot(dx, dy, dz), 0.0001);
        const ring = 0.7 + Math.sin(len * 1.8 - seconds * 12 + seed * 8) * 0.3;
        this.velocities[i3 + 0] += (dx / len) * this.burstStrength * 0.115 * ring;
        this.velocities[i3 + 1] += (dy / len) * this.burstStrength * 0.115 * ring;
        this.velocities[i3 + 2] += (dz / len) * this.burstStrength * 0.115 * ring;
      }

      const vx = this.velocities[i3 + 0] + (targetX - this.positions[i3 + 0]) * spring * dt;
      const vy = this.velocities[i3 + 1] + (targetY - this.positions[i3 + 1]) * spring * dt;
      const vz = this.velocities[i3 + 2] + (targetZ - this.positions[i3 + 2]) * spring * dt;

      this.velocities[i3 + 0] = vx * damping;
      this.velocities[i3 + 1] = vy * damping;
      this.velocities[i3 + 2] = vz * damping;

      this.positions[i3 + 0] += this.velocities[i3 + 0] * dt;
      this.positions[i3 + 1] += this.velocities[i3 + 1] * dt;
      this.positions[i3 + 2] += this.velocities[i3 + 2] * dt;

      // 轻微高亮波动
      const glow = 0.24 + clamp(openPalm, 0, 1) * 0.55 + seed * 0.12;
      const glowBoost = hasHand ? clamp(1 - distToHand / 5.2, 0, 1) * 0.48 : 0;
      const pinchGlow = pinchHold ? 0.35 + pinchStrength * 0.5 : 0;
      this.colors[i3 + 0] = lerp(this.colors[i3 + 0], clamp(this.baseColors[i3 + 0] + glow * 0.22 + glowBoost + pinchGlow, 0, 1), 0.05);
      this.colors[i3 + 1] = lerp(this.colors[i3 + 1], clamp(this.baseColors[i3 + 1] + glowBoost * 0.75 + pinchGlow * 0.72, 0, 1), 0.05);
      this.colors[i3 + 2] = lerp(this.colors[i3 + 2], clamp(this.baseColors[i3 + 2] + glow * 0.16 + glowBoost + pinchGlow, 0, 1), 0.05);
    }

    this.positionAttribute.needsUpdate = true;
    this.colorAttribute.needsUpdate = true;
    if (this.burstStrength > 0) this.burstStrength *= 0.9;
    if (this.burstStrength < 0.01) this.burstOrigin = null;
    const glowScale = 20 + openPalm * 7 + (pinchHold ? pinchStrength * 8 : 0) + this.burstStrength * 4;
    this.glow.scale.set(glowScale, glowScale, 1);
    (this.glow.material as THREE.SpriteMaterial).opacity = 0.18 + openPalm * 0.08 + (pinchHold ? 0.18 : 0) + this.burstStrength * 0.1;
  }

  private screenToWorld(point: Vec3): Vec3 {
    const x = clamp(point.x / Math.max(this.width, 1), 0, 1);
    const y = clamp(point.y / Math.max(this.height, 1), 0, 1);
    return {
      x: (x - 0.5) * BASE_RADIUS * 1.8,
      y: -(y - 0.5) * BASE_RADIUS * 1.8,
      z: -point.z / 120,
    };
  }
}

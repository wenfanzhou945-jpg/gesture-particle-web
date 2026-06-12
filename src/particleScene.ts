import * as THREE from "three";
import {
  clamp,
  createRadialGlowTexture,
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

      const hue = lerp(318 / 360, 268 / 360, seed);
      const color = new THREE.Color().setHSL(hue, 0.9, 0.5 + 0.2 * seed);
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
      size: 0.16,
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
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
    const spring = SPRING_BASE * (1 + openPalm * 0.8);
    const damping = DAMPING_BASE;
    const t = performance.now();

    for (let i = 0; i < this.count; i += 1) {
      const i3 = i * 3;
      const seed = this.randomSeeds[i];
      let distToHand = Number.POSITIVE_INFINITY;
      let targetX = this.basePositions[i3 + 0] * scale;
      let targetY = this.basePositions[i3 + 1] * scale;
      let targetZ = this.basePositions[i3 + 2] * scale;

      if (hasHand && handWorld && indexWorld) {
        const px = this.positions[i3 + 0];
        const py = this.positions[i3 + 1];
        const pz = this.positions[i3 + 2];
        distToHand = Math.hypot(px - handWorld.x, py - handWorld.y, pz - handWorld.z);

        if (pinchHold || pinchStart) {
          // 捏合时向食指聚拢，形成能量团
          const gatherRadius = 0.55 + (1 - pinchStrength) * 2.0 + seed * 1.2;
          const dir = {
            x: this.randomDirs[i3 + 0],
            y: this.randomDirs[i3 + 1],
            z: this.randomDirs[i3 + 2],
          };
          const falloff = 1 + clamp(1 - distToHand * 0.12, 0, 1);
          targetX = indexWorld.x + dir.x * gatherRadius * falloff;
          targetY = indexWorld.y + dir.y * gatherRadius * falloff;
          targetZ = indexWorld.z + dir.z * gatherRadius * falloff;

          const swirl = Math.sin(t * 0.002 + seed * 30) * 0.2;
          targetX += dir.x * swirl;
          targetY += dir.y * swirl;
          targetZ += dir.z * swirl;
        } else if (openPalm > 0.3) {
          // 张开手掌时整体放大扩散
          const disperse = 1 + openPalm * 0.6;
          targetX = this.basePositions[i3 + 0] * disperse;
          targetY = this.basePositions[i3 + 1] * disperse;
          targetZ = this.basePositions[i3 + 2] * disperse;
        } else {
          // 非捏合靠近时轻微涟漪扰动
          const attract = clamp(0.9 - distToHand * 0.22, 0, 1);
          targetX += (handWorld.x - targetX) * attract * 0.12;
          targetY += (handWorld.y - targetY) * attract * 0.12;
          targetZ += (handWorld.z - targetZ) * attract * 0.12;

          const wave = clamp(2.5 - distToHand, 0, 1) * 0.45;
          const r = Math.sin(t * 0.002 + seed * 35) * wave * 0.45;
          targetX += this.randomDirs[i3 + 0] * r;
          targetY += this.randomDirs[i3 + 1] * r;
          targetZ += this.randomDirs[i3 + 2] * r;
        }
      } else {
        // 无手状态回到默认球体并带微振
        const jitter = Math.sin(t * 0.001 + seed * 50) * 0.03;
        targetX += jitter;
        targetY += jitter;
        targetZ += jitter;
      }

      if (this.burstStrength > 0 && this.burstOrigin) {
        const origin = this.burstOrigin;
        const dx = this.positions[i3 + 0] - origin.x;
        const dy = this.positions[i3 + 1] - origin.y;
        const dz = this.positions[i3 + 2] - origin.z;
        const len = Math.max(Math.hypot(dx, dy, dz), 0.0001);
        this.velocities[i3 + 0] += (dx / len) * this.burstStrength * 0.08;
        this.velocities[i3 + 1] += (dy / len) * this.burstStrength * 0.08;
        this.velocities[i3 + 2] += (dz / len) * this.burstStrength * 0.08;
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
      const glow = 0.2 + clamp(openPalm, 0, 1) * 0.5 + seed * 0.1;
      const glowBoost = hasHand ? clamp(1 - distToHand / 4.5, 0, 1) * 0.35 : 0;
      this.colors[i3 + 0] = lerp(this.colors[i3 + 0], clamp(this.baseColors[i3 + 0] + glow * 0.35 + glowBoost, 0, 1), 0.04);
      this.colors[i3 + 1] = lerp(this.colors[i3 + 1], clamp(this.baseColors[i3 + 1] + glowBoost * 0.65, 0, 1), 0.04);
      this.colors[i3 + 2] = lerp(this.colors[i3 + 2], clamp(this.baseColors[i3 + 2] + glowBoost, 0, 1), 0.04);
    }

    this.positionAttribute.needsUpdate = true;
    this.colorAttribute.needsUpdate = true;
    if (this.burstStrength > 0) this.burstStrength *= 0.9;
    if (this.burstStrength < 0.01) this.burstOrigin = null;
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

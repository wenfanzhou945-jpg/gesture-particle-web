import * as THREE from "three";

export type Vec2 = {
  x: number;
  y: number;
};

export type Vec3 = {
  x: number;
  y: number;
  z: number;
};

export type QualityMode = "low" | "standard" | "high";

export type DevicePerformanceProfile = "low" | "standard" | "high";

export const clamp = (value: number, min = 0, max = 1): number => {
  if (value < min) return min;
  if (value > max) return max;
  return value;
};

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const distance2D = (a: Vec2, b: Vec2): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

export const distance3D = (a: Vec3, b: Vec3): number =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export const isHttpsOrLocalhost = (): boolean => {
  if (typeof window === "undefined") return false;
  if (window.location.protocol === "https:") return true;
  if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
    return true;
  }
  return false;
};

export const mapNormalizedToScreen = (
  point: Vec3,
  videoWidth: number,
  videoHeight: number,
  mirror: boolean
): Vec3 => {
  const x = mirror ? 1 - point.x : point.x;
  return {
    x: x * videoWidth,
    y: point.y * videoHeight,
    z: point.z ?? 0,
  };
};

export const qualityToCount = (quality: QualityMode): number => {
  switch (quality) {
    case "low":
      return 3000;
    case "high":
      return 10000;
    case "standard":
    default:
      return 6000;
  }
};

export const isLikelyMobile = (): boolean => {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const coarsePointer = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || !!coarsePointer;
};

export const detectDeviceProfile = (): DevicePerformanceProfile => {
  const cores = navigator.hardwareConcurrency || 4;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const mobile = isLikelyMobile();

  if (mobile && (cores <= 6 || (typeof memory === "number" && memory <= 4))) {
    return "low";
  }
  if (mobile) {
    return "standard";
  }
  if (cores <= 4 || (typeof memory === "number" && memory <= 2)) {
    return "low";
  }
  if (cores <= 6 || (typeof memory === "number" && memory <= 4)) {
    return "standard";
  }
  return "high";
};

export const particleColorFromSeed = (seed: number): THREE.Color => {
  const paletteT = seed;
  const hues: number[] = [320 / 360, 270 / 360, 210 / 360];
  const hue = lerp(hues[0], hues[2], paletteT);
  const color = new THREE.Color();
  color.setHSL(hue, 0.85, 0.45 + (0.2 * seed));
  return color;
};

export const createRadialGlowTexture = (): THREE.Texture => {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    const fallback = new THREE.Texture();
    fallback.needsUpdate = true;
    return fallback;
  }

  const cx = size / 2;
  const cy = size / 2;
  const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, cx);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.25, "rgba(185,124,255,0.85)");
  gradient.addColorStop(0.55, "rgba(70,0,130,0.45)");
  gradient.addColorStop(1, "rgba(20,0,40,0)");

  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
};

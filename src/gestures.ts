import { clamp, distance2D, distance3D, lerp, Vec2, Vec3 } from "./utils";

export const LANDMARK_INDEX = {
  WRIST: 0,
  THUMB_TIP: 4,
  INDEX_TIP: 8,
  INDEX_MCP: 5,
  MIDDLE_MCP: 9,
  MIDDLE_TIP: 12,
  RING_TIP: 16,
  PINKY_TIP: 20,
} as const;

export interface NormalizedLandmark {
  x: number;
  y: number;
  z: number;
}

export interface HandGestureState {
  detected: boolean;
  source: "camera" | "touch";
  handCenter: Vec3;
  thumbTip: Vec3;
  indexTip: Vec3;
  middleTip: Vec3;
  ringTip: Vec3;
  pinkyTip: Vec3;
  pinchDistance: number;
  palmSize: number;
  normalizedPinch: number;
  pinchStrength: number;
  openPalmStrength: number;
  pinchStart: boolean;
  pinchHold: boolean;
  pinchRelease: boolean;
  timestampMs: number;
}

export const createEmptyHandState = (): HandGestureState => ({
  detected: false,
  source: "camera",
  handCenter: { x: 0, y: 0, z: 0 },
  thumbTip: { x: 0, y: 0, z: 0 },
  indexTip: { x: 0, y: 0, z: 0 },
  middleTip: { x: 0, y: 0, z: 0 },
  ringTip: { x: 0, y: 0, z: 0 },
  pinkyTip: { x: 0, y: 0, z: 0 },
  pinchDistance: 0,
  palmSize: 0,
  normalizedPinch: 0,
  pinchStrength: 0,
  openPalmStrength: 0,
  pinchStart: false,
  pinchHold: false,
  pinchRelease: false,
  timestampMs: 0,
});

export const computeHandGestureFromLandmarks = (
  landmarks: NormalizedLandmark[],
  videoSize: { width: number; height: number },
  isMirror: boolean,
  prevState: HandGestureState,
  timestampMs: number
): HandGestureState => {
  const wrist = landmarks[LANDMARK_INDEX.WRIST];
  const thumbTip = landmarks[LANDMARK_INDEX.THUMB_TIP];
  const indexTip = landmarks[LANDMARK_INDEX.INDEX_TIP];
  const middleTip = landmarks[LANDMARK_INDEX.MIDDLE_TIP];
  const ringTip = landmarks[LANDMARK_INDEX.RING_TIP];
  const pinkyTip = landmarks[LANDMARK_INDEX.PINKY_TIP];
  const indexMcp = landmarks[LANDMARK_INDEX.INDEX_MCP];
  const middleMcp = landmarks[LANDMARK_INDEX.MIDDLE_MCP];

  const mirrored = (l: NormalizedLandmark): Vec3 => ({
    x: isMirror ? 1 - l.x : l.x,
    y: l.y,
    z: l.z,
  });

  const w = mirrored(wrist);
  const thumb = mirrored(thumbTip);
  const index = mirrored(indexTip);
  const middle = mirrored(middleTip);
  const ring = mirrored(ringTip);
  const pinky = mirrored(pinkyTip);
  const indexBase = mirrored(indexMcp);
  const middleBase = mirrored(middleMcp);

  const rawCenter = {
    x: (w.x + index.x + middle.x) / 3,
    y: (w.y + index.y + middle.y) / 3,
    z: (w.z + index.z + middle.z) / 3,
  };

  const handCenter: Vec3 = {
    x: rawCenter.x * videoSize.width,
    y: rawCenter.y * videoSize.height,
    z: ((w.z + index.z + middle.z) / 3) * 80,
  };

  const pinchDistance = distance3D(thumb, index);
  const palmSize =
    distance3D(w, indexBase) > 0 ? distance3D(w, indexBase) : distance3D(w, middleBase);
  const normalizedPinch = palmSize > 0 ? pinchDistance / palmSize : 1;

  const normalizedPinchClamped = clamp(normalizedPinch, 0.1, 1.3);
  const rawPinchStrength = clamp(1 - (normalizedPinchClamped - 0.16) / 0.45, 0, 1);

  const spanTips = distance3D(w, thumb) + distance3D(w, index) + distance3D(w, middle) + distance3D(w, ring) + distance3D(w, pinky);
  const avgSpan = spanTips / 5;
  const rawOpenPalmStrength = clamp((avgSpan / (palmSize + 1e-6) - 1.05) / 0.55, 0, 1);

  const smoothPoint = (current: Vec3, previous: Vec3, amount: number): Vec3 => ({
    x: lerp(previous.x, current.x, amount),
    y: lerp(previous.y, current.y, amount),
    z: lerp(previous.z, current.z, amount),
  });

  const shouldSmooth = prevState.detected && prevState.source === "camera";
  const smoothedHandCenter = shouldSmooth ? smoothPoint(handCenter, prevState.handCenter, 0.46) : handCenter;
  const smoothedPinchStrength = shouldSmooth ? lerp(prevState.pinchStrength, rawPinchStrength, 0.32) : rawPinchStrength;
  const smoothedOpenPalmStrength = shouldSmooth ? lerp(prevState.openPalmStrength, rawOpenPalmStrength, 0.28) : rawOpenPalmStrength;

  const startThreshold = 0.38;
  const endThreshold = 0.52;
  let pinchStart = false;
  let pinchRelease = false;
  let pinchHold = prevState.pinchHold;

  if (!prevState.detected) {
    pinchHold = false;
  }

  if (normalizedPinch < startThreshold && !pinchHold) {
    pinchHold = true;
    pinchStart = true;
  } else if (pinchHold && normalizedPinch > endThreshold) {
    pinchHold = false;
    pinchRelease = true;
  }

  return {
    detected: true,
    source: "camera",
    handCenter: smoothedHandCenter,
    thumbTip: { x: thumb.x * videoSize.width, y: thumb.y * videoSize.height, z: thumb.z * 80 },
    indexTip: { x: index.x * videoSize.width, y: index.y * videoSize.height, z: index.z * 80 },
    middleTip: { x: middle.x * videoSize.width, y: middle.y * videoSize.height, z: middle.z * 80 },
    ringTip: { x: ring.x * videoSize.width, y: ring.y * videoSize.height, z: ring.z * 80 },
    pinkyTip: { x: pinky.x * videoSize.width, y: pinky.y * videoSize.height, z: pinky.z * 80 },
    pinchDistance,
    palmSize,
    normalizedPinch,
    pinchStrength: smoothedPinchStrength,
    openPalmStrength: smoothedOpenPalmStrength,
    pinchStart,
    pinchHold,
    pinchRelease,
    timestampMs,
  };
};

import {
  FilesetResolver,
  HandLandmarker,
  HandLandmarkerResult,
} from "@mediapipe/tasks-vision";
import {
  computeHandGestureFromLandmarks,
  createEmptyHandState,
  HandGestureState,
  NormalizedLandmark,
} from "./gestures";
import { clamp, Vec3 } from "./utils";

export type TrackerStatus =
  | "idle"
  | "loading"
  | "ready"
  | "error";

export type HandTrackerErrorType = "permission" | "model" | "other";

export interface HandTrackerStatus {
  status: TrackerStatus;
  message?: string;
}

export interface HandTrackerOptions {
  frameSkip?: number;
  mirror?: boolean;
  onStatusChange?: (status: HandTrackerStatus) => void;
  onError?: (type: HandTrackerErrorType, message: string) => void;
}

export class HandTracker {
  private landmarker?: HandLandmarker;
  private frameCount = 0;
  private lastFrameState: HandGestureState = createEmptyHandState();
  private frameSkip = 2;
  private mirror = false;
  private status: TrackerStatus = "idle";
  private lastError = "";
  private onStatusChange?: (status: HandTrackerStatus) => void;
  private onError?: (type: HandTrackerErrorType, message: string) => void;
  private destroyed = false;

  constructor(options: HandTrackerOptions = {}) {
    this.frameSkip = options.frameSkip ?? 2;
    this.mirror = options.mirror ?? false;
    this.onStatusChange = options.onStatusChange;
    this.onError = options.onError;
    this.emitStatus("idle");
  }

  public setMirror(isFrontCamera: boolean): void {
    this.mirror = isFrontCamera;
  }

  public getStatus(): TrackerStatus {
    return this.status;
  }

  public async initialize(): Promise<void> {
    if (this.landmarker || this.destroyed) return;
    this.emitStatus("loading");
    try {
      const resolver = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm"
      );
      if (this.destroyed) return;
      try {
        this.landmarker = await HandLandmarker.createFromOptions(resolver, {
          baseOptions: {
            modelAssetPath:
              "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker.task",
            delegate: "GPU",
          },
          runningMode: "VIDEO",
          numHands: 1,
        });
      } catch {
        // 某些浏览器 GPU delegate 初始化失败时回退到 CPU，避免模型完全不可用
        this.landmarker = await HandLandmarker.createFromOptions(resolver, {
          baseOptions: {
            modelAssetPath:
              "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker.task",
            delegate: "CPU",
          },
          runningMode: "VIDEO",
          numHands: 1,
        });
      }
      this.emitStatus("ready");
      this.lastError = "";
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      this.lastError = message;
      this.emitStatus("error", message);
      this.onError?.("model", "MediaPipe 模型加载失败，已切换到触摸模式");
      throw error;
    }
  }

  public async detect(
    video: HTMLVideoElement,
    timestampMs: number
  ): Promise<HandGestureState> {
    if (!this.landmarker || !video || this.destroyed) {
      return { ...this.lastFrameState, detected: false, pinchHold: false, pinchRelease: false };
    }

    this.frameCount += 1;
    if (this.frameSkip > 1 && this.frameCount % this.frameSkip !== 0) {
      return {
        ...this.lastFrameState,
        detected: this.lastFrameState.detected,
        timestampMs,
      };
    }

    try {
      const result: HandLandmarkerResult = await this.landmarker.detectForVideo(
        video,
        timestampMs
      );
      const hands = result.landmarks ?? [];

      if (!hands.length || !hands[0]?.length) {
        const noHand = {
          ...this.lastFrameState,
          detected: false,
          pinchHold: false,
          pinchStart: false,
          pinchRelease: false,
          timestampMs,
        };
        this.lastFrameState = noHand;
        return noHand;
      }

      const lm: NormalizedLandmark[] = hands[0].map((pt: { x: number; y: number; z: number }) => ({
        x: clamp(pt.x, 0, 1),
        y: clamp(pt.y, 0, 1),
        z: pt.z,
      }));

      const mappedState = computeHandGestureFromLandmarks(
        lm,
        { width: Math.max(video.videoWidth, 1), height: Math.max(video.videoHeight, 1) },
        this.mirror,
        this.lastFrameState,
        timestampMs
      );

      // 对单点模型输出做轻量滤波，避免抖动
      const smooth = 0.18;
      this.lastFrameState = {
        ...mappedState,
        handCenter: this.lerpVec3(this.lastFrameState.handCenter, mappedState.handCenter, 1 - smooth),
        indexTip: this.lerpVec3(this.lastFrameState.indexTip, mappedState.indexTip, 1 - smooth),
        thumbTip: this.lerpVec3(this.lastFrameState.thumbTip, mappedState.thumbTip, 1 - smooth),
        middleTip: this.lerpVec3(this.lastFrameState.middleTip, mappedState.middleTip, 1 - smooth),
        pinkyTip: this.lerpVec3(this.lastFrameState.pinkyTip, mappedState.pinkyTip, 1 - smooth),
      };

      return this.lastFrameState;
    } catch (error) {
      const message = error instanceof Error ? error.message : "hand detection error";
      this.onError?.("other", message);
      const fallback = {
        ...this.lastFrameState,
        detected: false,
        pinchHold: false,
        pinchStart: false,
        pinchRelease: false,
        timestampMs,
      };
      this.lastFrameState = fallback;
      return fallback;
    }
  }

  public dispose(): void {
    this.destroyed = true;
    this.landmarker?.close();
    this.landmarker = undefined;
  }

  private lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      z: a.z + (b.z - a.z) * t,
    };
  }

  private emitStatus(status: TrackerStatus, message?: string): void {
    this.status = status;
    this.onStatusChange?.({ status, message });
  }
}

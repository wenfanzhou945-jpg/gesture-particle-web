import { useCallback, useEffect, useRef, useState } from "react";
import { HandTracker, type HandTrackerStatus } from "./handTracker";
import { type HandGestureState } from "./gestures";
import { ParticleScene } from "./particleScene";
import {
  clamp,
  detectDeviceProfile,
  isHttpsOrLocalhost,
  qualityToCount,
  type QualityMode,
  type Vec2,
} from "./utils";

type CameraFacing = "user" | "environment";

type ManualPointer = {
  x: number;
  y: number;
  startX: number;
  startY: number;
  moved: boolean;
};

type ManualTouchState = {
  pointers: Map<number, ManualPointer>;
  pinchHold: boolean;
  pendingPinchStart: boolean;
  pendingPinchRelease: boolean;
  releasePoint: Vec2;
};

const statusText = {
  loadingModel: "loading model",
  cameraReady: "camera ready",
  handDetected: "hand detected",
  noHand: "no hand",
  pinch: "pinch",
  openPalm: "open palm",
};

const trackerStatusText: Record<HandTrackerStatus["status"], string> = {
  idle: "loading model",
  loading: "loading model",
  ready: "model ready",
  error: "model load error",
};

function mapQualityFromDevice(profile: "low" | "standard" | "high"): QualityMode {
  if (profile === "low") return "low";
  if (profile === "high") return "high";
  return "standard";
}

export function App(): JSX.Element {
  const sceneContainerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const sceneRef = useRef<ParticleScene | null>(null);
  const trackerRef = useRef<HandTracker | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number>(0);
  const isMountedRef = useRef<boolean>(true);
  const isCameraRunningRef = useRef<boolean>(false);
  const isTouchModeRef = useRef<boolean>(true);
  const longPressTimerRef = useRef<number | null>(null);
  const statusThrottleRef = useRef<number>(0);
  const showFpsRef = useRef<boolean>(true);

  const [quality, setQuality] = useState<QualityMode>(mapQualityFromDevice(detectDeviceProfile()));
  const [facingMode, setFacingMode] = useState<CameraFacing>("user");
  const [trackerStatus, setTrackerStatus] = useState<HandTrackerStatus["status"]>("idle");
  const [cameraStatus, setCameraStatus] = useState<string>("未启动摄像头");
  const [statusList, setStatusList] = useState<string[]>([
    "请用手机浏览器打开，点击启动摄像头进行交互",
  ]);
  const [fps, setFps] = useState<number>(0);
  const [showFps, setShowFps] = useState<boolean>(true);
  const [isCameraRunning, setIsCameraRunning] = useState<boolean>(false);
  const [isTouchMode, setIsTouchMode] = useState<boolean>(true);
  const [isPreviewVisible, setIsPreviewVisible] = useState<boolean>(true);

  const manualTouchRef = useRef<ManualTouchState>({
    pointers: new Map(),
    pinchHold: false,
    pendingPinchStart: false,
    pendingPinchRelease: false,
    releasePoint: { x: 0, y: 0 },
  });

  const publishInteraction = useCallback((state: HandGestureState | null) => {
    sceneRef.current?.setInteractionState(state);
  }, []);

  const publishStatus = useCallback(
    (state: HandGestureState | null) => {
      const now = performance.now();
      if (now - statusThrottleRef.current < 120) return;
      statusThrottleRef.current = now;

      const list = [trackerStatusText[trackerStatus], isTouchMode ? "touch mode" : cameraStatus];

      list.push(state?.detected ? statusText.handDetected : statusText.noHand);

      if (!isTouchMode && isCameraRunning) {
        list.push(statusText.cameraReady);
      }
      if (state?.pinchHold) list.push(statusText.pinch);
      if ((state?.openPalmStrength ?? 0) > 0.35) list.push(statusText.openPalm);

      setStatusList(list);
    },
    [cameraStatus, isCameraRunning, isTouchMode, trackerStatus]
  );

  const resetStatusList = useCallback(
    (extraStatus?: string) => {
      setStatusList([trackerStatusText[trackerStatus], extraStatus ?? (isTouchMode ? "touch mode" : cameraStatus), statusText.noHand]);
    },
    [cameraStatus, isTouchMode, trackerStatus]
  );

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    isCameraRunningRef.current = false;
    setIsCameraRunning(false);
    setCameraStatus("未启动摄像头");
    resetStatusList();
  }, [resetStatusList]);

  const enableTouchMode = useCallback(
    (reason: string) => {
      isTouchModeRef.current = true;
      setIsTouchMode(true);
      setCameraStatus(reason);
      stopCamera();
      resetStatusList(reason);
      publishInteraction(null);
    },
    [publishInteraction, resetStatusList, stopCamera]
  );

  const applyTrackerStatus = useCallback((status: HandTrackerStatus) => {
    setTrackerStatus(status.status);
  }, []);

  const initTracker = useCallback(async (): Promise<void> => {
    if (trackerRef.current) return;
    const tracker = new HandTracker({
      frameSkip: 2,
      mirror: facingMode === "user",
      onStatusChange: applyTrackerStatus,
      onError: () => {
        enableTouchMode("模型加载失败，已进入触摸模式");
      },
    });
    trackerRef.current = tracker;
    await tracker.initialize();
  }, [applyTrackerStatus, enableTouchMode, facingMode]);

  const startTrackLoop = useCallback(() => {
    const loop = async (time: number): Promise<void> => {
      if (!isMountedRef.current) return;

      if (isCameraRunningRef.current && !isTouchModeRef.current && trackerRef.current && videoRef.current) {
        try {
          const nextState = await trackerRef.current.detect(videoRef.current, time);
          if (nextState.detected) {
            publishInteraction(nextState);
            publishStatus(nextState);
          } else {
            publishInteraction(null);
            publishStatus(null);
          }
        } catch {
          publishInteraction(null);
          publishStatus(null);
        }
      }

      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
  }, [publishInteraction, publishStatus]);

  const startCamera = useCallback(
    async (nextFacing: CameraFacing = facingMode): Promise<void> => {
      if (!isHttpsOrLocalhost() || !navigator.mediaDevices?.getUserMedia) {
        setCameraStatus("当前页面不是 HTTPS/localhost，浏览器禁止摄像头访问");
        enableTouchMode("当前页面不是 HTTPS/localhost，浏览器禁止摄像头访问");
        return;
      }
      if (!videoRef.current) return;

      isTouchModeRef.current = false;
      setIsTouchMode(false);
      setCameraStatus("camera starting...");

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: nextFacing },
            width: { ideal: 960 },
            height: { ideal: 540 },
            frameRate: { ideal: 24, max: 30 },
          },
        });

        streamRef.current = stream;
        videoRef.current.srcObject = stream;
        videoRef.current.muted = true;
        videoRef.current.playsInline = true;
        videoRef.current.setAttribute("muted", "");
        videoRef.current.setAttribute("playsinline", "");
        videoRef.current.setAttribute("webkit-playsinline", "");
        await new Promise<void>((resolve) => {
          const video = videoRef.current;
          if (!video || video.readyState >= HTMLMediaElement.HAVE_METADATA) {
            resolve();
            return;
          }
          video.onloadedmetadata = () => resolve();
        });
        await videoRef.current.play();

        isCameraRunningRef.current = true;
        setIsCameraRunning(true);
        setFacingMode(nextFacing);
        setCameraStatus(statusText.cameraReady);
        publishInteraction(null);
        publishStatus(null);

        try {
          if (!trackerRef.current) {
            await initTracker();
          } else {
            trackerRef.current.setMirror(nextFacing === "user");
          }
        } catch {
          enableTouchMode("模型加载失败，已进入触摸模式");
        }
      } catch (error) {
        const name = error instanceof DOMException ? error.name : "";
        if (name === "NotAllowedError" || name === "SecurityError") {
          enableTouchMode("摄像头权限被拒绝，可使用触摸模式体验");
        } else {
          enableTouchMode("摄像头启动失败，已进入触摸模式");
        }
      }
    },
    [enableTouchMode, facingMode, initTracker, publishInteraction, publishStatus]
  );

  const switchCamera = useCallback(async () => {
    const nextFacing = facingMode === "user" ? "environment" : "user";
    if (isCameraRunningRef.current) {
      stopCamera();
      await startCamera(nextFacing);
    } else {
      setFacingMode(nextFacing);
    }
  }, [facingMode, startCamera, stopCamera]);

  const createTouchState = useCallback((time: number): HandGestureState | null => {
    const points = Array.from(manualTouchRef.current.pointers.values());

    if (!points.length) {
      if (!manualTouchRef.current.pendingPinchRelease) return null;
      manualTouchRef.current.pendingPinchRelease = false;

      return {
        detected: false,
        source: "touch",
        handCenter: { ...manualTouchRef.current.releasePoint, z: 0 },
        thumbTip: { ...manualTouchRef.current.releasePoint, z: 0 },
        indexTip: { ...manualTouchRef.current.releasePoint, z: 0 },
        middleTip: { ...manualTouchRef.current.releasePoint, z: 0 },
        ringTip: { ...manualTouchRef.current.releasePoint, z: 0 },
        pinkyTip: { ...manualTouchRef.current.releasePoint, z: 0 },
        pinchDistance: 0,
        palmSize: 1,
        normalizedPinch: 1.25,
        pinchStrength: 0,
        openPalmStrength: 0,
        pinchStart: false,
        pinchHold: false,
        pinchRelease: true,
        timestampMs: time,
      };
    }

    const len = points.length;
    const handX = points.reduce((sum, item) => sum + item.x, 0) / len;
    const handY = points.reduce((sum, item) => sum + item.y, 0) / len;

    let pinchDistancePx = 140;
    let pinchStrength = 0;
    let openPalmStrength = 0.6;

    if (len >= 2) {
      const a = points[0];
      const b = points[1];
      pinchDistancePx = Math.hypot(a.x - b.x, a.y - b.y);
      const normalizedPinch = pinchDistancePx / 220;
      pinchStrength = clamp(1 - normalizedPinch, 0, 1);
      openPalmStrength = clamp((normalizedPinch - 0.1) * 0.85, 0, 1);
    }

    const pendingStart = manualTouchRef.current.pendingPinchStart;
    const pendingRelease = manualTouchRef.current.pendingPinchRelease;
    const pinchHold = manualTouchRef.current.pinchHold;
    manualTouchRef.current.pendingPinchStart = false;
    manualTouchRef.current.pendingPinchRelease = false;

    return {
      detected: true,
      source: "touch",
      handCenter: { x: handX, y: handY, z: 0 },
      thumbTip: { x: handX, y: handY, z: 0 },
      indexTip: { x: handX, y: handY, z: 0 },
      middleTip: { x: handX, y: handY, z: 0 },
      ringTip: { x: handX, y: handY, z: 0 },
      pinkyTip: { x: handX, y: handY, z: 0 },
      pinchDistance: pinchDistancePx,
      palmSize: 0.4,
      normalizedPinch: clamp(pinchDistancePx / 220, 0.08, 1.25),
      pinchStrength,
      openPalmStrength,
      pinchStart: pendingStart,
      pinchHold,
      pinchRelease: pendingRelease,
      timestampMs: time,
    };
  }, []);

  const pushManualGesture = useCallback(
    (time: number) => {
      if (!isTouchModeRef.current) return;
      const next = createTouchState(time);
      if (!next) {
        publishInteraction(null);
        publishStatus(null);
        return;
      }
      publishInteraction(next);
      publishStatus(next);
    },
    [createTouchState, publishInteraction, publishStatus]
  );

  const handlePointerDown = useCallback(
    (event: PointerEvent) => {
      if (!isTouchMode) return;
      const root = event.currentTarget as HTMLElement | null;
      if (!root) return;
      root.setPointerCapture(event.pointerId);

      manualTouchRef.current.pointers.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
      });

      if (manualTouchRef.current.pointers.size === 1 && longPressTimerRef.current === null) {
        longPressTimerRef.current = window.setTimeout(() => {
          if (!isTouchModeRef.current || manualTouchRef.current.pointers.size !== 1 || manualTouchRef.current.pinchHold) return;
          manualTouchRef.current.pinchHold = true;
          manualTouchRef.current.pendingPinchStart = true;
          pushManualGesture(performance.now());
          if (longPressTimerRef.current !== null) {
            window.clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
          }
        }, 280);
      }

      if (manualTouchRef.current.pointers.size >= 2) {
        const [a, b] = Array.from(manualTouchRef.current.pointers.values());
        if (Math.hypot(a.x - b.x, a.y - b.y) < 90) {
          manualTouchRef.current.pinchHold = true;
          manualTouchRef.current.pendingPinchStart = true;
        }
      }

      pushManualGesture(performance.now());
    },
    [isTouchMode, pushManualGesture]
  );

  const handlePointerMove = useCallback(
    (event: PointerEvent) => {
      if (!isTouchMode) return;
      const target = manualTouchRef.current.pointers.get(event.pointerId);
      if (!target) return;

      const dx = event.clientX - target.x;
      const dy = event.clientY - target.y;
      target.x = event.clientX;
      target.y = event.clientY;
      if (!target.moved && Math.hypot(event.clientX - target.startX, event.clientY - target.startY) > 8) {
        target.moved = true;
        if (longPressTimerRef.current !== null) {
          window.clearTimeout(longPressTimerRef.current);
          longPressTimerRef.current = null;
        }
      }

      if (manualTouchRef.current.pointers.size >= 2) {
        const [a, b] = Array.from(manualTouchRef.current.pointers.values());
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (!manualTouchRef.current.pinchHold && distance < 90) {
          manualTouchRef.current.pinchHold = true;
          manualTouchRef.current.pendingPinchStart = true;
        } else if (manualTouchRef.current.pinchHold && distance >= 105) {
          manualTouchRef.current.pinchHold = false;
          manualTouchRef.current.pendingPinchRelease = true;
        }
      } else if (manualTouchRef.current.pinchHold && (dx !== 0 || dy !== 0)) {
        manualTouchRef.current.pinchHold = false;
        manualTouchRef.current.pendingPinchRelease = true;
      }

      if (dx !== 0 || dy !== 0) {
        event.preventDefault();
        pushManualGesture(performance.now());
      }
    },
    [isTouchMode, pushManualGesture]
  );

  const handlePointerUp = useCallback(
    (event: PointerEvent) => {
      if (!isTouchMode) return;
      const removed = manualTouchRef.current.pointers.get(event.pointerId);
      if (!removed) return;

      manualTouchRef.current.pointers.delete(event.pointerId);
      manualTouchRef.current.releasePoint = { x: removed.x, y: removed.y };

      if (longPressTimerRef.current !== null) {
        window.clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }

      if (manualTouchRef.current.pinchHold && manualTouchRef.current.pointers.size === 0) {
        manualTouchRef.current.pinchHold = false;
        manualTouchRef.current.pendingPinchRelease = true;
      }

      if (manualTouchRef.current.pinchHold && manualTouchRef.current.pointers.size === 1) {
        const [remain] = Array.from(manualTouchRef.current.pointers.values());
        if (remain && remain.moved) {
          manualTouchRef.current.pinchHold = false;
          manualTouchRef.current.pendingPinchRelease = true;
        }
      }

      pushManualGesture(performance.now());
    },
    [isTouchMode, pushManualGesture]
  );

  const handlePointerCancel = useCallback(
    (event: PointerEvent) => {
      handlePointerUp(event);
    },
    [handlePointerUp]
  );

  useEffect(() => {
    isMountedRef.current = true;
    if (!sceneContainerRef.current) return;

    const scene = new ParticleScene({
      container: sceneContainerRef.current,
      quality,
      onFps: (value) => {
        if (showFpsRef.current) {
          setFps(value);
        }
      },
    });
    sceneRef.current = scene;

    const onResize = () => scene.resize();
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    startTrackLoop();

    return () => {
      isMountedRef.current = false;
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
      scene.dispose();
      stopCamera();
      trackerRef.current?.dispose();
      trackerRef.current = null;
      if (longPressTimerRef.current !== null) {
        window.clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
    };
  }, [startTrackLoop, stopCamera]);

  useEffect(() => {
    const root = sceneContainerRef.current;
    if (!root) return;

    root.addEventListener("pointerdown", handlePointerDown, { passive: false });
    root.addEventListener("pointermove", handlePointerMove, { passive: false });
    root.addEventListener("pointerup", handlePointerUp, { passive: false });
    root.addEventListener("pointercancel", handlePointerCancel, { passive: false });

    return () => {
      root.removeEventListener("pointerdown", handlePointerDown);
      root.removeEventListener("pointermove", handlePointerMove);
      root.removeEventListener("pointerup", handlePointerUp);
      root.removeEventListener("pointercancel", handlePointerCancel);
    };
  }, [handlePointerDown, handlePointerMove, handlePointerUp, handlePointerCancel]);

  useEffect(() => {
    if (isCameraRunningRef.current && trackerRef.current) {
      trackerRef.current.setMirror(facingMode === "user");
    }
  }, [facingMode]);

  useEffect(() => {
    showFpsRef.current = showFps;
  }, [showFps]);

  useEffect(() => {
    sceneRef.current?.setQuality(quality);
  }, [quality]);

  return (
    <div className="app">
      <div ref={sceneContainerRef} className="scene-wrap" />

      <div className="hud">
        <div className="title">手势控制发光粒子球</div>
        <p className="hint">请用手机浏览器打开，点击启动摄像头，伸出手掌进行交互</p>

        <div className="status-list">
          {statusList.map((text, index) => (
            <span key={`${text}-${index}`}>{text}</span>
          ))}
        </div>

        <div className="button-row">
          <button type="button" onClick={() => startCamera(facingMode)}>
            启动摄像头
          </button>
          <button type="button" onClick={switchCamera}>
            切换前/后摄像头
          </button>
          <button type="button" onClick={() => setIsPreviewVisible((prev) => !prev)}>
            {isPreviewVisible ? "隐藏预览" : "显示预览"}
          </button>
        </div>

        <div className="button-row quality-row">
          <button type="button" className={quality === "low" ? "active" : ""} onClick={() => setQuality("low")}>
            省电
          </button>
          <button type="button" className={quality === "standard" ? "active" : ""} onClick={() => setQuality("standard")}>
            标准
          </button>
          <button type="button" className={quality === "high" ? "active" : ""} onClick={() => setQuality("high")}>
            高画质
          </button>
        </div>

        <div className="button-row">
          <button type="button" onClick={() => setShowFps((prev) => !prev)}>
            {showFps ? "关闭FPS" : "显示FPS"}
          </button>
        </div>

        <div className="state-strip">
          <span>粒子: {qualityToCount(quality)}</span>
          {showFps && <span>FPS: {fps}</span>}
          <span>模式: {isTouchMode ? "触摸模式" : "摄像头模式"}</span>
        </div>
      </div>

      <video
        ref={videoRef}
        className={`camera-preview ${isPreviewVisible ? "show" : "hide"} ${facingMode === "user" ? "mirror" : ""}`}
        autoPlay
        muted
        playsInline
      />
    </div>
  );
}

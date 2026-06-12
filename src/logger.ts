export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogEntry = {
  id: number;
  time: string;
  elapsedMs: number;
  level: LogLevel;
  event: string;
  data?: unknown;
};

type Listener = (entries: LogEntry[]) => void;

const MAX_ENTRIES = 250;
const MAX_MESSAGE_LENGTH = 3600;
const startedAt = performance.now();
const sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const remoteTopic = "gesture-particle-web-wenfanzhou945-20260612";
const remoteUrl = `https://ntfy.sh/${remoteTopic}`;
const entries: LogEntry[] = [];
const listeners = new Set<Listener>();
const remoteQueue: LogEntry[] = [];
let nextId = 1;
let remoteTimer = 0;

const shouldSendRemote = (): boolean => {
  const params = new URLSearchParams(window.location.search);
  return params.get("remoteLogs") !== "0";
};

const safeJson = (value: unknown): string => {
  try {
    return JSON.stringify(value, (_key, item) => {
      if (item instanceof Error) {
        return {
          name: item.name,
          message: item.message,
          stack: item.stack,
        };
      }
      if (item instanceof MediaStreamTrack) {
        return {
          kind: item.kind,
          enabled: item.enabled,
          muted: item.muted,
          readyState: item.readyState,
          label: item.label,
          settings: item.getSettings?.(),
        };
      }
      return item;
    });
  } catch {
    return String(value);
  }
};

const compactEntry = (entry: LogEntry): string => {
  const data = entry.data === undefined ? "" : ` ${safeJson(entry.data)}`;
  return `[${entry.time}] ${sessionId} ${entry.level.toUpperCase()} ${entry.event}${data}`;
};

const notify = (): void => {
  const snapshot = [...entries];
  listeners.forEach((listener) => listener(snapshot));
};

const flushRemote = (): void => {
  remoteTimer = 0;
  if (!shouldSendRemote() || remoteQueue.length === 0) return;

  const batch = remoteQueue.splice(0, remoteQueue.length);
  let body = batch.map(compactEntry).join("\n");
  if (body.length > MAX_MESSAGE_LENGTH) {
    body = body.slice(0, MAX_MESSAGE_LENGTH - 40) + "\n...[truncated]";
  }

  fetch(remoteUrl, {
    method: "POST",
    mode: "no-cors",
    body,
  }).catch(() => {
    // Remote logging is best effort. Keep the local log as source of truth.
  });
};

const scheduleRemote = (entry: LogEntry): void => {
  remoteQueue.push(entry);
  if (remoteTimer) return;
  remoteTimer = window.setTimeout(flushRemote, 800);
};

export const getLogSessionId = (): string => sessionId;

export const getRemoteLogTopic = (): string => remoteTopic;

export const getRemoteLogStreamUrl = (): string => `https://ntfy.sh/${remoteTopic}/json`;

export const getLogText = (): string => entries.map(compactEntry).join("\n");

export const subscribeLogs = (listener: Listener): (() => void) => {
  listeners.add(listener);
  listener([...entries]);
  return () => listeners.delete(listener);
};

export const logEvent = (level: LogLevel, event: string, data?: unknown): void => {
  const entry: LogEntry = {
    id: nextId,
    time: new Date().toISOString(),
    elapsedMs: Math.round(performance.now() - startedAt),
    level,
    event,
    data,
  };
  nextId += 1;
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
  }
  notify();
  scheduleRemote(entry);

  const message = `[diagnostics] ${event}`;
  if (level === "error") console.error(message, data);
  else if (level === "warn") console.warn(message, data);
  else console.info(message, data);
};

export const installGlobalLogHandlers = (): void => {
  window.addEventListener("error", (event) => {
    logEvent("error", "window.error", {
      message: event.message,
      source: event.filename,
      line: event.lineno,
      column: event.colno,
      error: event.error,
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    logEvent("error", "window.unhandledrejection", {
      reason: event.reason,
    });
  });
};

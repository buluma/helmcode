export function isCloudDebugEnabled(): boolean {
  return (
    (typeof __DEV__ !== "undefined" && __DEV__) ||
    (typeof globalThis !== "undefined" &&
      (globalThis as { __HELMCODE_CLOUD_DEBUG__?: boolean }).__HELMCODE_CLOUD_DEBUG__ === true)
  );
}

export function cloudDebugLog(event: string, data?: Record<string, unknown>): void {
  if (!isCloudDebugEnabled()) {
    return;
  }
  if (data) {
    console.log(`[helmcode-cloud] ${event}`, data);
  } else {
    console.log(`[helmcode-cloud] ${event}`);
  }
}

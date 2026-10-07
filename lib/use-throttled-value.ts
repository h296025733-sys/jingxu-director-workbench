"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Keeps noisy browser events (notably XHR upload progress) from rerendering a
 * large page on every packet while still publishing phase changes immediately.
 */
export function useThrottledValue<T>(
  initialValue: T,
  intervalMs = 120,
): {
  value: T;
  update: (nextValue: T, immediate?: boolean) => void;
  updateNow: (nextValue: T) => void;
} {
  const [value, setValue] = useState(initialValue);
  const lastCommitAt = useRef(0);
  const pendingValue = useRef(initialValue);
  const hasPendingValue = useRef(false);
  const timer = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const updateNow = useCallback(
    (nextValue: T) => {
      clearTimer();
      pendingValue.current = nextValue;
      hasPendingValue.current = false;
      lastCommitAt.current = performance.now();
      setValue(nextValue);
    },
    [clearTimer],
  );

  const update = useCallback(
    (nextValue: T, immediate = false) => {
      pendingValue.current = nextValue;
      hasPendingValue.current = true;
      const elapsed = performance.now() - lastCommitAt.current;
      const wait = Math.max(0, intervalMs - elapsed);
      if (immediate || wait === 0) {
        updateNow(nextValue);
        return;
      }
      if (timer.current !== null) return;
      timer.current = window.setTimeout(() => {
        timer.current = null;
        if (hasPendingValue.current) updateNow(pendingValue.current);
      }, wait);
    },
    [intervalMs, updateNow],
  );

  useEffect(
    () => () => {
      clearTimer();
      hasPendingValue.current = false;
    },
    [clearTimer],
  );

  return { value, update, updateNow };
}

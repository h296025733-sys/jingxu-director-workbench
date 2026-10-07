"use client";

import { memo } from "react";
import { cn } from "@/lib/utils";

function LiveProgress({
  value,
  className,
  label = "任务进度",
}: {
  value: number;
  className?: string;
  label?: string;
}) {
  const normalizedValue = Math.max(0, Math.min(100, value));
  const visualValue = normalizedValue > 0 ? Math.max(3, normalizedValue) : 0;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(normalizedValue)}
      aria-valuetext={normalizedValue < 100 ? "正在处理" : "已完成"}
      className={cn(
        "relative h-2 w-full overflow-hidden rounded-full bg-zinc-100",
        className,
      )}
    >
      <div
        className="relative h-full w-full origin-left overflow-hidden rounded-full bg-zinc-900 transition-transform ease-out will-change-transform motion-reduce:transition-none motion-reduce:will-change-auto"
        style={{
          transform: `scaleX(${visualValue / 100})`,
          transitionDuration: "1400ms",
        }}
      >
        {normalizedValue < 100 && (
          <span className="director-progress-beam absolute inset-y-0 w-1/2 bg-gradient-to-r from-transparent via-white/55 to-transparent motion-reduce:hidden" />
        )}
      </div>
    </div>
  );
}

export default memo(LiveProgress);

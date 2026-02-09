import { useState, useEffect } from "react";

interface CooldownBannerProps {
  rateLimitUntil: string | null;
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return "0:00";
  const totalSeconds = Math.ceil(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function CooldownBanner({ rateLimitUntil }: CooldownBannerProps) {
  const [remaining, setRemaining] = useState<number>(0);

  useEffect(() => {
    if (!rateLimitUntil) {
      setRemaining(0);
      return;
    }

    const target = new Date(rateLimitUntil).getTime();

    const update = () => {
      const diff = target - Date.now();
      setRemaining(diff > 0 ? diff : 0);
    };

    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [rateLimitUntil]);

  if (!rateLimitUntil || remaining <= 0) return null;

  return (
    <div className="cooldown-banner" data-testid="cooldown-banner">
      <span className="cooldown-label">Rate limited</span>
      <span className="cooldown-time" data-testid="cooldown-time">
        {formatRemaining(remaining)}
      </span>
    </div>
  );
}

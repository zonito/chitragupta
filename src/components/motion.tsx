import { useEffect, useRef, useState, type CSSProperties } from "react";
import { gbp } from "@/lib/data";

/** Two frames let the browser paint zero width before the mount transition. */
export function AnimatedBar({ percent, className = "bg-primary", colour, delay = 0 }: { percent: number; className?: string; colour?: string; delay?: number }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let second = 0;
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => setReady(true)); });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, []);
  return <div className={`data-bar h-full rounded-lg ${className}`} style={{ "--bar-width": `${Math.min(100, Math.max(0, percent))}%`, width: ready ? "var(--bar-width)" : "0%", backgroundColor: colour, transitionDelay: `${delay}ms` } as CSSProperties} />;
}

/** Keep SSR text final; animate once after mount, never on person changes. */
export function CountUpMoney({ value, pence = false }: { value: number; pence?: boolean }) {
  const [display, setDisplay] = useState<number | null>(null);
  const initial = useRef(value);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (media.matches) return;
    let frame = 0;
    let start: number | null = null;
    const finish = () => { cancelAnimationFrame(frame); setDisplay(null); };
    const tick = (time: number) => {
      start ??= time;
      const progress = Math.min((time - start) / 600, 1);
      if (progress === 1 || media.matches) { setDisplay(null); return; }
      setDisplay(initial.current * (1 - Math.pow(1 - progress, 3)));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    media.addEventListener("change", finish);
    return () => { cancelAnimationFrame(frame); media.removeEventListener("change", finish); };
  }, []);
  const shown = value === initial.current ? display ?? value : value;
  return <><span aria-hidden="true" className="motion-number">{gbp(shown, pence)}</span><span className="sr-only">{gbp(value, pence)}</span><span className="reduced-number" aria-hidden="true">{gbp(value, pence)}</span></>;
}

/** Instant new result with stationary text; only count-ups replace digits. */
export function SettlingValue({ value, format = gbp }: { value: number | null; format?: (value: number) => string }) {
  return <span className="num inline-block">{value === null ? "—" : format(value)}</span>;
}
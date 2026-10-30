type LogoProps = {
  size?: number;
  mono?: boolean;
  className?: string;
};

/** Decorative beside the visible app name; mono inherits the surrounding colour. */
export function Logo({ size = 28, mono = false, className = "" }: LogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" className={`shrink-0 ${className}`}>
      <g className={mono ? "" : "text-primary"} stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round">
        <path d="M16 8C12 5 7 5 3 6V25C7 24 12 24 16 27C20 24 25 24 29 25V6C25 5 20 5 16 8Z" />
        <path d="M16 8V27" />
      </g>
      <path className={mono ? "" : "text-accent"} fill="currentColor" d="M20 21L21 16L28 7C28.7 6.1 30 6 30.8 6.7C31.6 7.3 31.7 8.5 31 9.4L24 18.5Z" />
    </svg>
  );
}
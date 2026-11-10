export function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="7" fill="#16245A" />
      <path
        d="M6 21c3-1 4-9 6-9s1 8 3 8 3-6 5-6 2 4 6 3"
        fill="none"
        stroke="#fff"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="4.5" y="8.5" width="23" height="16" rx="1.5" fill="none" stroke="#D6245F" strokeWidth="1.6" strokeDasharray="3 2" />
    </svg>
  );
}

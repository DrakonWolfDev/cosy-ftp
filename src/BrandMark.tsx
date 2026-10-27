export function BrandMark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <rect x="2" y="5" width="10" height="22" rx="3" stroke="currentColor" strokeWidth="2" />
      <rect x="20" y="5" width="10" height="22" rx="3" stroke="currentColor" strokeWidth="2" />
      <path
        d="M8 12h16m-4-4 4 4-4 4M24 21H8m4-4-4 4 4 4"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

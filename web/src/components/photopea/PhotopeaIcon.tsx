/** Compact mark for the Open in Photopea action. */
export function PhotopeaIcon({ className = 'photopea-icon' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="1.5" y="1.5" width="13" height="13" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M4.5 10.5 7 6.5l2 2.5 1.2-1.6 1.3 3.1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="5.4" cy="5.1" r="1" fill="currentColor" />
    </svg>
  )
}

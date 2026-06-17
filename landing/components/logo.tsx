/* The real Forge app-icon mark — ember tile, paper forge glyph, brown stroke.
   Mirrors app/icon.svg and public/brand/forge-app-icon-v2-ember.svg from the
   main repo. Inlined (no HTTP request) and theme-independent, like a real logo. */
export function Logo({ size = 22, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 256 256"
      role="img"
      aria-label="Forge"
      className={className}
      style={{ display: "block", flexShrink: 0 }}
    >
      <rect width="256" height="256" rx="48" fill="#d97706" />
      <path
        d="M 48 96 H 116 V 106 H 218 L 203 138 H 168 C 154 138 146 146 146 158 C 146 172 160 184 178 192 V 210 H 78 V 194 C 101 184 116 169 116 158 C 116 146 108 138 96 138 C 68 138 49 120 48 96 Z"
        fill="#fef3e6"
      />
      <path d="M 125 58 H 196 L 178 88 H 112 Z" fill="#78350f" />
    </svg>
  );
}

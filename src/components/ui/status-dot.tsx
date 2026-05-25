/**
 * StatusDot — category-aware status glyph (design `forge-primitives` StatusDot).
 *
 * Renders Linear/Forge-convention geometry per status category instead of a
 * flat colored dot: backlog = hollow dashed, todo = hollow ring,
 * in-progress = half-fill, in-review = inner translucent fill, done = filled +
 * check, blocked = filled + diagonal, canceled = filled + line. Color comes
 * from the workspace status row (`status.color`).
 */

export type StatusDotStatus = {
  category: string;
  color: string;
};

export function StatusDot({
  status,
  size = 12,
  className = "",
}: {
  status: StatusDotStatus | null | undefined;
  size?: number;
  className?: string;
}) {
  if (!status) return null;
  const cat = status.category;
  const s = size;
  const r = s / 2 - 1;
  const cx = s / 2;
  const cy = s / 2;
  const c = status.color || "currentColor";

  let inner: React.ReactNode;
  if (cat === "BACKLOG") {
    inner = (
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill="none"
        stroke={c}
        strokeWidth="1.2"
        strokeDasharray="1.6 1.4"
      />
    );
  } else if (cat === "TODO") {
    inner = <circle cx={cx} cy={cy} r={r} fill="none" stroke={c} strokeWidth="1.4" />;
  } else if (cat === "IN_PROGRESS") {
    inner = (
      <>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={c} strokeWidth="1.4" />
        <path
          d={`M ${cx} ${cy - r} A ${r} ${r} 0 0 1 ${cx} ${cy + r} Z`}
          fill={c}
        />
      </>
    );
  } else if (cat === "IN_REVIEW") {
    inner = (
      <>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={c} strokeWidth="1.4" />
        <circle cx={cx} cy={cy} r={r - 2} fill={c} fillOpacity="0.55" />
      </>
    );
  } else if (cat === "DONE") {
    inner = (
      <>
        <circle cx={cx} cy={cy} r={r + 0.5} fill={c} />
        <path
          d={`M ${cx - r * 0.55} ${cy} L ${cx - r * 0.05} ${cy + r * 0.45} L ${cx + r * 0.6} ${cy - r * 0.35}`}
          stroke="#fff"
          strokeWidth="1.4"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </>
    );
  } else if (cat === "BLOCKED") {
    inner = (
      <>
        <circle cx={cx} cy={cy} r={r + 0.5} fill={c} />
        <path
          d={`M ${cx - r * 0.45} ${cy - r * 0.45} L ${cx + r * 0.45} ${cy + r * 0.45}`}
          stroke="#fff"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </>
    );
  } else {
    // CANCELED
    inner = (
      <>
        <circle cx={cx} cy={cy} r={r + 0.5} fill={c} />
        <path
          d={`M ${cx - r * 0.45} ${cy} L ${cx + r * 0.45} ${cy}`}
          stroke="#fff"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </>
    );
  }

  return (
    <svg
      width={s}
      height={s}
      viewBox={`0 0 ${s} ${s}`}
      className={className}
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      {inner}
    </svg>
  );
}

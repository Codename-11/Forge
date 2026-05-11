import { ImageResponse } from "next/og";

export const runtime = "nodejs";
export const alt = "Forge — keyboard-driven project management, extensible via agents.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OgImage() {
  const mark = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
      <rect width="256" height="256" rx="48" fill="#d97706"/>
      <path d="M 12 114 L 32 90 L 196 90 L 220 74 L 220 116 L 200 116 L 200 104 L 160 104 L 160 176 L 196 176 L 220 198 L 36 198 L 60 176 L 96 176 L 96 104 L 32 104 Z" fill="#fef3e6"/>
    </svg>
  `;
  const dataUri = `data:image/svg+xml;base64,${Buffer.from(mark).toString("base64")}`;
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px",
          background: "linear-gradient(135deg, #292524 0%, #1c1917 100%)",
          color: "#fef3e6",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          <img src={dataUri} width={96} height={96} alt="" />
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 64, fontWeight: 600, letterSpacing: -1, display: "flex" }}>
              Forge
            </div>
            <div style={{ fontSize: 22, color: "#a8a29e", marginTop: 4, display: "flex" }}>
              Project management for humans and agents.
            </div>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div
            style={{
              fontSize: 52,
              fontWeight: 600,
              letterSpacing: -1,
              lineHeight: 1.1,
              display: "flex",
            }}
          >
            Fast. Keyboard-driven.
          </div>
          <div
            style={{
              fontSize: 52,
              fontWeight: 600,
              letterSpacing: -1,
              lineHeight: 1.1,
              display: "flex",
            }}
          >
            Extensible via MCP.
          </div>
          <div
            style={{
              display: "flex",
              gap: 16,
              fontSize: 18,
              color: "#d6d3d1",
              fontFamily: "ui-monospace, Menlo, monospace",
            }}
          >
            <span>Next.js</span>
            <span>·</span>
            <span>tRPC</span>
            <span>·</span>
            <span>Prisma</span>
            <span>·</span>
            <span>MCP</span>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: 16,
            color: "#a8a29e",
            fontFamily: "ui-monospace, Menlo, monospace",
          }}
        >
          <span>forge.axiom-labs.dev</span>
          <span style={{ color: "#d97706" }}>Axiom Labs</span>
        </div>
      </div>
    ),
    { ...size },
  );
}

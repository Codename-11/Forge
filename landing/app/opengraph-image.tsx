import { ImageResponse } from "next/og";

// Social card for the landing site — real Forge mark + brand, landing copy.
// Generated at build time (static export) into out/opengraph-image.png.
export const runtime = "nodejs";
export const dynamic = "force-static";
export const alt = "Forge — issue tracking for humans & agents.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OgImage() {
  // The real Forge app-icon mark (ember tile + paper forge glyph + brown stroke).
  const mark = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
      <rect width="256" height="256" rx="48" fill="#d97706"/>
      <path d="M 48 96 H 116 V 106 H 218 L 203 138 H 168 C 154 138 146 146 146 158 C 146 172 160 184 178 192 V 210 H 78 V 194 C 101 184 116 169 116 158 C 116 146 108 138 96 138 C 68 138 49 120 48 96 Z" fill="#fef3e6"/>
      <path d="M 125 58 H 196 L 178 88 H 112 Z" fill="#78350f"/>
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
        <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
          <img src={dataUri} width={84} height={84} alt="" />
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 56, fontWeight: 600, letterSpacing: -1, display: "flex" }}>Forge</div>
            <div style={{ fontSize: 22, color: "#a8a29e", marginTop: 2, display: "flex" }}>
              Issue tracking for humans &amp; agents.
            </div>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ fontSize: 80, fontWeight: 600, letterSpacing: -2, lineHeight: 1.02, display: "flex" }}>
            Built for the handoff.
          </div>
          <div style={{ fontSize: 30, color: "#d6d3d1", lineHeight: 1.3, display: "flex", maxWidth: 900 }}>
            Humans file, agents pick up, humans review — same issues, same plans, same keyboard.
          </div>
          <div
            style={{
              display: "flex",
              gap: 16,
              marginTop: 8,
              fontSize: 20,
              color: "#d97706",
              fontFamily: "ui-monospace, Menlo, monospace",
            }}
          >
            <span>Self-host</span>
            <span style={{ color: "#57534e" }}>·</span>
            <span>MCP-native</span>
            <span style={{ color: "#57534e" }}>·</span>
            <span>Open-source</span>
            <span style={{ color: "#57534e" }}>·</span>
            <span>MIT</span>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: 18,
            color: "#a8a29e",
            fontFamily: "ui-monospace, Menlo, monospace",
          }}
        >
          <span>forge-pm.dev</span>
          <span style={{ color: "#d97706" }}>github.com/Codename-11/forge</span>
        </div>
      </div>
    ),
    { ...size },
  );
}

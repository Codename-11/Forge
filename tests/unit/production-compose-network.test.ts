import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const compose = readFileSync(
  resolve(process.cwd(), "docker/docker-compose.production.example.yml"),
  "utf8",
);

function serviceBlock(name: string, nextName: string): string {
  const start = compose.indexOf(`  ${name}:`);
  const marker = nextName === "networks" ? "\nnetworks:" : `\n  ${nextName}:`;
  return compose.slice(start, compose.indexOf(marker, start + 1));
}

describe("reference production Compose runtime networking", () => {
  it("gives the worker outbound egress without proxy membership or published ports", () => {
    const worker = serviceBlock("forge-worker", "networks");
    expect(worker).toContain("networks: [forge-data, forge-egress]");
    expect(worker).not.toContain("forge-proxy");
    expect(worker).not.toMatch(/^\s+ports:/m);
    expect(worker).not.toMatch(/^\s+expose:/m);
  });

  it("keeps data isolated while the dedicated egress network is non-internal", () => {
    expect(compose).toMatch(/forge-data:\s*\n\s+internal: true/);
    expect(compose).toMatch(/forge-egress:\s*\n(?:\s+#.*\n)*\s+driver: bridge/);
    expect(compose).not.toMatch(/forge-egress:\s*\n(?:\s+#.*\n)*\s+internal: true/);
  });

  it("allows only the web app onto the public proxy network", () => {
    const app = serviceBlock("forge", "forge-worker");
    expect(app).toContain("networks: [forge-data, forge-egress, forge-proxy]");
    expect(app).toContain('expose: ["3000"]');
  });
});

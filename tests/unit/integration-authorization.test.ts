import { describe, expect, it } from "vitest";
import { IntegrationCapability } from "@prisma/client";
import {
  connectionAuthorizationDigest,
  integrationDirectionAllows,
  integrationPrincipalFromContext,
  integrationRequiredCapabilities,
} from "@/server/services/integration-authorization";

describe("integration authorization primitives", () => {
  it("requires exact capabilities instead of treating admin as a data bypass", () => {
    expect(integrationRequiredCapabilities(IntegrationCapability.LINK)).toEqual([
      IntegrationCapability.READ,
      IntegrationCapability.LINK,
    ]);
    expect(integrationRequiredCapabilities(IntegrationCapability.SYNC)).toEqual([
      IntegrationCapability.READ,
      IntegrationCapability.SYNC,
    ]);
    expect(integrationRequiredCapabilities(IntegrationCapability.ADMIN)).toEqual([
      IntegrationCapability.ADMIN,
    ]);
  });

  it("keeps inbound provider reads separate from outbound writes", () => {
    expect(integrationDirectionAllows("inbound", IntegrationCapability.READ)).toBe(true);
    expect(integrationDirectionAllows("outbound", IntegrationCapability.READ)).toBe(false);
    expect(integrationDirectionAllows("inbound", IntegrationCapability.WRITE)).toBe(false);
    expect(integrationDirectionAllows("outbound", IntegrationCapability.WRITE)).toBe(true);
    expect(integrationDirectionAllows("inbound+outbound", IntegrationCapability.SYNC)).toBe(true);
  });

  it("digests security fields deterministically and invalidates widened policy", () => {
    const mapping = {
      connectionId: "connection-1",
      kind: "repo",
      target: "Codename-11/Forge",
      direction: "inbound+outbound",
      labelIds: ["label-b", "label-a"],
      routeTo: "Issue",
      config: { github: { syncTitle: true, filters: { z: 1, a: 2 } } },
    };
    const reordered = {
      ...mapping,
      target: "codename-11/forge",
      labelIds: ["label-a", "label-b"],
      config: { github: { filters: { a: 2, z: 1 }, syncTitle: true } },
    };
    expect(connectionAuthorizationDigest(mapping)).toBe(connectionAuthorizationDigest(reordered));
    expect(connectionAuthorizationDigest({ ...mapping, direction: "outbound" })).not.toBe(
      connectionAuthorizationDigest(mapping),
    );
  });

  it("resolves the exact MCP principal without falling back to an arbitrary user", () => {
    expect(
      integrationPrincipalFromContext({
        userId: "issuer-user",
        apiKey: { keyId: "key-1", linkedAgentId: "agent-1" },
      }),
    ).toEqual({ type: "AGENT", agentId: "agent-1", apiKeyId: "key-1" });
    expect(
      integrationPrincipalFromContext({
        userId: "issuer-user",
        apiKey: { keyId: "key-2", linkedAgentId: null },
      }),
    ).toEqual({ type: "API_KEY", apiKeyId: "key-2" });
    expect(() => integrationPrincipalFromContext({ userId: null, apiKey: null })).toThrow(
      /exact integration principal/i,
    );
  });
});

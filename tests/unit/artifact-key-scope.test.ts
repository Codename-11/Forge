import { describe, expect, it } from "vitest";
import {
  buildArtifactKeyScopeWhere,
  hasApiKeyNarrowing,
  type ApiKeyContext,
} from "@/server/services/api-key-auth";

function key(overrides: Partial<ApiKeyContext> = {}): ApiKeyContext {
  return {
    keyId: "key",
    workspaceId: "workspace",
    userId: null,
    pluginId: null,
    scopes: [],
    projectIds: [],
    labelIds: [],
    initiativeIds: [],
    linkedAgentId: null,
    ...overrides,
  };
}

describe("artifact API-key narrowing", () => {
  it("leaves unrestricted keys unchanged", () => {
    const ctx = { apiKey: key() };
    expect(hasApiKeyNarrowing(ctx)).toBe(false);
    expect(buildArtifactKeyScopeWhere(ctx)).toEqual({});
  });

  it("derives artifact access from issue, project, and initiative anchors", () => {
    const where = buildArtifactKeyScopeWhere({
      apiKey: key({
        projectIds: ["project-1"],
        labelIds: ["label-1"],
        initiativeIds: ["initiative-1"],
      }),
    });
    expect(where).toEqual({
      OR: [
        {
          issue: {
            is: {
              OR: [
                { projectId: { in: ["project-1"] } },
                { labels: { some: { labelId: { in: ["label-1"] } } } },
                { project: { initiativeId: { in: ["initiative-1"] } } },
              ],
            },
          },
        },
        { projectId: { in: ["project-1"] } },
        { project: { is: { initiativeId: { in: ["initiative-1"] } } } },
      ],
    });
  });

  it("does not let label-only keys reach standalone or project-only artifacts", () => {
    expect(buildArtifactKeyScopeWhere({ apiKey: key({ labelIds: ["label-1"] }) })).toEqual({
      OR: [
        {
          issue: {
            is: { labels: { some: { labelId: { in: ["label-1"] } } } },
          },
        },
      ],
    });
  });
});

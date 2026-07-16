import { describe, expect, it } from "vitest";
import { ArtifactContentType } from "@prisma/client";
import { artifactActorReadWhere } from "@/server/services/artifact-access";
import {
  checksumArtifactContent,
  hashPublicationToken,
  issuePublicationToken,
} from "@/server/services/artifact-studio";

describe("artifact studio contracts", () => {
  it("builds actor visibility without exposing private ungranted artifacts", () => {
    expect(
      artifactActorReadWhere({
        workspaceId: "workspace-1",
        userId: "user-1",
        agentId: "agent-1",
      }),
    ).toEqual({
      workspaceId: "workspace-1",
      OR: [
        { visibility: "WORKSPACE" },
        { createdById: "user-1" },
        { grants: { some: { userId: "user-1" } } },
        { createdByAgentId: "agent-1" },
        { grants: { some: { agentId: "agent-1" } } },
      ],
    });
  });

  it("checksums the complete rendering contract deterministically", () => {
    const input = {
      title: "Decision",
      body: "# Ship it",
      summary: "Accepted direction",
      contentType: ArtifactContentType.MARKDOWN,
    };
    expect(checksumArtifactContent(input)).toBe(checksumArtifactContent(input));
    expect(checksumArtifactContent({ ...input, body: "# Do not ship" })).not.toBe(
      checksumArtifactContent(input),
    );
    expect(checksumArtifactContent({ ...input, contentType: ArtifactContentType.TEXT })).not.toBe(
      checksumArtifactContent(input),
    );
  });

  it("returns publication secrets once while persisting only a hash", () => {
    const issued = issuePublicationToken();
    expect(issued.raw).toMatch(/^forge_art_[0-9a-f]{8}_[A-Za-z0-9_-]+$/);
    expect(issued.raw).toContain(issued.prefix);
    expect(issued.hash).toBe(hashPublicationToken(issued.raw));
    expect(issued.hash).not.toContain(issued.raw);
    expect(issuePublicationToken().raw).not.toBe(issued.raw);
  });
});

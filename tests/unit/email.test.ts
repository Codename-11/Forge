import { afterEach, describe, expect, it } from "vitest";
import {
  buildAccountSetupEmail,
  buildPasswordChangedEmail,
  buildPasswordResetEmail,
  sendPasswordResetEmail,
  sendWorkspaceInviteEmail,
  type TransactionalEmail,
} from "@/server/services/email";

const expiresAt = new Date("2026-08-25T20:00:00.000Z");

afterEach(() => {
  delete process.env.FORGE_EMAIL_TEST_FAILURE;
});

describe("transactional email", () => {
  it("renders account setup links and escapes user-controlled HTML", () => {
    const email = buildAccountSetupEmail({
      to: "new@example.com",
      name: "<Bailey>",
      url: "https://forge.example/setup?token=a&next=b",
      expiresAt,
    });

    expect(email.kind).toBe("account-setup");
    expect(email.text).toContain("https://forge.example/setup?token=a&next=b");
    expect(email.html).toContain("&lt;Bailey&gt;");
    expect(email.html).toContain("token=a&amp;next=b");
    expect(email.html).not.toContain("<Bailey>");
  });

  it("removes line breaks from invitation subject fields", async () => {
    let delivered: TransactionalEmail | undefined;
    await sendWorkspaceInviteEmail(
      {
        to: "member@example.com",
        inviteUrl: "https://forge.example/invite/token",
        workspaceName: "Forge\r\nBcc: attacker@example.com",
        inviterName: "Bailey\nInjected",
        expiresAt,
      },
      {
        transport: async (message) => {
          delivered = message;
          return "captured-message";
        },
      },
    );

    expect(delivered?.subject).toBe(
      "Bailey Injected invited you to Forge Bcc: attacker@example.com on Forge",
    );
    expect(delivered?.subject).not.toMatch(/[\r\n]/);
  });

  it("renders a reset message without claiming the password already changed", () => {
    const email = buildPasswordResetEmail({
      to: "member@example.com",
      url: "https://forge.example/reset/token",
      expiresAt,
    });

    expect(email.subject).toBe("Reset your Forge password");
    expect(email.text).toContain("single-use link");
    expect(email.text).toContain("Your password has not changed");
  });

  it("renders a password-change security notification without a secret link", () => {
    const email = buildPasswordChangedEmail({
      to: "member@example.com",
      changedAt: new Date("2026-08-25T19:00:00.000Z"),
    });

    expect(email.kind).toBe("password-changed");
    expect(email.text).toContain("2026-08-25T19:00:00.000Z");
    expect(email.text).toContain("contact your Forge instance administrator immediately");
    expect(email.text).not.toMatch(/https?:\/\//);
  });

  it("passes the fully rendered message to an injected transport", async () => {
    let delivered: TransactionalEmail | undefined;
    const messageId = await sendPasswordResetEmail(
      {
        to: "member@example.com",
        url: "https://forge.example/reset/token",
        expiresAt,
      },
      {
        transport: async (message) => {
          delivered = message;
          return "captured-message";
        },
      },
    );

    expect(messageId).toBe("captured-message");
    expect(delivered).toMatchObject({ kind: "password-reset", to: "member@example.com" });
  });

  it("keeps existing invitation test delivery behavior", async () => {
    const messageId = await sendWorkspaceInviteEmail({
      to: "member@example.com",
      inviteUrl: "https://forge.example/invite/token",
      workspaceName: "Forge",
      inviterName: "Bailey",
      expiresAt,
    });

    expect(messageId).toBe("test-workspace-invite");
  });

  it("keeps the invitation failure contract used by integration tests", async () => {
    process.env.FORGE_EMAIL_TEST_FAILURE = "1";

    await expect(
      sendWorkspaceInviteEmail({
        to: "member@example.com",
        inviteUrl: "https://forge.example/invite/token",
        workspaceName: "Forge",
        inviterName: "Bailey",
        expiresAt,
      }),
    ).rejects.toThrow("Forced invitation delivery failure.");
  });
});

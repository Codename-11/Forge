import "server-only";
import nodemailer from "nodemailer";

export type WorkspaceInviteEmail = {
  to: string;
  inviteUrl: string;
  workspaceName: string;
  inviterName: string;
  expiresAt: Date;
  note?: string | null;
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[char] ?? char;
  });
}

function fromAddress(): string {
  return process.env.EMAIL_FROM?.trim() || "Forge <no-reply@localhost>";
}

function smtpTransport() {
  const serverUrl = process.env.EMAIL_SERVER?.trim();
  if (serverUrl) return nodemailer.createTransport(serverUrl);
  const host = process.env.SMTP_HOST?.trim();
  if (!host) return null;
  const port = Number(process.env.SMTP_PORT || 587);
  return nodemailer.createTransport({
    host,
    port,
    secure: process.env.SMTP_SECURE === "true" || port === 465,
    ...(process.env.SMTP_USER
      ? {
          auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASSWORD ?? "",
          },
        }
      : {}),
  });
}

/**
 * Deliver a workspace invitation through SMTP or Resend. Tests use a
 * deterministic no-network transport; production fails closed when no provider
 * is configured so the UI never claims an email was sent when it was not.
 */
export async function sendWorkspaceInviteEmail(input: WorkspaceInviteEmail): Promise<string> {
  if (process.env.NODE_ENV === "test") {
    if (process.env.FORGE_EMAIL_TEST_FAILURE === "1") {
      throw new Error("Forced invitation delivery failure.");
    }
    return "test-workspace-invite";
  }

  const subject = `${input.inviterName} invited you to ${input.workspaceName} on Forge`;
  const note = input.note?.trim();
  const text = [
    `${input.inviterName} invited you to join ${input.workspaceName} on Forge.`,
    note ? `\n${note}` : "",
    `\nAccept the invitation: ${input.inviteUrl}`,
    `\nThis secure link expires ${input.expiresAt.toISOString()}.`,
    "If you already use Forge, sign in with that account. Otherwise, continue with your configured identity provider to create an account.",
  ]
    .filter(Boolean)
    .join("\n");
  const html = `
    <div style="font-family:ui-sans-serif,system-ui,sans-serif;line-height:1.55;color:#292524">
      <h2 style="margin:0 0 12px">Join ${escapeHtml(input.workspaceName)} on Forge</h2>
      <p>${escapeHtml(input.inviterName)} invited you to this workspace.</p>
      ${note ? `<blockquote style="margin:16px 0;padding:12px 16px;border-left:3px solid #d97706;background:#fafaf9">${escapeHtml(note).replace(/\n/g, "<br>")}</blockquote>` : ""}
      <p><a href="${escapeHtml(input.inviteUrl)}" style="display:inline-block;padding:10px 16px;border-radius:6px;background:#d97706;color:#fff;text-decoration:none">Accept invitation</a></p>
      <p style="font-size:12px;color:#78716c">This single-use link expires ${escapeHtml(input.expiresAt.toUTCString())}. Sign in with an existing Forge account, or continue with your configured identity provider to create one.</p>
    </div>`;

  const smtp = smtpTransport();
  if (smtp) {
    const result = await smtp.sendMail({ from: fromAddress(), to: input.to, subject, text, html });
    return result.messageId;
  }

  const resendKey = process.env.RESEND_API_KEY?.trim();
  if (resendKey) {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: fromAddress(), to: [input.to], subject, text, html }),
    });
    if (!response.ok) {
      throw new Error(`Resend rejected the invitation email (${response.status}).`);
    }
    const body = (await response.json()) as { id?: string };
    return body.id ?? "resend-accepted";
  }

  throw new Error(
    "Outgoing email is not configured. Set EMAIL_SERVER or SMTP_HOST (and SMTP credentials), or RESEND_API_KEY, plus EMAIL_FROM.",
  );
}

import "server-only";
import nodemailer from "nodemailer";

export type TransactionalEmailKind =
  | "workspace-invite"
  | "account-setup"
  | "password-reset"
  | "password-changed";

export type TransactionalEmail = {
  kind: TransactionalEmailKind;
  to: string;
  subject: string;
  text: string;
  html: string;
};

export type TransactionalEmailTransport = (message: TransactionalEmail) => Promise<string>;

export type EmailDeliveryOptions = {
  /** Narrow injection seam for template/delivery tests; production omits it. */
  transport?: TransactionalEmailTransport;
};

export type WorkspaceInviteEmail = {
  to: string;
  inviteUrl: string;
  workspaceName: string;
  inviterName: string;
  expiresAt: Date;
  note?: string | null;
};

export type AccountSetupEmail = {
  to: string;
  url: string;
  expiresAt: Date;
  name?: string | null;
};

export type PasswordResetEmail = {
  to: string;
  url: string;
  expiresAt: Date;
  name?: string | null;
};

export type PasswordChangedEmail = {
  to: string;
  changedAt: Date;
  name?: string | null;
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

function headerText(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
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

function testFailureMessage(kind: TransactionalEmailKind): string {
  return kind === "workspace-invite"
    ? "Forced invitation delivery failure."
    : `Forced ${kind.replaceAll("-", " ")} delivery failure.`;
}

/**
 * Deliver one fully rendered transactional email through an injected test
 * transport, SMTP, or Resend. Test mode is deterministic and network-free;
 * non-test environments fail closed when no provider is configured.
 */
export async function sendTransactionalEmail(
  message: TransactionalEmail,
  options: EmailDeliveryOptions = {},
): Promise<string> {
  if (options.transport) return options.transport(message);

  if (process.env.NODE_ENV === "test" || process.env.FORGE_E2E === "1") {
    if (process.env.FORGE_EMAIL_TEST_FAILURE === "1") {
      throw new Error(testFailureMessage(message.kind));
    }
    return `test-${message.kind}`;
  }

  const smtp = smtpTransport();
  if (smtp) {
    const result = await smtp.sendMail({
      from: fromAddress(),
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
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
      body: JSON.stringify({
        from: fromAddress(),
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
    });
    if (!response.ok) {
      throw new Error(`Resend rejected the email (${response.status}).`);
    }
    const body = (await response.json()) as { id?: string };
    return body.id ?? "resend-accepted";
  }

  throw new Error(
    "Outgoing email is not configured. Set EMAIL_SERVER or SMTP_HOST (and SMTP credentials), or RESEND_API_KEY, plus EMAIL_FROM.",
  );
}

export function buildWorkspaceInviteEmail(input: WorkspaceInviteEmail): TransactionalEmail {
  const note = input.note?.trim();
  const subject = `${headerText(input.inviterName)} invited you to ${headerText(input.workspaceName)} on Forge`;
  const text = [
    `${input.inviterName} invited you to join ${input.workspaceName} on Forge.`,
    note ? `\n${note}` : "",
    `\nAccept the invitation: ${input.inviteUrl}`,
    `\nThis secure link expires ${input.expiresAt.toISOString()}.`,
    "If you already use Forge, sign in with that account. Otherwise, use an identity method enabled by the instance administrator.",
  ]
    .filter(Boolean)
    .join("\n");
  const html = `
    <div style="font-family:ui-sans-serif,system-ui,sans-serif;line-height:1.55;color:#292524">
      <h2 style="margin:0 0 12px">Join ${escapeHtml(input.workspaceName)} on Forge</h2>
      <p>${escapeHtml(input.inviterName)} invited you to this workspace.</p>
      ${note ? `<blockquote style="margin:16px 0;padding:12px 16px;border-left:3px solid #d97706;background:#fafaf9">${escapeHtml(note).replace(/\n/g, "<br>")}</blockquote>` : ""}
      <p><a href="${escapeHtml(input.inviteUrl)}" style="display:inline-block;padding:10px 16px;border-radius:6px;background:#d97706;color:#fff;text-decoration:none">Accept invitation</a></p>
      <p style="font-size:12px;color:#78716c">This single-use link expires ${escapeHtml(input.expiresAt.toUTCString())}. Sign in with an existing Forge account, or use an identity method enabled by the instance administrator.</p>
    </div>`;
  return { kind: "workspace-invite", to: input.to, subject, text, html };
}

export function buildAccountSetupEmail(input: AccountSetupEmail): TransactionalEmail {
  const greeting = input.name?.trim() ? `Hi ${input.name.trim()},` : "Hello,";
  const subject = "Set up your Forge account";
  const text = [
    greeting,
    "An instance administrator created a Forge account for this email address.",
    `Set your password: ${input.url}`,
    `This single-use link expires ${input.expiresAt.toISOString()}.`,
    "If you were not expecting this invitation, you can ignore this email.",
  ].join("\n\n");
  const html = `
    <div style="font-family:ui-sans-serif,system-ui,sans-serif;line-height:1.55;color:#292524">
      <h2 style="margin:0 0 12px">Set up your Forge account</h2>
      <p>${escapeHtml(greeting)}</p>
      <p>An instance administrator created a Forge account for this email address.</p>
      <p><a href="${escapeHtml(input.url)}" style="display:inline-block;padding:10px 16px;border-radius:6px;background:#d97706;color:#fff;text-decoration:none">Set password</a></p>
      <p style="font-size:12px;color:#78716c">This single-use link expires ${escapeHtml(input.expiresAt.toUTCString())}. If you were not expecting this invitation, you can ignore this email.</p>
    </div>`;
  return { kind: "account-setup", to: input.to, subject, text, html };
}

export function buildPasswordResetEmail(input: PasswordResetEmail): TransactionalEmail {
  const greeting = input.name?.trim() ? `Hi ${input.name.trim()},` : "Hello,";
  const subject = "Reset your Forge password";
  const text = [
    greeting,
    "A password reset was requested for your Forge account.",
    `Reset your password: ${input.url}`,
    `This single-use link expires ${input.expiresAt.toISOString()}.`,
    "If you did not request this reset, you can ignore this email. Your password has not changed.",
  ].join("\n\n");
  const html = `
    <div style="font-family:ui-sans-serif,system-ui,sans-serif;line-height:1.55;color:#292524">
      <h2 style="margin:0 0 12px">Reset your Forge password</h2>
      <p>${escapeHtml(greeting)}</p>
      <p>A password reset was requested for your Forge account.</p>
      <p><a href="${escapeHtml(input.url)}" style="display:inline-block;padding:10px 16px;border-radius:6px;background:#d97706;color:#fff;text-decoration:none">Reset password</a></p>
      <p style="font-size:12px;color:#78716c">This single-use link expires ${escapeHtml(input.expiresAt.toUTCString())}. If you did not request this reset, you can ignore this email. Your password has not changed.</p>
    </div>`;
  return { kind: "password-reset", to: input.to, subject, text, html };
}

export function buildPasswordChangedEmail(input: PasswordChangedEmail): TransactionalEmail {
  const greeting = input.name?.trim() ? `Hi ${input.name.trim()},` : "Hello,";
  const subject = "Your Forge password was changed";
  const changedAt = input.changedAt.toISOString();
  const text = [
    greeting,
    `The password for your Forge account was changed at ${changedAt}.`,
    "If you did not make this change, contact your Forge instance administrator immediately.",
  ].join("\n\n");
  const html = `
    <div style="font-family:ui-sans-serif,system-ui,sans-serif;line-height:1.55;color:#292524">
      <h2 style="margin:0 0 12px">Your Forge password was changed</h2>
      <p>${escapeHtml(greeting)}</p>
      <p>The password for your Forge account was changed at ${escapeHtml(input.changedAt.toUTCString())}.</p>
      <p>If you did not make this change, contact your Forge instance administrator immediately.</p>
    </div>`;
  return { kind: "password-changed", to: input.to, subject, text, html };
}

export function sendWorkspaceInviteEmail(
  input: WorkspaceInviteEmail,
  options?: EmailDeliveryOptions,
): Promise<string> {
  return sendTransactionalEmail(buildWorkspaceInviteEmail(input), options);
}

export function sendAccountSetupEmail(
  input: AccountSetupEmail,
  options?: EmailDeliveryOptions,
): Promise<string> {
  return sendTransactionalEmail(buildAccountSetupEmail(input), options);
}

export function sendPasswordResetEmail(
  input: PasswordResetEmail,
  options?: EmailDeliveryOptions,
): Promise<string> {
  return sendTransactionalEmail(buildPasswordResetEmail(input), options);
}

export function sendPasswordChangedEmail(
  input: PasswordChangedEmail,
  options?: EmailDeliveryOptions,
): Promise<string> {
  return sendTransactionalEmail(buildPasswordChangedEmail(input), options);
}

import "server-only";
import type {
  AuthenticationMode,
  InstanceAuthPolicy,
  RegistrationMode,
  SsoProvider,
} from "@prisma/client";
import { db } from "@/server/db";

export const INSTANCE_AUTH_POLICY_ID = "default";

export type AuthPolicyConfig = Pick<
  InstanceAuthPolicy,
  | "id"
  | "mode"
  | "registrationMode"
  | "breakGlassCredentialsEnabled"
  | "autoRedirectProviderId"
  | "passwordMinLength"
  | "passwordResetTtlMinutes"
  | "lockoutThreshold"
  | "lockoutMinutes"
>;

export const DEFAULT_AUTH_POLICY: AuthPolicyConfig = {
  id: INSTANCE_AUTH_POLICY_ID,
  mode: "HYBRID",
  registrationMode: "INVITE_ONLY",
  breakGlassCredentialsEnabled: true,
  autoRedirectProviderId: null,
  passwordMinLength: 12,
  passwordResetTtlMinutes: 30,
  lockoutThreshold: 10,
  lockoutMinutes: 15,
};

type PolicyDatabase = Pick<typeof db, "instanceAuthPolicy">;

/**
 * Resolve the singleton policy, self-healing an empty development/test DB.
 * Production migrations seed this row, so the create branch is normally a
 * no-op.
 */
export async function getInstanceAuthPolicy(
  database: PolicyDatabase = db,
): Promise<InstanceAuthPolicy> {
  return database.instanceAuthPolicy.upsert({
    where: { id: INSTANCE_AUTH_POLICY_ID },
    update: {},
    create: DEFAULT_AUTH_POLICY,
  });
}

export type AuthProviderSummary = Pick<SsoProvider, "id" | "enabled" | "archivedAt">;

export type AuthPresentation = {
  mode: AuthenticationMode;
  registrationMode: RegistrationMode;
  localCredentialsEnabled: boolean;
  externalProvidersEnabled: boolean;
  breakGlassCredentialsEnabled: boolean;
  providerSelectionEnabled: boolean;
  autoRedirectProviderId: string | null;
  enabledProviderIds: string[];
};

function enabledProviderIds(providers: readonly AuthProviderSummary[]): string[] {
  return providers.filter((provider) => provider.enabled && !provider.archivedAt).map((p) => p.id);
}

/** Pure presentation derivation shared by the sign-in page and auth config. */
export function deriveAuthPresentation(
  policy: AuthPolicyConfig,
  providers: readonly AuthProviderSummary[],
): AuthPresentation {
  const availableProviderIds = enabledProviderIds(providers);
  const localCredentialsEnabled = policy.mode !== "EXTERNAL_ONLY";
  const externalProvidersEnabled = policy.mode !== "LOCAL_ONLY" && availableProviderIds.length > 0;
  const configuredRedirect =
    externalProvidersEnabled &&
    policy.autoRedirectProviderId &&
    availableProviderIds.includes(policy.autoRedirectProviderId)
      ? policy.autoRedirectProviderId
      : null;

  return {
    mode: policy.mode,
    registrationMode: policy.registrationMode,
    localCredentialsEnabled,
    externalProvidersEnabled,
    breakGlassCredentialsEnabled: policy.breakGlassCredentialsEnabled,
    providerSelectionEnabled: externalProvidersEnabled && !configuredRedirect,
    autoRedirectProviderId: configuredRedirect,
    enabledProviderIds: availableProviderIds,
  };
}

export class AuthPolicyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthPolicyValidationError";
  }
}

/**
 * Validate a proposed policy before persistence. These checks prevent an
 * operator from selecting a dead redirect or an external-only configuration
 * with no usable provider.
 */
export function validateAuthPolicyTransition(
  policy: AuthPolicyConfig,
  providers: readonly AuthProviderSummary[],
  options: { breakGlassConfigured?: boolean } = {},
): AuthPresentation {
  const availableProviderIds = enabledProviderIds(providers);

  if (policy.mode === "EXTERNAL_ONLY" && availableProviderIds.length === 0) {
    throw new AuthPolicyValidationError(
      "External-only authentication requires at least one enabled provider.",
    );
  }
  if (policy.mode === "LOCAL_ONLY" && policy.autoRedirectProviderId) {
    throw new AuthPolicyValidationError(
      "Local-only authentication cannot auto-redirect to an external provider.",
    );
  }
  if (
    policy.autoRedirectProviderId &&
    !availableProviderIds.includes(policy.autoRedirectProviderId)
  ) {
    throw new AuthPolicyValidationError(
      "The automatic redirect provider must be enabled and not archived.",
    );
  }
  if (policy.breakGlassCredentialsEnabled && options.breakGlassConfigured === false) {
    throw new AuthPolicyValidationError(
      "Break-glass credentials cannot be enabled until an operator credential is configured.",
    );
  }
  if (policy.passwordMinLength < 8 || policy.passwordMinLength > 128) {
    throw new AuthPolicyValidationError("Password minimum length must be between 8 and 128.");
  }
  if (policy.passwordResetTtlMinutes < 5 || policy.passwordResetTtlMinutes > 1440) {
    throw new AuthPolicyValidationError(
      "Password reset expiry must be between 5 minutes and 24 hours.",
    );
  }
  if (policy.lockoutThreshold < 3 || policy.lockoutThreshold > 100) {
    throw new AuthPolicyValidationError("Lockout threshold must be between 3 and 100.");
  }
  if (policy.lockoutMinutes < 1 || policy.lockoutMinutes > 1440) {
    throw new AuthPolicyValidationError("Lockout duration must be between 1 minute and 24 hours.");
  }

  return deriveAuthPresentation(policy, providers);
}

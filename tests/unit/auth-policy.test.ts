import { describe, expect, it } from "vitest";
import {
  AuthPolicyValidationError,
  DEFAULT_AUTH_POLICY,
  deriveAuthPresentation,
  validateAuthPolicyTransition,
} from "@/server/services/auth-policy";

const github = { id: "github", enabled: true, archivedAt: null };
const oidc = { id: "company-oidc", enabled: true, archivedAt: null };

describe("instance authentication policy", () => {
  it("derives clean local-only, external-only, and hybrid presentation", () => {
    expect(
      deriveAuthPresentation({ ...DEFAULT_AUTH_POLICY, mode: "LOCAL_ONLY" }, [github]),
    ).toMatchObject({
      localCredentialsEnabled: true,
      externalProvidersEnabled: false,
      providerSelectionEnabled: false,
    });

    expect(
      deriveAuthPresentation({ ...DEFAULT_AUTH_POLICY, mode: "EXTERNAL_ONLY" }, [github]),
    ).toMatchObject({
      localCredentialsEnabled: false,
      externalProvidersEnabled: true,
      providerSelectionEnabled: true,
    });

    expect(deriveAuthPresentation(DEFAULT_AUTH_POLICY, [github, oidc])).toMatchObject({
      localCredentialsEnabled: true,
      externalProvidersEnabled: true,
      providerSelectionEnabled: true,
      enabledProviderIds: ["github", "company-oidc"],
    });
  });

  it("auto-redirects only to an enabled, non-archived provider", () => {
    const presentation = validateAuthPolicyTransition(
      { ...DEFAULT_AUTH_POLICY, autoRedirectProviderId: oidc.id },
      [github, oidc],
    );
    expect(presentation.autoRedirectProviderId).toBe(oidc.id);
    expect(presentation.providerSelectionEnabled).toBe(false);

    expect(() =>
      validateAuthPolicyTransition({ ...DEFAULT_AUTH_POLICY, autoRedirectProviderId: oidc.id }, [
        { ...oidc, archivedAt: new Date() },
      ]),
    ).toThrow(AuthPolicyValidationError);
  });

  it("prevents external-only lockout and unconfigured break glass", () => {
    expect(() =>
      validateAuthPolicyTransition({ ...DEFAULT_AUTH_POLICY, mode: "EXTERNAL_ONLY" }, []),
    ).toThrow(/at least one enabled provider/i);

    expect(() =>
      validateAuthPolicyTransition(DEFAULT_AUTH_POLICY, [github], {
        breakGlassConfigured: false,
      }),
    ).toThrow(/break-glass credentials/i);
  });
});

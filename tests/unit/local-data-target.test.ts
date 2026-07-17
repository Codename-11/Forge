import { describe, expect, it } from "vitest";
import {
  LOCAL_DATABASE_CONTAINER,
  LOCAL_DATABASE_URL,
  formatLocalTarget,
  validateLocalScenarioTarget,
  validateLocalTarget,
} from "../../scripts/lib/local-data-target";

describe("local production-data refresh target guard", () => {
  it("accepts and displays only the fixed local development target", () => {
    const target = validateLocalTarget(LOCAL_DATABASE_URL);
    expect(target.container).toBe(LOCAL_DATABASE_CONTAINER);
    expect(formatLocalTarget(target)).toBe(
      "container=forge-dev-postgres host=localhost:55432 database=forge schema=public user=forge",
    );
  });

  it.each([
    "postgresql://forge:forge@docker-server.local:5432/forge?schema=public",
    "postgresql://forge:forge@localhost:5432/forge?schema=public",
    "postgresql://forge:forge@localhost:55432/postgres?schema=public",
    "postgresql://forge:not-local@localhost:55432/forge?schema=public",
  ])("rejects a destructive target outside the local contract: %s", (url) => {
    expect(() => validateLocalTarget(url)).toThrow(/Refusing destructive database operation/);
  });

  it("rejects an unexpected local container", () => {
    expect(() => validateLocalTarget(LOCAL_DATABASE_URL, "forge-postgres")).toThrow(
      /container must be forge-dev-postgres/,
    );
  });

  it("permits scenarios only on dedicated local Forge databases", () => {
    expect(() =>
      validateLocalScenarioTarget(
        "postgresql://forge:forge@localhost:55432/forge_e2e?schema=public",
      ),
    ).not.toThrow();
    expect(() =>
      validateLocalScenarioTarget("postgresql://forge:forge@prod:5432/forge?schema=public"),
    ).toThrow(/only against a Forge local docker database/);
  });
});

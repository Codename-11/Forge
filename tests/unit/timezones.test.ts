import { describe, expect, it } from "vitest";
import { supportedTimezones } from "@/lib/timezones";

describe("supportedTimezones", () => {
  it("exposes the runtime's full IANA timezone set with UTC", () => {
    const zones = supportedTimezones();

    expect(zones).toContain("UTC");
    expect(new Set(zones).size).toBe(zones.length);

    const nativeSupportedValuesOf = (
      Intl as typeof Intl & { supportedValuesOf?: (key: "timeZone") => string[] }
    ).supportedValuesOf;
    if (nativeSupportedValuesOf) {
      const nativeZones = nativeSupportedValuesOf("timeZone");
      expect(zones).toEqual(expect.arrayContaining(nativeZones));
      expect(zones).toContain("America/Phoenix");
    }
  });
});

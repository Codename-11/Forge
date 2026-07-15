const FALLBACK_TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Tokyo",
  "Asia/Kolkata",
  "Australia/Sydney",
];

export function supportedTimezones() {
  try {
    const supportedValuesOf = (
      Intl as typeof Intl & { supportedValuesOf?: (key: "timeZone") => string[] }
    ).supportedValuesOf;
    if (supportedValuesOf) {
      return Array.from(new Set(["UTC", ...supportedValuesOf("timeZone")])).sort();
    }
  } catch {
    // Older engines use the common fallback; existing saved zones remain selectable in the UI.
  }
  return FALLBACK_TIMEZONES;
}

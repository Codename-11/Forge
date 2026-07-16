import "server-only";

import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import type { LookupAddress } from "node:dns";

const MAX_REDIRECTS = 4;
const MAX_BODY_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;

function ipv4ToInt(address: string): number {
  return address.split(".").reduce((value, octet) => ((value << 8) | Number(octet)) >>> 0, 0);
}

function inIpv4Range(address: string, base: string, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4ToInt(address) & mask) === (ipv4ToInt(base) & mask);
}

/**
 * Whether an address is safe for an unauthenticated metadata fetch.
 * Denies loopback, private, link-local, carrier-grade NAT, documentation,
 * benchmarking, multicast, reserved, and unspecified ranges. IPv4-mapped IPv6
 * addresses are normalized before evaluation.
 */
export function isPublicMetadataAddress(rawAddress: string): boolean {
  const mapped = rawAddress.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  const address = mapped ?? rawAddress;
  const family = isIP(address);
  if (family === 4) {
    const denied: Array<[string, number]> = [
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.0.2.0", 24],
      ["192.88.99.0", 24],
      ["192.168.0.0", 16],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 4],
      ["240.0.0.0", 4],
    ];
    return !denied.some(([base, prefix]) => inIpv4Range(address, base, prefix));
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    if (normalized === "::" || normalized === "::1") return false;
    if (/^f[cd][0-9a-f]{2}:/i.test(normalized)) return false; // fc00::/7
    if (/^fe[89ab][0-9a-f]:/i.test(normalized)) return false; // fe80::/10
    if (/^ff/i.test(normalized)) return false; // multicast
    if (/^2001:db8:/i.test(normalized)) return false; // documentation
    return true;
  }
  return false;
}

async function resolvePublicAddress(hostname: string): Promise<LookupAddress> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  const selected = addresses.find((entry) => isPublicMetadataAddress(entry.address));
  if (!selected || addresses.some((entry) => !isPublicMetadataAddress(entry.address))) {
    // Reject mixed public/private answers too. This prevents a hostname from
    // steering retries or address-family fallback onto an internal endpoint.
    throw new Error("Link metadata host did not resolve exclusively to public addresses.");
  }
  return selected;
}

async function requestHtml(url: URL, redirectsRemaining: number): Promise<string> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP(S) metadata URLs are supported.");
  }
  if (url.username || url.password) {
    throw new Error("Credential-bearing metadata URLs are not supported.");
  }
  const resolved = await resolvePublicAddress(url.hostname);
  const client = url.protocol === "https:" ? https : http;

  return new Promise<string>((resolve, reject) => {
    const req = client.request(
      url,
      {
        method: "GET",
        headers: {
          "User-Agent": "ForgeLinkPreview/1.0 (+https://forge.axiom-labs.dev)",
          Accept: "text/html,application/xhtml+xml",
        },
        lookup: (_hostname, _options, callback) =>
          callback(null, resolved.address, resolved.family),
        servername: url.hostname,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirectsRemaining <= 0) {
            reject(new Error("Too many metadata redirects."));
            return;
          }
          const next = new URL(res.headers.location, url);
          requestHtml(next, redirectsRemaining - 1).then(resolve, reject);
          return;
        }
        const contentType = String(res.headers["content-type"] ?? "").toLowerCase();
        if (status < 200 || status >= 300 || !contentType.includes("text/html")) {
          res.resume();
          resolve("");
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("data", (chunk: Buffer) => {
          if (bytes >= MAX_BODY_BYTES) return;
          const remaining = MAX_BODY_BYTES - bytes;
          const value = chunk.subarray(0, remaining);
          chunks.push(value);
          bytes += value.length;
          if (bytes >= MAX_BODY_BYTES) res.destroy();
        });
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        res.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
        res.on("error", reject);
      },
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error("Metadata request timed out.")));
    req.on("error", reject);
    req.end();
  });
}

/** Fetch a bounded HTML title while pinning every request hop to a validated IP. */
export async function fetchSafeLinkTitle(url: string): Promise<string | undefined> {
  const html = await requestHtml(new URL(url), MAX_REDIRECTS);
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match) return undefined;
  const title = match[1]
    .replace(/\s+/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
  return title ? title.slice(0, 255) : undefined;
}

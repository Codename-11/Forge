import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const baseUrl = option("base-url", "http://localhost:3000");
const issueId = option("issue-id", process.env.FORGE_BENCHMARK_ISSUE_ID);
const label = option("label", "local");
const output = resolve(option("output", `output/playwright/ui-load-${label}.json`));

if (!issueId) {
  throw new Error("Pass --issue-id <local synthetic issue id>.");
}

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();

await page.goto(`${baseUrl}/signin`, { waitUntil: "domcontentloaded" });
await page.getByRole("textbox", { name: "Email" }).fill("owner@forge.local");
await page.getByRole("textbox", { name: /Password/ }).fill("forge-dev");
await Promise.all([
  page.waitForURL((url) => !url.pathname.startsWith("/signin")),
  page.getByRole("button", { name: /Sign in/ }).click(),
]);

async function measure(run) {
  const requests = [];
  const consoleMessages = [];
  const onRequestFinished = (request) => {
    if (request.url().includes("/api/")) {
      requests.push({
        method: request.method(),
        url: request.url(),
        postData: request.postData(),
      });
    }
  };
  const onConsole = (message) => consoleMessages.push(`${message.type()}: ${message.text()}`);
  page.on("requestfinished", onRequestFinished);
  page.on("console", onConsole);

  const started = performance.now();
  await page.goto(`${baseUrl}/w/forge/issues/${issueId}`, { waitUntil: "domcontentloaded" });
  await page.locator("main h1").first().waitFor({ state: "visible" });
  const primaryReadyMs = Math.round(performance.now() - started);
  await page.waitForTimeout(2_000);
  const settledMs = Math.round(performance.now() - started);

  const browserTiming = await page.evaluate(() => {
    const navigation = performance.getEntriesByType("navigation")[0];
    const resources = performance.getEntriesByType("resource");
    const paints = Object.fromEntries(
      performance
        .getEntriesByType("paint")
        .map((entry) => [entry.name, Math.round(entry.startTime)]),
    );
    return {
      domContentLoadedMs: Math.round(navigation.domContentLoadedEventEnd),
      loadMs: Math.round(navigation.loadEventEnd),
      transferBytes: navigation.transferSize,
      decodedBodyBytes: navigation.decodedBodySize,
      resourceCount: resources.length,
      scriptCount: resources.filter((entry) => entry.initiatorType === "script").length,
      scriptTransferBytes: resources
        .filter((entry) => entry.initiatorType === "script")
        .reduce((total, entry) => total + entry.transferSize, 0),
      paints,
    };
  });

  page.off("requestfinished", onRequestFinished);
  page.off("console", onConsole);

  const trpcProcedures = requests
    .filter((request) => request.url.includes("/api/trpc/"))
    .flatMap((request) => {
      const pathname = new URL(request.url).pathname;
      return decodeURIComponent(pathname.slice(pathname.indexOf("/api/trpc/") + 10)).split(",");
    });

  return {
    run,
    primaryReadyMs,
    settledMs,
    browserTiming,
    apiRequestCount: requests.length,
    trpcRequestCount: requests.filter((request) => request.url.includes("/api/trpc/")).length,
    trpcProcedureCount: trpcProcedures.length,
    trpcProcedures,
    consoleMessageCount: consoleMessages.length,
    trpcConsoleMessageCount: consoleMessages.filter(
      (message) => message.includes(">> query") || message.includes("<< query"),
    ).length,
    consoleSample: consoleMessages.slice(0, 5),
  };
}

const result = {
  label,
  route: `/w/forge/issues/${issueId}`,
  capturedAt: new Date().toISOString(),
  runs: [await measure("cold-route"), await measure("warm-reload")],
};

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
await browser.close();
console.log(JSON.stringify(result, null, 2));

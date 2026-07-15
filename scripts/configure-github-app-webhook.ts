import { db } from "@/server/db";
import { configureStoredGithubAppWebhook } from "@/server/services/github-app";

function value(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function webhookUrl(): string {
  const origin = value("origin") || process.env.AUTH_URL || process.env.NEXT_PUBLIC_APP_URL;
  if (!origin) throw new Error("Set AUTH_URL or pass --origin=https://forge.example.");
  const url = new URL("/api/ingest/github", origin);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("Webhook origin must use HTTPS (except localhost).");
  }
  return url.toString();
}

async function main() {
  const requestedId = value("id");
  const apps = await db.githubApp.findMany({
    where: requestedId ? { id: requestedId } : { installationId: { not: null } },
    select: { id: true, name: true, installationId: true },
    orderBy: { createdAt: "asc" },
  });
  if (apps.length === 0) throw new Error("No installed GitHub App matched.");
  if (!requestedId && apps.length !== 1) {
    throw new Error(`Found ${apps.length} installed GitHub Apps; rerun with --id=<GithubApp row id>.`);
  }
  const app = apps[0]!;
  const result = await configureStoredGithubAppWebhook({
    db,
    githubAppId: app.id,
    url: webhookUrl(),
  });
  process.stdout.write(
    `${JSON.stringify({ appId: app.id, name: app.name, ...result }, null, 2)}\n`,
  );
}

void main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });

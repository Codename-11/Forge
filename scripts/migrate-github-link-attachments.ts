import { db } from "@/server/db";
import { migrateGenericGitHubAttachments } from "@/server/services/github/resource-sync";

function value(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

async function main() {
  const rawLimit = value("limit");
  const parsedLimit = rawLimit ? Number(rawLimit) : 25;
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
    throw new Error("--limit must be an integer from 1 to 100.");
  }
  const result = await migrateGenericGitHubAttachments(db, {
    workspaceId: value("workspace"),
    limit: parsedLimit,
    dryRun: process.argv.includes("--dry-run"),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.failed > 0) process.exitCode = 1;
}

void main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });

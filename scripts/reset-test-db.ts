import { spawnSync } from "node:child_process";
import {
  formatLocalTarget,
  LOCAL_TEST_DATABASE_URL,
  validateLocalTestTarget,
} from "./lib/local-data-target";

const databaseUrl = process.env.DATABASE_URL ?? LOCAL_TEST_DATABASE_URL;
const target = validateLocalTestTarget(databaseUrl);

function docker(args: string[]) {
  const result = spawnSync("docker", args, { encoding: "utf8", stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`docker failed with exit ${result.status}`);
}

console.log(`[test-db] Resetting disposable target: ${formatLocalTarget(target)}`);
docker([
  "exec",
  target.container,
  "psql",
  "-U",
  target.user,
  "-d",
  "forge",
  "-v",
  "ON_ERROR_STOP=1",
  "-c",
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'forge_test' AND pid <> pg_backend_pid();",
]);
docker(["exec", target.container, "dropdb", "-U", target.user, "--if-exists", target.database]);
docker(["exec", target.container, "createdb", "-U", target.user, target.database]);
docker(["exec", "forge-dev-redis", "redis-cli", "-n", "13", "FLUSHDB"]);
console.log(
  "[test-db] Disposable forge_test database and Redis DB 13 are empty and ready for tests.",
);

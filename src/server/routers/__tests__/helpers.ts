import { PrismaClient, Role, type Workspace, type User } from "@prisma/client";
import type { Context } from "@/server/trpc";

/**
 * Vitest helpers shared by router integration tests.
 *
 * These tests exercise the routers end-to-end against the real Postgres
 * and Redis instances declared in docker-compose.yml. No mocks — that's
 * per `~/forge/CLAUDE.md`.
 *
 * Each test builds an isolated workspace + user so suites can run in
 * parallel without cross-talk.
 */

// Shared client. Reusing across files avoids connection-pool churn when
// the full suite runs in one vitest process.
let _prisma: PrismaClient | null = null;
export function getPrisma(): PrismaClient {
  if (!_prisma) {
    _prisma = new PrismaClient({ log: ["error"] });
  }
  return _prisma;
}

let counter = 0;
function uniq(): string {
  counter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${Date.now().toString(36)}${counter.toString(36)}${rand}`;
}

function compactKeyTail(input: string, length = 6): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).toUpperCase().padStart(length, "0").slice(-length);
}

export interface TestFixture {
  workspace: Workspace;
  user: User;
  secondUser: User;
  cleanup: () => Promise<void>;
}

export async function createWorkspaceFixture(
  opts: { keyPrefix?: string } = {},
): Promise<TestFixture> {
  const prisma = getPrisma();
  const suffix = uniq();
  const keyBase = (opts.keyPrefix ?? "TST")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 2)
    .padEnd(2, "X");
  const workspaceKey = `${keyBase}${compactKeyTail(suffix)}`;

  const user = await prisma.user.create({
    data: {
      email: `test-${suffix}@example.com`,
      name: `Test User ${suffix}`,
    },
  });
  const secondUser = await prisma.user.create({
    data: {
      email: `test-${suffix}-2@example.com`,
      name: `Test User 2 ${suffix}`,
    },
  });

  const workspace = await prisma.workspace.create({
    data: {
      slug: `t-${suffix}`.slice(0, 48),
      name: `Test ${suffix}`,
      key: workspaceKey,
      cycleLengthDays: 7,
      cycleCooldownDays: 0,
      memberships: {
        create: [
          { userId: user.id, role: Role.OWNER },
          { userId: secondUser.id, role: Role.MEMBER },
        ],
      },
      statuses: {
        create: [
          { name: "Backlog", category: "BACKLOG", color: "#78716c", position: 0, isDefault: true },
          { name: "Todo", category: "TODO", color: "#a8a29e", position: 1 },
          { name: "In Progress", category: "IN_PROGRESS", color: "#d97706", position: 2 },
          { name: "Done", category: "DONE", color: "#65a30d", position: 3 },
          { name: "Canceled", category: "CANCELED", color: "#57534e", position: 4 },
        ],
      },
    },
  });

  const cleanup = async () => {
    // ON DELETE CASCADE on Workspace fans out to everything tenant-scoped.
    await prisma.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
    await prisma.user
      .deleteMany({ where: { id: { in: [user.id, secondUser.id] } } })
      .catch(() => {});
  };

  return { workspace, user, secondUser, cleanup };
}

export async function buildContext(
  fixture: TestFixture,
  opts: { asUserId?: string } = {},
): Promise<Context & { workspaceId: string; session: NonNullable<Context["session"]> }> {
  const prisma = getPrisma();
  const userId = opts.asUserId ?? fixture.user.id;
  const membership = await prisma.membership.findUniqueOrThrow({
    where: { userId_workspaceId: { userId, workspaceId: fixture.workspace.id } },
  });
  return {
    db: prisma,
    session: {
      user: {
        id: userId,
        email:
          opts.asUserId === fixture.secondUser.id ? fixture.secondUser.email : fixture.user.email,
        name: null,
      },
      expires: new Date(Date.now() + 86_400_000).toISOString(),
    } as unknown as NonNullable<Context["session"]>,
    workspaceId: fixture.workspace.id,
    workspaceSlug: fixture.workspace.slug,
    ip: null,
    userAgent: null,
    // `membership` is injected by workspaceProcedure middleware; pre-fill
    // it so createCaller tests can bypass the middleware uniformly.
    membership,
  } as unknown as Context & {
    workspaceId: string;
    session: NonNullable<Context["session"]>;
  };
}

export async function createIssue(
  fixture: TestFixture,
  opts: {
    title?: string;
    statusCategory?: "BACKLOG" | "TODO" | "IN_PROGRESS" | "DONE" | "CANCELED";
    projectId?: string;
    cycleId?: string;
  } = {},
): Promise<{ id: string; number: number }> {
  const prisma = getPrisma();
  const status = await prisma.status.findFirstOrThrow({
    where: {
      workspaceId: fixture.workspace.id,
      category: opts.statusCategory ?? "TODO",
    },
  });
  const last = await prisma.issue.findFirst({
    where: { workspaceId: fixture.workspace.id },
    orderBy: { number: "desc" },
    select: { number: true },
  });
  const issue = await prisma.issue.create({
    data: {
      workspaceId: fixture.workspace.id,
      number: (last?.number ?? 0) + 1,
      title: opts.title ?? `Test issue ${uniq()}`,
      statusId: status.id,
      authorId: fixture.user.id,
      projectId: opts.projectId,
      cycleId: opts.cycleId,
    },
  });
  return { id: issue.id, number: issue.number };
}

export async function disconnectPrisma(): Promise<void> {
  if (_prisma) {
    await _prisma.$disconnect();
    _prisma = null;
  }
}

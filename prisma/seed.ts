import { PrismaClient, Role, StatusCategory, Priority } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const owner = await prisma.user.upsert({
    where: { email: "owner@forge.local" },
    update: {},
    create: {
      email: "owner@forge.local",
      name: "Forge Owner",
      handle: "owner",
    },
  });

  const workspace = await prisma.workspace.upsert({
    where: { slug: "forge" },
    update: {},
    create: {
      slug: "forge",
      name: "Forge",
      key: "FRG",
      memberships: { create: { userId: owner.id, role: Role.OWNER } },
    },
  });

  const defaultStatuses = [
    { name: "Backlog", category: StatusCategory.BACKLOG, color: "#78716c", position: 0, isDefault: true },
    { name: "Todo", category: StatusCategory.TODO, color: "#a8a29e", position: 1 },
    { name: "In Progress", category: StatusCategory.IN_PROGRESS, color: "#d97706", position: 2 },
    { name: "In Review", category: StatusCategory.IN_REVIEW, color: "#ca8a04", position: 3 },
    { name: "Done", category: StatusCategory.DONE, color: "#65a30d", position: 4 },
    { name: "Canceled", category: StatusCategory.CANCELED, color: "#57534e", position: 5 },
  ];

  for (const s of defaultStatuses) {
    await prisma.status.upsert({
      where: { workspaceId_name: { workspaceId: workspace.id, name: s.name } },
      update: {},
      create: { ...s, workspaceId: workspace.id },
    });
  }

  const backlog = await prisma.status.findFirstOrThrow({
    where: { workspaceId: workspace.id, isDefault: true },
  });

  const project = await prisma.project.upsert({
    where: { workspaceId_key: { workspaceId: workspace.id, key: "CORE" } },
    update: {},
    create: {
      workspaceId: workspace.id,
      key: "CORE",
      name: "Core Platform",
      description: "Foundational work for Forge.",
      color: "#d97706",
      createdById: owner.id,
    },
  });

  for (let i = 1; i <= 5; i++) {
    await prisma.issue.upsert({
      where: { workspaceId_number: { workspaceId: workspace.id, number: i } },
      update: {},
      create: {
        workspaceId: workspace.id,
        projectId: project.id,
        number: i,
        title: `Seed issue #${i}`,
        description: "Demo issue created by seed.",
        statusId: backlog.id,
        priority: i % 2 === 0 ? Priority.HIGH : Priority.MEDIUM,
        authorId: owner.id,
      },
    });
  }

  // eslint-disable-next-line no-console
  console.log("Seed complete.");
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

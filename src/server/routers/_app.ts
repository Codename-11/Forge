import { router } from "@/server/trpc";
import { workspaceRouter } from "./workspace";
import { projectRouter } from "./project";
import { issueRouter } from "./issue";
import { commentRouter } from "./comment";
import { analyticsRouter } from "./analytics";
import { pluginRouter } from "./plugin";
import { statusRouter } from "./status";
import { accessRouter } from "./access";
import { adminRouter } from "./admin";
import { labelRouter } from "./label";
import { issueTemplateRouter } from "./issue-template";
import { projectTemplateRouter } from "./project-template";
import { recurringRouter } from "./recurring";
import { viewRouter } from "./view";
import { standupRouter } from "./standup";

export const appRouter = router({
  workspace: workspaceRouter,
  project: projectRouter,
  issue: issueRouter,
  comment: commentRouter,
  analytics: analyticsRouter,
  plugin: pluginRouter,
  status: statusRouter,
  access: accessRouter,
  admin: adminRouter,
  label: labelRouter,
  template: issueTemplateRouter,
  projectTemplate: projectTemplateRouter,
  recurring: recurringRouter,
  view: viewRouter,
  standup: standupRouter,
});

export type AppRouter = typeof appRouter;

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
import { attachmentRouter } from "./attachment";
import { labelRouter } from "./label";
import { issueTemplateRouter } from "./issue-template";
import { projectTemplateRouter } from "./project-template";
import { recurringRouter } from "./recurring";
import { viewRouter } from "./view";
import { standupRouter } from "./standup";
import { cycleRouter } from "./cycle";
import { inboxRouter } from "./inbox";
import { initiativeRouter } from "./initiative";
import { pinRouter } from "./pin";
import { relationRouter } from "./relation";
import { timeEntryRouter } from "./timeEntry";

export const appRouter = router({
  access: accessRouter,
  admin: adminRouter,
  analytics: analyticsRouter,
  attachment: attachmentRouter,
  comment: commentRouter,
  cycle: cycleRouter,
  inbox: inboxRouter,
  initiative: initiativeRouter,
  issue: issueRouter,
  label: labelRouter,
  pin: pinRouter,
  plugin: pluginRouter,
  project: projectRouter,
  projectTemplate: projectTemplateRouter,
  recurring: recurringRouter,
  relation: relationRouter,
  standup: standupRouter,
  status: statusRouter,
  template: issueTemplateRouter,
  timeEntry: timeEntryRouter,
  view: viewRouter,
  workspace: workspaceRouter,
});

export type AppRouter = typeof appRouter;

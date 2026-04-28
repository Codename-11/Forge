import { router } from "@/server/trpc";
import { agentRouter } from "./agent";
import { integrationRouter } from "./integration";
import { agentRunRouter } from "./agent-run";
import { chatRouter } from "./chat";
import { aiRouter } from "./ai";
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
import { dispatchRuleRouter } from "./dispatch-rule";
import { eventRouter } from "./event";
import { inboxRouter } from "./inbox";
import { initiativeRouter } from "./initiative";
import { notificationRouter } from "./notification";
import { pinRouter } from "./pin";
import { relationRouter } from "./relation";
import { runtimeRouter } from "./runtime";
import { timeEntryRouter } from "./timeEntry";
import { userRouter } from "./user";

export const appRouter = router({
  access: accessRouter,
  admin: adminRouter,
  agent: agentRouter,
  agentRun: agentRunRouter,
  ai: aiRouter,
  chat: chatRouter,
  analytics: analyticsRouter,
  attachment: attachmentRouter,
  comment: commentRouter,
  cycle: cycleRouter,
  dispatchRule: dispatchRuleRouter,
  event: eventRouter,
  inbox: inboxRouter,
  initiative: initiativeRouter,
  integration: integrationRouter,
  notification: notificationRouter,
  issue: issueRouter,
  label: labelRouter,
  pin: pinRouter,
  plugin: pluginRouter,
  project: projectRouter,
  projectTemplate: projectTemplateRouter,
  recurring: recurringRouter,
  relation: relationRouter,
  runtime: runtimeRouter,
  standup: standupRouter,
  status: statusRouter,
  template: issueTemplateRouter,
  timeEntry: timeEntryRouter,
  user: userRouter,
  view: viewRouter,
  workspace: workspaceRouter,
});

export type AppRouter = typeof appRouter;

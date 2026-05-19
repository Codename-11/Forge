import { router } from "@/server/trpc";
import { actionRequestRouter } from "./action-request";
import { agentRouter } from "./agent";
import { agentCrewRouter, reviewGateRouter } from "./agent-crew";
import { artifactRouter } from "./artifact";
import { canvasRouter } from "./canvas";
import { integrationRouter } from "./integration";
import { agentRunRouter } from "./agent-run";
import { chatRouter } from "./chat";
import { aiRouter } from "./ai";
import { workspaceRouter } from "./workspace";
import { projectRouter } from "./project";
import { issueRouter } from "./issue";
import { commentRouter } from "./comment";
import { contextSetRouter } from "./context-set";
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
import { savedViewRouter } from "./saved-view";
import { standupRouter } from "./standup";
import { systemRouter } from "./system";
import { cycleRouter } from "./cycle";
import { dashboardRouter } from "./dashboard";
import { dispatchRuleRouter } from "./dispatch-rule";
import { eventRouter } from "./event";
import { executionPlanRouter } from "./execution-plan";
import { inboxRouter } from "./inbox";
import { initiativeRouter } from "./initiative";
import { noteRouter } from "./note";
import { notificationRouter } from "./notification";
import { pinRouter } from "./pin";
import { recentItemRouter } from "./recent-item";
import { commandCenterRouter } from "./command-center";
import { commandPaletteRouter } from "./command-palette";
import { relationRouter } from "./relation";
import { runtimeRouter } from "./runtime";
import { timeEntryRouter } from "./timeEntry";
import { userRouter } from "./user";

export const appRouter = router({
  access: accessRouter,
  actionRequest: actionRequestRouter,
  admin: adminRouter,
  agent: agentRouter,
  agentCrew: agentCrewRouter,
  agentRun: agentRunRouter,
  artifact: artifactRouter,
  canvas: canvasRouter,
  reviewGate: reviewGateRouter,
  ai: aiRouter,
  chat: chatRouter,
  analytics: analyticsRouter,
  attachment: attachmentRouter,
  comment: commentRouter,
  commandCenter: commandCenterRouter,
  contextSet: contextSetRouter,
  cycle: cycleRouter,
  dashboard: dashboardRouter,
  dispatchRule: dispatchRuleRouter,
  event: eventRouter,
  executionPlan: executionPlanRouter,
  inbox: inboxRouter,
  initiative: initiativeRouter,
  integration: integrationRouter,
  notification: notificationRouter,
  note: noteRouter,
  issue: issueRouter,
  label: labelRouter,
  pin: pinRouter,
  recentItem: recentItemRouter,
  commandPalette: commandPaletteRouter,
  plugin: pluginRouter,
  project: projectRouter,
  projectTemplate: projectTemplateRouter,
  recurring: recurringRouter,
  relation: relationRouter,
  runtime: runtimeRouter,
  savedView: savedViewRouter,
  standup: standupRouter,
  status: statusRouter,
  system: systemRouter,
  template: issueTemplateRouter,
  timeEntry: timeEntryRouter,
  user: userRouter,
  view: viewRouter,
  workspace: workspaceRouter,
});

export type AppRouter = typeof appRouter;

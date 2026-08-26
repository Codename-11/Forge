import { router } from "@/server/trpc";
import { actionRequestRouter } from "./action-request";
import { agentRouter } from "./agent";
import { agentProfileRouter } from "./agent-profile";
import { agentBindingRouter } from "./agent-binding";
import { connectionRouter } from "./connection";
import { connectionMappingRouter } from "./connection-mapping";
import { instanceAdminRouter } from "./instance-admin";
import { agentCrewRouter, reviewGateRouter } from "./agent-crew";
import { artifactRouter } from "./artifact";
import { canvasRouter } from "./canvas";
import { integrationRouter } from "./integration";
import { integrationGrantRouter } from "./integration-grant";
import { agentRunRouter } from "./agent-run";
import { chatRouter } from "./chat";
import { aiRouter } from "./ai";
import { workspaceRouter } from "./workspace";
import { projectRouter } from "./project";
import { projectAccessRouter } from "./project-access";
import { issueRouter } from "./issue";
import { commentRouter } from "./comment";
import { contextSetRouter } from "./context-set";
import { analyticsRouter } from "./analytics";
import { pluginRouter } from "./plugin";
import { statusRouter } from "./status";
import { ssoRouter } from "./sso";
import { accessRouter } from "./access";
import { adminRouter } from "./admin";
import { attachmentRouter } from "./attachment";
import { avatarRouter } from "./avatar";
import { labelRouter } from "./label";
import { issueTemplateRouter } from "./issue-template";
import { projectTemplateRouter } from "./project-template";
import { recurringRouter } from "./recurring";
import { scheduledTaskRouter } from "./scheduled-task";
import { viewRouter } from "./view";
import { savedViewRouter } from "./saved-view";
import { standupRouter } from "./standup";
import { systemRouter } from "./system";
import { cycleRouter } from "./cycle";
import { dashboardRouter } from "./dashboard";
import { dataPortabilityRouter } from "./data-portability";
import { dispatchRuleRouter } from "./dispatch-rule";
import { embedRouter } from "./embed";
import { eventRouter } from "./event";
import { executionPlanRouter } from "./execution-plan";
import { globalRouter } from "./global";
import { goalRouter } from "./goal";
import { githubRouter } from "./github";
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
import { githubAppRouter } from "./github-app";
import { timeEntryRouter } from "./timeEntry";
import { userRouter } from "./user";
import { workSessionRouter } from "./work-session";

export const appRouter = router({
  access: accessRouter,
  actionRequest: actionRequestRouter,
  admin: adminRouter,
  agent: agentRouter,
  // Three-tier agent ownership (multi-workspace restructure):
  // `agents.profiles.*` global definitions, `agents.bindings.*` workspace policy.
  agents: router({ profiles: agentProfileRouter, bindings: agentBindingRouter }),
  agentCrew: agentCrewRouter,
  agentRun: agentRunRouter,
  connection: connectionRouter,
  connectionMapping: connectionMappingRouter,
  instanceAdmin: instanceAdminRouter,
  artifact: artifactRouter,
  canvas: canvasRouter,
  reviewGate: reviewGateRouter,
  ai: aiRouter,
  chat: chatRouter,
  analytics: analyticsRouter,
  attachment: attachmentRouter,
  avatar: avatarRouter,
  comment: commentRouter,
  commandCenter: commandCenterRouter,
  contextSet: contextSetRouter,
  cycle: cycleRouter,
  dashboard: dashboardRouter,
  dataPortability: dataPortabilityRouter,
  dispatchRule: dispatchRuleRouter,
  embed: embedRouter,
  event: eventRouter,
  executionPlan: executionPlanRouter,
  global: globalRouter,
  goal: goalRouter,
  github: githubRouter,
  inbox: inboxRouter,
  initiative: initiativeRouter,
  integration: integrationRouter,
  integrationGrant: integrationGrantRouter,
  notification: notificationRouter,
  note: noteRouter,
  issue: issueRouter,
  label: labelRouter,
  pin: pinRouter,
  recentItem: recentItemRouter,
  commandPalette: commandPaletteRouter,
  plugin: pluginRouter,
  project: projectRouter,
  projectAccess: projectAccessRouter,
  projectTemplate: projectTemplateRouter,
  recurring: recurringRouter,
  scheduledTask: scheduledTaskRouter,
  relation: relationRouter,
  runtime: runtimeRouter,
  githubApp: githubAppRouter,
  savedView: savedViewRouter,
  standup: standupRouter,
  status: statusRouter,
  sso: ssoRouter,
  system: systemRouter,
  template: issueTemplateRouter,
  timeEntry: timeEntryRouter,
  user: userRouter,
  view: viewRouter,
  workspace: workspaceRouter,
  workSession: workSessionRouter,
});

export type AppRouter = typeof appRouter;

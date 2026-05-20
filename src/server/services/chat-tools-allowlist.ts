import "server-only";
import type OpenAI from "openai";

export interface ChatToolDef {
  name: string;
  mcpName: string;
  requiresConfirm: boolean;
  description: string;
  paramsSchema: Record<string, unknown>;
}

const READ_TOOLS: ChatToolDef[] = [
  {
    name: "issues.assigned",
    mcpName: "issues_assigned",
    requiresConfirm: false,
    description:
      "List issues currently assigned to the caller's linked agent (or to a profileKey).",
    paramsSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
        includeDone: { type: "boolean", default: false },
        profileKey: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "issues.get",
    mcpName: "issues_get",
    requiresConfirm: false,
    description: "Fetch an issue by id (cuid). Returns full row.",
    paramsSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: true,
    },
  },
  {
    name: "issues.list",
    mcpName: "issues_list",
    requiresConfirm: false,
    description:
      "List/search issues. Supports query, projectId, statusId, assigneeUserId, agentId, priority filters.",
    paramsSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        projectId: { type: "string" },
        statusId: { type: "string" },
        priority: {
          type: "string",
          enum: ["NONE", "LOW", "MEDIUM", "HIGH", "URGENT"],
        },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
      },
      additionalProperties: true,
    },
  },
  {
    name: "agent.context.bundle",
    mcpName: "agent_context_bundle",
    requiresConfirm: false,
    description:
      "Bundle the context an agent needs for one entity: issue (issueId) or chat thread (threadId).",
    paramsSchema: {
      type: "object",
      properties: {
        issueId: { type: "string" },
        threadId: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "canvases.get",
    mcpName: "canvases_get",
    requiresConfirm: false,
    description:
      "Fetch a canvas by id, including its nodes and edges.",
    paramsSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "canvases.list",
    mcpName: "canvases_list",
    requiresConfirm: false,
    description: "List canvases in the workspace.",
    paramsSchema: {
      type: "object",
      properties: {
        scopeType: { type: "string" },
        scopeId: { type: "string" },
        includeArchived: { type: "boolean", default: false },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "canvases.hydrate",
    mcpName: "canvases_hydrate",
    requiresConfirm: false,
    description:
      "Hydrate a canvas (nodes + edges + scope summary) for rendering.",
    paramsSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "runs.list",
    mcpName: "runs_list",
    requiresConfirm: false,
    description: "List recent AgentRun rows, optionally filtered by agent / issue / status.",
    paramsSchema: {
      type: "object",
      properties: {
        agentId: { type: "string" },
        issueId: { type: "string" },
        status: {
          type: "string",
          enum: ["ACTIVE", "COMPLETED", "ABANDONED", "STALLED"],
        },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "chat.getThread",
    mcpName: "chat_getThread",
    requiresConfirm: false,
    description:
      "Fetch a chat thread's messages. Requires the API key to be linked to an agent.",
    paramsSchema: {
      type: "object",
      properties: {
        threadId: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
      },
      required: ["threadId"],
      additionalProperties: false,
    },
  },
  {
    name: "comments.list",
    mcpName: "comments_list",
    requiresConfirm: false,
    description: "List comments on an issue, newest first.",
    paramsSchema: {
      type: "object",
      properties: {
        issueId: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
      },
      required: ["issueId"],
      additionalProperties: false,
    },
  },
  {
    name: "notes.list",
    mcpName: "notes_list",
    requiresConfirm: false,
    description: "List the caller's own notes in this workspace.",
    paramsSchema: {
      type: "object",
      properties: {
        archived: { type: "boolean", default: false },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "executionPlans.get",
    mcpName: "executionPlans_get",
    requiresConfirm: false,
    description: "Fetch an execution plan by id, including its steps.",
    paramsSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "executionPlans.list",
    mcpName: "executionPlans_list",
    requiresConfirm: false,
    description: "List execution plans, optionally filtered by status / issue / project.",
    paramsSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["DRAFT", "APPROVED", "RUNNING", "BLOCKED", "COMPLETED", "CANCELED"],
        },
        issueId: { type: "string" },
        projectId: { type: "string" },
        includeArchived: { type: "boolean", default: false },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "cycles.current",
    mcpName: "cycles_current",
    requiresConfirm: false,
    description: "Return the currently-active cycle (sprint) in the workspace.",
    paramsSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "workspace.get",
    mcpName: "workspace_get",
    requiresConfirm: false,
    description: "Return the current workspace settings (cycle length, flags, etc.).",
    paramsSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

const WRITE_TOOLS: ChatToolDef[] = [
  {
    name: "issues.create",
    mcpName: "issues_create",
    requiresConfirm: true,
    description:
      "Create an issue in this workspace. Returns the new id + numeric key suffix.",
    paramsSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 300 },
        description: { type: "string" },
        projectId: { type: "string" },
        priority: {
          type: "string",
          enum: ["NONE", "LOW", "MEDIUM", "HIGH", "URGENT"],
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "issues.update",
    mcpName: "issues_update",
    requiresConfirm: true,
    description: "Patch fields on an existing issue.",
    paramsSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        description: { type: ["string", "null"] },
        priority: {
          type: "string",
          enum: ["NONE", "LOW", "MEDIUM", "HIGH", "URGENT"],
        },
        projectId: { type: ["string", "null"] },
        cycleId: { type: ["string", "null"] },
        dueDate: { type: ["string", "null"], format: "date-time" },
      },
      required: ["id"],
      additionalProperties: true,
    },
  },
  {
    name: "issues.assign",
    mcpName: "issues_assign",
    requiresConfirm: true,
    description:
      "Assign an issue to an agent. Provide agentId (or null to unassign) or profileKey.",
    paramsSchema: {
      type: "object",
      properties: {
        issueId: { type: "string" },
        agentId: { type: ["string", "null"] },
        profileKey: { type: "string" },
      },
      required: ["issueId"],
      additionalProperties: false,
    },
  },
  {
    name: "issues.transition",
    mcpName: "issues_transition",
    requiresConfirm: true,
    description: "Transition an issue to a different status.",
    paramsSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        statusId: { type: "string" },
      },
      required: ["id", "statusId"],
      additionalProperties: false,
    },
  },
  {
    name: "comments.create",
    mcpName: "comments_create",
    requiresConfirm: true,
    description: "Post a comment on an issue.",
    paramsSchema: {
      type: "object",
      properties: {
        issueId: { type: "string" },
        body: { type: "string", minLength: 1 },
      },
      required: ["issueId", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "canvases.addNode",
    mcpName: "canvases_addNode",
    requiresConfirm: true,
    description: "Add a node to a canvas, pointing at a forge entity.",
    paramsSchema: {
      type: "object",
      properties: {
        canvasId: { type: "string" },
        targetType: { type: "string" },
        targetId: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number", minimum: 40, maximum: 8000 },
        height: { type: "number", minimum: 40, maximum: 8000 },
      },
      required: ["canvasId", "targetType", "targetId", "x", "y"],
      additionalProperties: true,
    },
  },
  {
    name: "canvases.addEdge",
    mcpName: "canvases_addEdge",
    requiresConfirm: true,
    description: "Add a directed edge between two canvas nodes.",
    paramsSchema: {
      type: "object",
      properties: {
        canvasId: { type: "string" },
        fromNodeId: { type: "string" },
        toNodeId: { type: "string" },
        label: { type: ["string", "null"] },
        kind: { type: ["string", "null"] },
      },
      required: ["canvasId", "fromNodeId", "toNodeId"],
      additionalProperties: false,
    },
  },
  {
    name: "canvases.patchNode",
    mcpName: "canvases_patchNode",
    requiresConfirm: true,
    description: "Patch geometry / style on a canvas node.",
    paramsSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
        zIndex: { type: "integer" },
        collapsed: { type: "boolean" },
        viewMode: { type: ["string", "null"] },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "canvases.removeNode",
    mcpName: "canvases_removeNode",
    requiresConfirm: true,
    description: "Remove a node (and its incident edges) from a canvas.",
    paramsSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "canvases.removeEdge",
    mcpName: "canvases_removeEdge",
    requiresConfirm: true,
    description: "Remove an edge from a canvas.",
    paramsSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "canvases.edgePatch",
    mcpName: "canvases_edgePatch",
    requiresConfirm: true,
    description:
      "Patch a canvas edge's label / kind / meta. Pass null to clear a field; omit a field to leave it alone. `meta` is REPLACED on write.",
    paramsSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        label: { type: ["string", "null"] },
        kind: { type: ["string", "null"] },
        meta: {},
      },
      required: ["id"],
      additionalProperties: true,
    },
  },
  {
    name: "canvases.shapeAdd",
    mcpName: "canvases_shapeAdd",
    requiresConfirm: true,
    description:
      "Add a drawing primitive (box / ellipse / line / arrow / text / freehand) to a canvas.",
    paramsSchema: {
      type: "object",
      properties: {
        canvasId: { type: "string" },
        kind: {
          type: "string",
          enum: ["box", "ellipse", "line", "arrow", "text", "freehand"],
        },
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
        path: {},
        style: {},
        text: { type: "string" },
        groupId: { type: "string" },
        zIndex: { type: "integer" },
      },
      required: ["canvasId", "kind", "x", "y"],
      additionalProperties: true,
    },
  },
  {
    name: "canvases.shapePatch",
    mcpName: "canvases_shapePatch",
    requiresConfirm: true,
    description:
      "Patch a canvas shape. Style is REPLACED (not merged). Pass null to clear width/height/path/style/text/groupId.",
    paramsSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        width: { type: ["number", "null"] },
        height: { type: ["number", "null"] },
        path: {},
        style: {},
        text: { type: ["string", "null"] },
        groupId: { type: ["string", "null"] },
        zIndex: { type: "integer" },
      },
      required: ["id"],
      additionalProperties: true,
    },
  },
  {
    name: "canvases.shapeRemove",
    mcpName: "canvases_shapeRemove",
    requiresConfirm: true,
    description: "Remove a drawing primitive from a canvas.",
    paramsSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "canvases.bulkAddShapes",
    mcpName: "canvases_bulkAddShapes",
    requiresConfirm: true,
    description:
      "Add up to 50 drawing primitives to a canvas in one call. Each shape entry uses the same shape as canvases.shapeAdd.",
    paramsSchema: {
      type: "object",
      properties: {
        canvasId: { type: "string" },
        shapes: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: {
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: ["box", "ellipse", "line", "arrow", "text", "freehand"],
              },
              x: { type: "number" },
              y: { type: "number" },
              width: { type: "number" },
              height: { type: "number" },
              path: {},
              style: {},
              text: { type: "string" },
              groupId: { type: "string" },
              zIndex: { type: "integer" },
            },
            required: ["kind", "x", "y"],
            additionalProperties: true,
          },
        },
      },
      required: ["canvasId", "shapes"],
      additionalProperties: false,
    },
  },
  {
    name: "canvases.applyTemplate",
    mcpName: "canvases_applyTemplate",
    requiresConfirm: true,
    description:
      "Drop a named template (decision_matrix / retro / architecture / standup / okr_tree / empty) onto a canvas at an optional (x,y).",
    paramsSchema: {
      type: "object",
      properties: {
        canvasId: { type: "string" },
        templateId: {
          type: "string",
          enum: [
            "decision_matrix",
            "retro",
            "architecture",
            "standup",
            "okr_tree",
            "empty",
          ],
        },
        position: {
          type: "object",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
          },
          required: ["x", "y"],
          additionalProperties: false,
        },
      },
      required: ["canvasId", "templateId"],
      additionalProperties: false,
    },
  },
  {
    name: "canvases.layout",
    mcpName: "canvases_layout",
    requiresConfirm: true,
    description:
      "Re-flow canvas node positions using `topological`, `force`, or `grid` layout.",
    paramsSchema: {
      type: "object",
      properties: {
        canvasId: { type: "string" },
        algorithm: {
          type: "string",
          enum: ["topological", "force", "grid"],
        },
      },
      required: ["canvasId", "algorithm"],
      additionalProperties: false,
    },
  },
  {
    name: "canvases.addNote",
    mcpName: "canvases_addNote",
    requiresConfirm: true,
    description:
      "Create a sticky-note artifact and place it on a canvas at (x,y). Body is markdown; first line becomes the title.",
    paramsSchema: {
      type: "object",
      properties: {
        canvasId: { type: "string" },
        body: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
      },
      required: ["canvasId", "x", "y"],
      additionalProperties: false,
    },
  },
  {
    name: "canvases.addChatThread",
    mcpName: "canvases_addChatThread",
    requiresConfirm: true,
    description: "Place an existing ChatThread on a canvas at (x,y).",
    paramsSchema: {
      type: "object",
      properties: {
        canvasId: { type: "string" },
        threadId: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
      },
      required: ["canvasId", "threadId", "x", "y"],
      additionalProperties: false,
    },
  },
  {
    name: "canvases.convertToPlan",
    mcpName: "canvases_convertToPlan",
    requiresConfirm: true,
    description:
      "Synthesize a DRAFT ExecutionPlan from a canvas — execution-step nodes + Note artifacts become steps, depends_on edges become dependencies.",
    paramsSchema: {
      type: "object",
      properties: {
        canvasId: { type: "string" },
        title: { type: "string" },
      },
      required: ["canvasId"],
      additionalProperties: false,
    },
  },
  {
    name: "canvases.frameAdd",
    mcpName: "canvases_frameAdd",
    requiresConfirm: true,
    description:
      "Drop a named bounded region (frame) on a canvas. Children inside the frame move with it. Use as the container for storyboard layouts or as a Figma-style page when `isPage` is true.",
    paramsSchema: {
      type: "object",
      properties: {
        canvasId: { type: "string" },
        parentFrameId: { type: "string" },
        name: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
        isPage: { type: "boolean" },
      },
      required: ["canvasId", "x", "y", "width", "height"],
      additionalProperties: true,
    },
  },
  {
    name: "canvases.storyboardPlan",
    mcpName: "canvases_storyboardPlan",
    requiresConfirm: true,
    description:
      "Compound gesture: drop a labeled frame containing the plan card + a notes lane + a sources column + a next-steps lane. Reach for this when the operator asks you to lay out / storyboard / sketch a plan on the canvas.",
    paramsSchema: {
      type: "object",
      properties: {
        canvasId: { type: "string" },
        planId: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
      },
      required: ["canvasId", "planId"],
      additionalProperties: false,
    },
  },
  {
    name: "canvases.storyboardIssue",
    mcpName: "canvases_storyboardIssue",
    requiresConfirm: true,
    description:
      "Compound gesture: drop a labeled frame containing the issue card + a related-issues lane + a comments column + an attachments lane. Reach for this when the operator asks you to lay out / storyboard / sketch an issue on the canvas.",
    paramsSchema: {
      type: "object",
      properties: {
        canvasId: { type: "string" },
        issueId: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
      },
      required: ["canvasId", "issueId"],
      additionalProperties: false,
    },
  },
  {
    name: "canvases.storyboardResearch",
    mcpName: "canvases_storyboardResearch",
    requiresConfirm: true,
    description:
      "Compound gesture: drop a labeled frame containing a scratchpad + a sources column + a next-steps lane for an open-ended research topic.",
    paramsSchema: {
      type: "object",
      properties: {
        canvasId: { type: "string" },
        topic: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
      },
      required: ["canvasId", "topic"],
      additionalProperties: false,
    },
  },
  {
    name: "canvases.storyboardCustom",
    mcpName: "canvases_storyboardCustom",
    requiresConfirm: true,
    description:
      "Escape hatch when the three preset storyboards don't fit — compose a custom labeled frame with up to 12 named text panels at caller-specified positions.",
    paramsSchema: {
      type: "object",
      properties: {
        canvasId: { type: "string" },
        name: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
        panels: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              body: { type: "string" },
              x: { type: "number" },
              y: { type: "number" },
              width: { type: "number" },
              height: { type: "number" },
            },
            required: ["label", "x", "y", "width", "height"],
          },
        },
      },
      required: ["canvasId", "name", "panels"],
      additionalProperties: false,
    },
  },
  {
    name: "canvases.alignSelection",
    mcpName: "canvases_alignSelection",
    requiresConfirm: true,
    description:
      "Align / distribute / tidy-up a multi-selection on a canvas. Pass arrays of node/shape/frame/group/instance ids under `ids`. Op is one of alignLeft|alignCenter|alignRight|alignTop|alignMiddle|alignBottom|distributeH|distributeV|tidyUp.",
    paramsSchema: {
      type: "object",
      properties: {
        canvasId: { type: "string" },
        ids: {
          type: "object",
          properties: {
            nodeIds: { type: "array", items: { type: "string" } },
            shapeIds: { type: "array", items: { type: "string" } },
            frameIds: { type: "array", items: { type: "string" } },
            groupIds: { type: "array", items: { type: "string" } },
            instanceIds: { type: "array", items: { type: "string" } },
          },
        },
        op: { type: "string" },
      },
      required: ["canvasId", "ids", "op"],
      additionalProperties: false,
    },
  },
  {
    name: "notes.create",
    mcpName: "notes_create",
    requiresConfirm: true,
    description: "Create a personal note for the calling user.",
    paramsSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string", minLength: 1 },
        pinned: { type: "boolean", default: false },
      },
      required: ["body"],
      additionalProperties: false,
    },
  },
  {
    name: "notes.update",
    mcpName: "notes_update",
    requiresConfirm: true,
    description: "Patch fields on one of the caller's notes.",
    paramsSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: ["string", "null"] },
        body: { type: "string" },
        pinned: { type: "boolean" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "notes.setStatus",
    mcpName: "notes_setStatus",
    requiresConfirm: true,
    description:
      "Flip a note's lifecycle status: IDEA | SOMEDAY | ACTIVE | ARCHIVED. Useful when an idea is being parked, picked up, or retired.",
    paramsSchema: {
      type: "object",
      properties: {
        noteId: { type: "string" },
        status: { type: "string", enum: ["IDEA", "SOMEDAY", "ACTIVE", "ARCHIVED"] },
      },
      required: ["noteId", "status"],
      additionalProperties: false,
    },
  },
  {
    name: "notes.promote",
    mcpName: "notes_promote",
    requiresConfirm: true,
    description:
      "Promote a note into an Issue, Project, or Initiative. Stores the back-link both directions and flips the note's status to ACTIVE.",
    paramsSchema: {
      type: "object",
      properties: {
        noteId: { type: "string" },
        kind: { type: "string", enum: ["issue", "project", "initiative"] },
        title: { type: "string" },
        projectId: { type: "string" },
        initiativeId: { type: "string" },
      },
      required: ["noteId", "kind"],
      additionalProperties: false,
    },
  },
];

export const CHAT_TOOLS: ChatToolDef[] = [...READ_TOOLS, ...WRITE_TOOLS];

const BY_NAME = new Map<string, ChatToolDef>();
const BY_MCP_NAME = new Map<string, ChatToolDef>();
for (const t of CHAT_TOOLS) {
  BY_NAME.set(t.name, t);
  BY_MCP_NAME.set(t.mcpName, t);
}

export function findChatTool(name: string): ChatToolDef | undefined {
  return BY_NAME.get(name) ?? BY_MCP_NAME.get(name);
}

export function chatToolsAsOpenAITools(): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return CHAT_TOOLS.map((t) => ({
    type: "function",
    function: {
      name: t.mcpName,
      description: t.description,
      parameters: t.paramsSchema,
    },
  }));
}

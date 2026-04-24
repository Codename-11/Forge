-- Membership lifecycle event kinds. Emitted from workspace.addMember,
-- workspace.setMemberRole and workspace.removeMember in addition to the
-- AuditLog row so the activity feed + SSE fan-out cover admin-gated
-- member management the same way it does issues/projects.
ALTER TYPE "EventKind" ADD VALUE IF NOT EXISTS 'MEMBERSHIP_CREATED';
ALTER TYPE "EventKind" ADD VALUE IF NOT EXISTS 'MEMBERSHIP_ROLE_CHANGED';
ALTER TYPE "EventKind" ADD VALUE IF NOT EXISTS 'MEMBERSHIP_REMOVED';

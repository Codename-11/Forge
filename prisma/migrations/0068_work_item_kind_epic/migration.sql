-- Epics: add EPIC to WorkItemKind as the top tier above ISSUE.
-- An Epic is an Issue(kind=EPIC) whose children are its scope; reuses
-- the existing parent/child tree, relations DAG, cycles, and runs.
ALTER TYPE "WorkItemKind" ADD VALUE IF NOT EXISTS 'EPIC' BEFORE 'ISSUE';

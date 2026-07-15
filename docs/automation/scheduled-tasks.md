# Scheduled tasks

Scheduled tasks are Forge's first-class recurring automation surface. They are
separate from legacy recurring issues: existing recurring issue definitions and
their behavior are unchanged.

Open **Automation → Scheduled tasks** in a workspace to create and monitor a
task. Owners and admins can manage tasks; every workspace member can inspect
their schedule, current status, error state, and recent runs.

## Create-issue action

The initial supported action creates a real Forge issue through the same
canonical service used by the rest of the product. Configure:

- a task name and issue title;
- a prompt, which becomes the issue description;
- issue priority;
- delivery to the workspace inbox or an active project; and
- an interval, daily, or weekly schedule.

Daily and weekly schedules use an IANA timezone and retain their local
wall-clock time across daylight-saving changes. Interval schedules are elapsed
time based and run at least five minutes apart.

## Runs and failures

Every attempt gets a durable run row before the action begins. Successful runs
link to the issue they created. Failed runs retain a useful error message on
both the task and run history.

For scheduled attempts, Forge calculates and saves the next future occurrence
before executing the action. A failed action therefore remains visibly active
for its next run. Pausing is the only lifecycle action that clears `nextRunAt`;
resuming computes a new future occurrence.

**Run now** executes immediately without moving the regular future occurrence.
Deleting a task requires typing its exact name and removes its run history, but
keeps issues created by earlier runs.

## Worker operation

The BullMQ maintenance worker scans due tasks every minute. Run `pnpm worker`
alongside the web process in deployments that do not enable in-process workers.
The legacy `RecurringIssue` ticker continues independently.

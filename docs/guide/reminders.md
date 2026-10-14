# Personal reminders

Open an issue or task and expand **Reminder → Remind me**. Choose a date and
time or a preset, then select **Save reminder**. The time is interpreted in the
timezone shown by the form. Each person can keep one active reminder per item;
saving again replaces their own schedule.

Due reminders appear in **Notifications → Your reminders** and on the personal
Today dashboard. Each card includes the issue key and title, an issue link,
**Snooze 1 hour**, and **Dismiss reminder**. Opening a reminder marks it read;
marking notifications read preserves the card until it is dismissed or snoozed.
The issue's Reminder control also supports changing or canceling the schedule.

Reminders are private to their recipient and are checked against current
workspace and project access. Completing, canceling, archiving, or deleting the
item cancels its reminder; reopening does not revive a canceled reminder.
Setting a reminder does not modify due dates, add an issue comment, create a
decision request, or wake an agent.

In-app reminders are durable: they become visible by their scheduled time even
when background delivery is unavailable. Open surfaces refresh at most every
30 seconds. Optional browser push uses your existing Forge browser subscriptions
and the maintenance worker's one-minute sweep. Browser push is best effort;
delivery also depends on the browser, device, subscription, and instance VAPID
configuration. The in-app card remains available if push cannot be delivered.

A **due date** describes when work is due. **Snooze issue** hides work from
selected queues temporarily. **Scheduled tasks** create recurring issues.
None of those automatically schedules a personal reminder.

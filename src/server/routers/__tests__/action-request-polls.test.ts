import { afterAll, afterEach, describe, expect, it } from "vitest";
import { TRPCError } from "@trpc/server";
import { actionRequestRouter } from "@/server/routers/action-request";
import {
  buildContext,
  createIssue,
  createWorkspaceFixture,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "./helpers";

/**
 * Integration coverage for the multi-vote ActionRequest variant added
 * in migration 0050. Exercises the full flow: create-with-options →
 * vote → re-vote (changes pick) → close-voting → results carries the
 * winning option.
 *
 * Two-user-or-more polls are simulated by building a second caller for
 * `secondUser` so the per-user vote uniqueness holds without re-using
 * the same actorId for every vote.
 */

const fixtures: TestFixture[] = [];

afterEach(async () => {
  while (fixtures.length) {
    const f = fixtures.pop()!;
    await f.cleanup();
  }
});

afterAll(async () => {
  await disconnectPrisma();
});

async function setup() {
  const fixture = await createWorkspaceFixture({ keyPrefix: "POL" });
  fixtures.push(fixture);
  const ctx = await buildContext(fixture);
  const ctxAsSecond = await buildContext(fixture, { asUserId: fixture.secondUser.id });
  return {
    fixture,
    prisma: getPrisma(),
    callerAsUser1: actionRequestRouter.createCaller(ctx),
    callerAsUser2: actionRequestRouter.createCaller(ctxAsSecond),
  };
}

describe("actionRequest poll lifecycle", () => {
  it("creates a poll, accepts votes, lets users change their pick, and counts results", async () => {
    const { fixture, callerAsUser1, callerAsUser2 } = await setup();
    const issue = await createIssue(fixture);
    const created = await callerAsUser1.create({
      title: "How should we fix the flaky test?",
      body: "I see three viable paths.",
      issueId: issue.id,
      options: [
        { key: "retry", label: "Add retry-on-failure" },
        { key: "isolate", label: "Isolate the test in its own worker" },
        { key: "rewrite", label: "Rewrite against a deterministic fixture" },
      ],
    });

    // User 1 votes "retry" — fresh vote (not a change).
    const first = await callerAsUser1.vote({ id: created.id, optionKey: "retry" });
    expect(first.optionKey).toBe("retry");
    expect(first.changed).toBe(false);

    // User 1 changes their pick to "isolate".
    const changed = await callerAsUser1.vote({ id: created.id, optionKey: "isolate" });
    expect(changed.optionKey).toBe("isolate");
    expect(changed.changed).toBe(true);

    // User 2 votes "rewrite". Different user → fresh vote, not a change.
    await callerAsUser2.vote({ id: created.id, optionKey: "rewrite" });

    // Each user has exactly one vote — total = 2.
    const results = await callerAsUser1.results({ id: created.id });
    expect(results.total).toBe(2);
    const byKey = Object.fromEntries(results.options.map((o) => [o.optionKey, o.count]));
    expect(byKey).toEqual({ retry: 0, isolate: 1, rewrite: 1 });
    expect(results.myVote).toBe("isolate");
    // Voting still open — no winner declared yet.
    expect(results.votingClosedAt).toBeNull();
    expect(results.winningOptionKey).toBeNull();
  });

  it("closeVoting can only be called by the requester and returns the winning option", async () => {
    const { fixture, callerAsUser1, callerAsUser2 } = await setup();
    const issue = await createIssue(fixture);
    const created = await callerAsUser1.create({
      title: "Pick an approach",
      issueId: issue.id,
      options: [
        { key: "a", label: "Approach A" },
        { key: "b", label: "Approach B" },
      ],
    });

    // Both users vote A — A should win.
    await callerAsUser1.vote({ id: created.id, optionKey: "a" });
    await callerAsUser2.vote({ id: created.id, optionKey: "a" });

    // Non-requester (user 2) tries to close voting → FORBIDDEN.
    await expect(
      callerAsUser2.closeVoting({ id: created.id }),
    ).rejects.toBeInstanceOf(TRPCError);

    // Requester (user 1) closes voting → success, returns winner.
    const closed = await callerAsUser1.closeVoting({ id: created.id });
    expect(closed.winningOptionKey).toBe("a");

    // Subsequent results carry the winner + the closed timestamp.
    const post = await callerAsUser1.results({ id: created.id });
    expect(post.votingClosedAt).not.toBeNull();
    expect(post.winningOptionKey).toBe("a");

    // After close, votes are rejected.
    await expect(
      callerAsUser2.vote({ id: created.id, optionKey: "b" }),
    ).rejects.toBeInstanceOf(TRPCError);

    // Re-closing fails (already closed).
    await expect(
      callerAsUser1.closeVoting({ id: created.id }),
    ).rejects.toBeInstanceOf(TRPCError);
  });

  it("ties are broken by earliest first-vote timestamp", async () => {
    const { fixture, callerAsUser1, callerAsUser2 } = await setup();
    const issue = await createIssue(fixture);
    const created = await callerAsUser1.create({
      title: "Which way?",
      issueId: issue.id,
      options: [
        { key: "alpha", label: "Alpha" },
        { key: "beta", label: "Beta" },
      ],
    });

    // User 2 votes alpha FIRST (their vote pre-dates user 1's vote).
    await callerAsUser2.vote({ id: created.id, optionKey: "alpha" });
    // Tiny pause so the createdAt timestamps actually differ — the
    // default Postgres precision is microseconds but two upserts in
    // the same JS tick can collide.
    await new Promise((r) => setTimeout(r, 5));
    await callerAsUser1.vote({ id: created.id, optionKey: "beta" });

    const closed = await callerAsUser1.closeVoting({ id: created.id });
    // 1:1 tie — alpha wins because its first vote was earlier.
    expect(closed.winningOptionKey).toBe("alpha");
  });

  it("rejects votes for unknown option keys", async () => {
    const { fixture, callerAsUser1 } = await setup();
    const issue = await createIssue(fixture);
    const created = await callerAsUser1.create({
      title: "Pick one",
      issueId: issue.id,
      options: [
        { key: "yes", label: "Yes" },
        { key: "no", label: "No" },
      ],
    });
    await expect(
      callerAsUser1.vote({ id: created.id, optionKey: "maybe" }),
    ).rejects.toBeInstanceOf(TRPCError);
  });

  it("rejects vote calls against a non-poll ActionRequest", async () => {
    const { fixture, callerAsUser1 } = await setup();
    const issue = await createIssue(fixture);
    // No `options` → not a poll.
    const created = await callerAsUser1.create({
      title: "Plain request",
      issueId: issue.id,
    });
    await expect(
      callerAsUser1.vote({ id: created.id, optionKey: "anything" }),
    ).rejects.toBeInstanceOf(TRPCError);
  });
});

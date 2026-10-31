import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { describe, expect, it } from "vite-plus/test";

import { collectCompletedReplies, findRunReply } from "./readAloudCompletions";

const shell = (
  id: string,
  run: {
    readonly runId: string;
    readonly status?: string;
    readonly completedAt: string | null;
  } | null,
) =>
  ({
    environmentId: "env-1",
    id,
    projectId: "project-1",
    title: `Thread ${id}`,
    latestRun:
      run === null
        ? null
        : {
            runId: run.runId,
            status: run.status ?? "completed",
            requestedAt: "2026-10-28T10:00:00.000Z",
            startedAt: "2026-10-28T10:00:01.000Z",
            completedAt: run.completedAt,
            assistantMessageId: null,
          },
  }) as unknown as EnvironmentThreadShell;

describe("collectCompletedReplies", () => {
  it("stays silent for runs that finished before audio was switched on", () => {
    const seen = new Map<string, string | null>();
    const shells = [shell("a", { runId: "run-1", completedAt: "2026-10-28T10:01:00.000Z" })];
    expect(collectCompletedReplies(seen, shells)).toEqual([]);
    expect(collectCompletedReplies(seen, shells)).toEqual([]);
  });

  it("stays silent for threads that show up already finished, e.g. a late environment", () => {
    const seen = new Map<string, string | null>();
    collectCompletedReplies(seen, []);
    const late = [shell("a", { runId: "run-1", completedAt: "2026-10-28T10:01:00.000Z" })];
    expect(collectCompletedReplies(seen, late)).toEqual([]);
  });

  it("reports a run once when it moves from working to completed", () => {
    const seen = new Map<string, string | null>();
    collectCompletedReplies(seen, [shell("a", null)]);

    const working = [shell("a", { runId: "run-2", status: "running", completedAt: null })];
    expect(collectCompletedReplies(seen, working)).toEqual([]);

    const done = [shell("a", { runId: "run-2", completedAt: "2026-10-28T10:02:00.000Z" })];
    expect(collectCompletedReplies(seen, done)).toEqual([
      expect.objectContaining({
        threadId: "a",
        runId: "run-2",
        runStartedAt: "2026-10-28T10:00:01.000Z",
      }),
    ]);
    expect(collectCompletedReplies(seen, done)).toEqual([]);
  });

  it("skips runs that failed or were interrupted", () => {
    const seen = new Map<string, string | null>();
    collectCompletedReplies(seen, [shell("a", null), shell("b", null)]);
    const failed = [
      shell("a", { runId: "run-3", status: "failed", completedAt: "2026-10-28T10:03:00.000Z" }),
      shell("b", {
        runId: "run-4",
        status: "interrupted",
        completedAt: "2026-10-28T10:03:00.000Z",
      }),
    ];
    expect(collectCompletedReplies(seen, failed)).toEqual([]);
  });
});

describe("findRunReply", () => {
  const message = (
    id: string,
    createdAt: string,
    extra?: { streaming?: boolean; role?: string },
  ) => ({
    id,
    role: extra?.role ?? "assistant",
    streaming: extra?.streaming ?? false,
    text: `text ${id}`,
    createdAt,
  });

  it("returns the last finished assistant message of the run", () => {
    const messages = [
      message("old", "2026-10-28T09:00:00.000Z"),
      message("user", "2026-10-28T10:00:00.500Z", { role: "user" }),
      message("first", "2026-10-28T10:00:05.000Z"),
      message("last", "2026-10-28T10:00:09.000Z"),
    ];
    expect(findRunReply(messages, "2026-10-28T10:00:01.000Z")?.id).toBe("last");
  });

  it("never falls back to a reply from an earlier run", () => {
    const messages = [message("old", "2026-10-28T09:00:00.000Z")];
    expect(findRunReply(messages, "2026-10-28T10:00:01.000Z")).toBeNull();
  });
});

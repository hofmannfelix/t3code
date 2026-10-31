import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

export interface CompletedReply {
  readonly environmentId: EnvironmentThreadShell["environmentId"];
  readonly threadId: EnvironmentThreadShell["id"];
  readonly projectId: EnvironmentThreadShell["projectId"];
  readonly threadTitle: string;
  readonly runId: string;
  /** The reply is the last assistant message created since the run started. */
  readonly runStartedAt: string | null;
}

const threadKey = (shell: EnvironmentThreadShell) => `${shell.environmentId}:${shell.id}`;

/**
 * Finds runs that completed since the previous call. `seenRuns` maps each
 * thread to its last completed run already accounted for (`null` while it has
 * none) and is updated in place. A thread's first sighting only records it, so
 * replies that finished before the watcher knew the thread stay silent: those
 * from before audio was switched on, and those of an environment that connects
 * later.
 */
export function collectCompletedReplies(
  seenRuns: Map<string, string | null>,
  shells: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyArray<CompletedReply> {
  const completed: Array<CompletedReply> = [];
  for (const shell of shells) {
    const run = shell.latestRun;
    const key = threadKey(shell);
    // A still-running run is accounted for once it completes.
    const completedRunId = run !== null && run.completedAt !== null ? String(run.runId) : null;
    if (!seenRuns.has(key)) {
      seenRuns.set(key, completedRunId);
      continue;
    }
    if (run === null || completedRunId === null) continue;
    if (seenRuns.get(key) === completedRunId) continue;
    seenRuns.set(key, completedRunId);
    if (run.status !== "completed") continue;
    completed.push({
      environmentId: shell.environmentId,
      threadId: shell.id,
      projectId: shell.projectId,
      threadTitle: shell.title,
      runId: completedRunId,
      runStartedAt: run.startedAt ?? run.requestedAt,
    });
  }
  return completed;
}

interface ReplyCandidate {
  readonly id: string;
  readonly role: string;
  readonly streaming: boolean;
  readonly text: string;
  readonly createdAt?: unknown;
}

/** The finished assistant reply of a completed run, `null` when it has none. */
export function findRunReply<M extends ReplyCandidate>(
  messages: ReadonlyArray<M>,
  runStartedAt: string | null,
): M | null {
  const startedAtMs = runStartedAt === null ? Number.NaN : Date.parse(runStartedAt);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "assistant") continue;
    const createdAtMs = message.createdAt ? Date.parse(String(message.createdAt)) : Number.NaN;
    if (Number.isFinite(startedAtMs) && Number.isFinite(createdAtMs) && createdAtMs < startedAtMs) {
      return null;
    }
    if (message.streaming || message.text.trim().length === 0) continue;
    return message;
  }
  return null;
}

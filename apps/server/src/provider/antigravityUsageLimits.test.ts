import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";

import { cliWindows, makeAntigravityUsageProbe } from "./antigravityUsageLimits.ts";

const summary = {
  groups: [
    {
      displayName: "Gemini Models",
      buckets: [
        {
          bucketId: "gemini-weekly",
          window: "weekly",
          remainingFraction: 0.96,
          resetTime: "2026-10-12T19:41:43Z",
        },
        {
          bucketId: "gemini-5h",
          window: "5h",
          remainingFraction: 0.91,
          resetTime: "2026-10-09T16:06:01Z",
        },
      ],
    },
    {
      displayName: "Claude and GPT models",
      buckets: [
        {
          bucketId: "3p-weekly",
          window: "weekly",
          remainingFraction: 0,
          resetTime: "2026-10-10T15:28:22Z",
        },
        {
          bucketId: "3p-5h",
          window: "5h",
          remainingFraction: 0.44,
          resetTime: "2026-10-09T16:06:30Z",
        },
      ],
    },
  ],
};

const sampleCliOutput = JSON.stringify({
  status: "SUCCESS",
  command: {
    name: "usage",
    data: {
      description: "Model quota groups",
      groups: [
        {
          name: "Gemini Models",
          buckets: [
            {
              id: "gemini-weekly",
              name: "Weekly Limit Remaining",
              window: "weekly",
              remaining_fraction: 0.5169,
              reset_time: "2026-10-31T07:43:56Z",
            },
            {
              id: "gemini-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              remaining_fraction: 0.9594,
              reset_time: "2026-10-26T16:03:28Z",
            },
          ],
        },
        {
          name: "Claude and GPT models",
          buckets: [
            {
              id: "3p-weekly",
              name: "Weekly Limit Remaining",
              window: "weekly",
              remaining_fraction: 1,
              reset_time: "2026-11-02T12:06:04Z",
            },
            {
              id: "3p-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              remaining_fraction: 0.8,
              reset_time: "2026-10-26T17:06:04Z",
            },
          ],
        },
        {
          name: "Gemini 4 Argon",
          buckets: [
            {
              id: "gemini-argon-wtu-weekly",
              name: "Gemini 4 Argon Weekly Limit",
              window: "weekly",
              remaining_fraction: 0,
              reset_time: "2026-11-02T08:29:56Z",
            },
          ],
        },
      ],
    },
  },
});

const fixture = Effect.fn("AntigravityUsageTest.fixture")(function* (
  options: {
    summary?: unknown;
    /** Per-host quota summaries; hosts not listed fall back to `summary`. */
    summaryByHost?: Record<string, unknown>;
    models?: unknown;
    summaryStatus?: number;
    /** Per-host summary statuses; hosts not listed fall back to `summaryStatus`. */
    summaryStatusByHost?: Record<string, number>;
    tokenStatus?: number;
    refreshToken?: string;
    userId?: string;
    userInfoAt?: number;
    missingToken?: boolean;
    authMethod?: "oauth-personal" | "gemini-api-key";
    enableCli?: boolean;
    cliStdout?: string;
    cliExitCode?: number;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const profileDirectory = yield* fs.makeTempDirectoryScoped();
  yield* fs.makeDirectory(path.join(profileDirectory, "antigravity-acp"));
  const tokenPath = path.join(profileDirectory, "antigravity-acp", "acp_token.json");
  const writeToken = (refreshToken: string) =>
    fs.writeFileString(
      tokenPath,
      JSON.stringify({
        client_id: "client-id",
        client_secret: "client-secret",
        refresh_token: refreshToken,
        project_id: "project-id",
      }),
    );
  if (!options.missingToken) yield* writeToken(options.refreshToken ?? "refresh-a");
  const requests: Array<{ url: string; body: string }> = [];
  const http = HttpClient.make((request, url, _signal, fiber) =>
    Effect.sync(() => {
      const init = Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit);
      expect(init?.redirect).toBe("manual");
      const body =
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
      requests.push({ url: request.url, body });
      if (request.url.endsWith("/token")) {
        expect(new URLSearchParams(body).get("grant_type")).toBe("refresh_token");
        return HttpClientResponse.fromWeb(
          request,
          Response.json(
            { access_token: "access-token", expires_in: 3600 },
            { status: options.tokenStatus ?? 200 },
          ),
        );
      }
      expect(request.headers.authorization).toBe("Bearer access-token");
      if (request.url.endsWith("/userinfo")) {
        return HttpClientResponse.fromWeb(
          request,
          options.userId
            ? Response.json({ id: options.userId, email: "someone@example.com" })
            : Response.json({}, { status: 403 }),
        );
      }
      expect(JSON.parse(body)).toEqual({ project: "project-id" });
      expect(request.headers["user-agent"]).toMatch(/^antigravity\/hub\/2\.24\.0 /);
      return HttpClientResponse.fromWeb(
        request,
        request.url.endsWith(":retrieveUserQuotaSummary")
          ? Response.json(options.summaryByHost?.[url.host] ?? options.summary ?? summary, {
              status: options.summaryStatusByHost?.[url.host] ?? options.summaryStatus ?? 200,
            })
          : Response.json(options.models ?? { models: {} }),
      );
    }).pipe(
      Effect.tap(() =>
        request.url.endsWith("/userinfo") && options.userInfoAt !== undefined
          ? TestClock.setTime(options.userInfoAt)
          : Effect.void,
      ),
    ),
  );

  let binaryPath: string | undefined;
  if (options.enableCli) {
    binaryPath = path.join(profileDirectory, "mock-agy");
    yield* fs.writeFileString(binaryPath, "#!/bin/sh\n");
    yield* fs.chmod(binaryPath, 0o755);
  }
  const mockSpawner = ChildProcessSpawner.make(() =>
    Effect.sync(() =>
      ChildProcessSpawner.makeHandle({
        stdout: Stream.make(new TextEncoder().encode(options.cliStdout ?? "")),
        stderr: Stream.empty,
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(options.cliExitCode ?? 0)),
        pid: ChildProcessSpawner.ProcessId(9999),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    ),
  );

  const usage = yield* makeAntigravityUsageProbe({
    profileDirectory,
    authMethod: options.authMethod ?? "oauth-personal",
    ...(binaryPath !== undefined ? { binaryPath } : {}),
    ...(options.enableCli !== undefined ? { enableCli: options.enableCli } : {}),
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, http),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, mockSpawner),
  );
  return { ...usage, requests, writeToken, tokenPath };
});

describe("Antigravity subscription limits", () => {
  // Oracle: the 10:16 UTC payload and its narrow Workaround rule.
  it.effect("omits rolling resets for untouched summary buckets and keeps used Gemini resets", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-21T10:16:04Z")));
      const { probe } = yield* fixture({
        summary: {
          groups: [
            {
              buckets: [
                {
                  bucketId: "3p-5h",
                  window: "5h",
                  remainingFraction: 1,
                  resetTime: "2026-10-21T15:16:05Z",
                },
                {
                  bucketId: "3p-weekly",
                  window: "weekly",
                  remainingFraction: 1,
                  resetTime: "2026-10-28T10:16:05Z",
                },
                {
                  bucketId: "gemini-5h",
                  window: "5h",
                  remainingFraction: 0.848104,
                  resetTime: "2026-10-21T13:29:53Z",
                  description:
                    "You have used some of your 5-hour limit, it will fully refresh in 3 hours, 13 minutes.",
                },
                {
                  bucketId: "gemini-weekly",
                  window: "weekly",
                  remainingFraction: 0.9620177,
                  resetTime: "2026-10-28T08:29:53Z",
                  description:
                    "You have used some of your weekly limit, it will fully refresh in 6 days, 22 hours.",
                },
              ],
            },
          ],
        },
      });
      const limits = yield* probe;
      const byId = new Map(limits.windows.map((window) => [window.id, window]));
      expect(byId.get("3p-5h")).toEqual({
        id: "3p-5h",
        label: "Claude & GPT (shared) · 5-hour",
        kind: "session",
        usedPercent: 0,
        windowDurationMins: 300,
      });
      expect(byId.get("3p-weekly")).toEqual({
        id: "3p-weekly",
        label: "Claude & GPT (shared) · Weekly",
        kind: "weekly",
        usedPercent: 0,
        windowDurationMins: 10080,
      });
      expect(byId.get("gemini-5h")?.resetsAt).toBe("2026-10-21T13:29:53.000Z");
      expect(byId.get("gemini-weekly")?.resetsAt).toBe("2026-10-28T08:29:53.000Z");
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  // Oracle: measure the tolerance from the summary request, after auth.
  it.effect("uses summary request time after authentication for the reset tolerance", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-21T10:16:02Z")));
      const { probe } = yield* fixture({
        userInfoAt: DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-21T10:16:04Z")),
        summary: {
          buckets: [
            {
              bucketId: "3p-5h",
              window: "5h",
              remainingFraction: 1,
              resetTime: "2026-10-21T15:17:03Z",
            },
          ],
        },
      });
      expect((yield* probe).windows[0]?.resetsAt).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  // Oracle: keep descriptions, measured resets, and spent buckets.
  it.effect("keeps summary resets with a description, a distant reset, or no quota left", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-21T10:16:04Z")));
      const { probe } = yield* fixture({
        summary: {
          buckets: [
            {
              bucketId: "described",
              window: "5h",
              remainingFraction: 1,
              description: "Reported reset",
              resetTime: "2026-10-21T15:16:04Z",
            },
            {
              bucketId: "distant",
              window: "weekly",
              remainingFraction: 1,
              resetTime: "2026-10-28T12:16:04Z",
            },
            {
              bucketId: "spent",
              window: "5h",
              remainingFraction: 0,
              resetTime: "2026-10-21T15:16:04Z",
            },
            {
              bucketId: "overfull",
              window: "5h",
              remainingFraction: 1.01,
              resetTime: "2026-10-21T15:16:04Z",
            },
            {
              bucketId: "empty-description",
              window: "5h",
              remainingFraction: 1,
              description: "",
              resetTime: "2026-10-21T15:16:04Z",
            },
          ],
        },
      });
      expect((yield* probe).windows.map(({ id, resetsAt }) => ({ id, resetsAt }))).toEqual([
        { id: "described", resetsAt: "2026-10-21T15:16:04.000Z" },
        { id: "empty-description", resetsAt: "2026-10-21T15:16:04.000Z" },
        { id: "overfull", resetsAt: "2026-10-21T15:16:04.000Z" },
        { id: "spent", resetsAt: "2026-10-21T15:16:04.000Z" },
        { id: "distant", resetsAt: "2026-10-28T12:16:04.000Z" },
      ]);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  // Oracle: the 60-second tolerance applies to both known window lengths.
  it.effect("omits summary resets 59 seconds away but keeps resets 61 seconds away", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-21T10:16:04Z")));
      const { probe } = yield* fixture({
        summary: {
          buckets: [
            {
              bucketId: "5h-before",
              window: "5h",
              remainingFraction: 1,
              resetTime: "2026-10-21T15:15:05Z",
            },
            {
              bucketId: "5h-after",
              window: "5h",
              remainingFraction: 1,
              resetTime: "2026-10-21T15:17:05Z",
            },
            {
              bucketId: "5h-edge",
              window: "5h",
              remainingFraction: 1,
              resetTime: "2026-10-21T15:17:04Z",
            },
            {
              bucketId: "weekly-after",
              window: "weekly",
              remainingFraction: 1,
              resetTime: "2026-10-28T10:17:03Z",
            },
            {
              bucketId: "weekly-before",
              window: "weekly",
              remainingFraction: 1,
              resetTime: "2026-10-28T10:15:03Z",
            },
            {
              bucketId: "weekly-edge",
              window: "weekly",
              remainingFraction: 1,
              resetTime: "2026-10-28T10:15:04Z",
            },
          ],
        },
      });
      expect((yield* probe).windows.map(({ id, resetsAt }) => ({ id, resetsAt }))).toEqual([
        { id: "5h-after", resetsAt: "2026-10-21T15:17:05.000Z" },
        { id: "5h-before", resetsAt: undefined },
        { id: "5h-edge", resetsAt: undefined },
        { id: "weekly-after", resetsAt: undefined },
        { id: "weekly-before", resetsAt: "2026-10-28T10:15:03.000Z" },
        { id: "weekly-edge", resetsAt: undefined },
      ]);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  // Oracle: the existing endpoint merge keeps the most-used reading.
  it.effect("keeps the used endpoint reading and its reset over an untouched reading", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-21T10:16:04Z")));
      const { probe } = yield* fixture({
        summaryByHost: {
          "daily-cloudcode-pa.googleapis.com": {
            buckets: [
              {
                bucketId: "3p-5h",
                window: "5h",
                remainingFraction: 1,
                resetTime: "2026-10-21T15:16:04Z",
              },
              {
                bucketId: "3p-weekly",
                window: "weekly",
                remainingFraction: 0.5,
                resetTime: "2026-10-27T10:16:04Z",
              },
            ],
          },
          "cloudcode-pa.googleapis.com": {
            buckets: [
              {
                bucketId: "3p-5h",
                window: "5h",
                remainingFraction: 0.5,
                resetTime: "2026-10-21T13:16:04Z",
              },
              {
                bucketId: "3p-weekly",
                window: "weekly",
                remainingFraction: 1,
                resetTime: "2026-10-28T10:16:04Z",
              },
            ],
          },
        },
      });
      expect((yield* probe).windows).toEqual([
        {
          id: "3p-5h",
          label: "Claude & GPT (shared) · 5-hour",
          kind: "session",
          usedPercent: 50,
          windowDurationMins: 300,
          resetsAt: "2026-10-21T13:16:04.000Z",
        },
        {
          id: "3p-weekly",
          label: "Claude & GPT (shared) · Weekly",
          kind: "weekly",
          usedPercent: 50,
          windowDurationMins: 10080,
          resetsAt: "2026-10-27T10:16:04.000Z",
        },
      ]);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  // Oracle: model quotas have no evidence for the summary-only rule.
  it.effect("keeps full model fallback resets even at a full window from the request", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-21T10:16:04Z")));
      const { probe } = yield* fixture({
        summaryStatus: 404,
        models: {
          models: {
            "gemini-a": {
              quotaInfo: { remainingFraction: 1, resetTime: "2026-10-21T15:16:04Z" },
              weeklyQuotaInfo: { remainingFraction: 1, resetTime: "2026-10-28T10:16:04Z" },
            },
          },
        },
      });
      expect(
        (yield* probe).windows.map(({ id, resetsAt, windowDurationMins }) => ({
          id,
          resetsAt,
          windowDurationMins,
        })),
      ).toEqual([
        { id: "gemini-weekly", resetsAt: "2026-10-28T10:16:04.000Z", windowDurationMins: 10080 },
        { id: "gemini-quota", resetsAt: "2026-10-21T15:16:04.000Z", windowDurationMins: undefined },
      ]);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("reports separate Gemini and shared Claude/GPT five-hour and weekly limits", () =>
    Effect.gen(function* () {
      const { probe, requests } = yield* fixture();
      const limits = yield* probe;
      expect(limits.windows).toHaveLength(4);
      expect(limits.unavailable).toBeUndefined();
      expect(limits.credentialFingerprint).toMatch(/^[0-9a-f]{64}$/);
      const byId = new Map(limits.windows.map((window) => [window.id, window]));
      expect(byId.get("gemini-weekly")?.usedPercent).toBeCloseTo(4);
      expect(byId.get("gemini-5h")?.usedPercent).toBeCloseTo(9);
      expect(byId.get("3p-weekly")).toMatchObject({
        label: "Claude & GPT (shared) · Weekly",
        kind: "weekly",
        usedPercent: 100,
        windowDurationMins: 10080,
        resetsAt: "2026-10-10T15:28:22.000Z",
      });
      expect(byId.get("3p-5h")).toMatchObject({ kind: "session", windowDurationMins: 300 });
      expect(byId.get("3p-5h")?.usedPercent).toBeCloseTo(56);
      yield* probe;
      expect(requests.filter((request) => request.url.endsWith("/token"))).toHaveLength(1);
      expect(
        requests.filter((request) => request.url.endsWith(":retrieveUserQuotaSummary")),
      ).toHaveLength(4);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("merges quota groups that only one endpoint reports", () =>
    Effect.gen(function* () {
      const { probe } = yield* fixture({
        summaryByHost: {
          // The daily endpoint can omit Gemini while the other endpoint returns all groups.
          "daily-cloudcode-pa.googleapis.com": {
            groups: [
              {
                displayName: "Claude and GPT models",
                buckets: [
                  { bucketId: "3p-weekly", window: "weekly", remainingFraction: 0.5 },
                  { bucketId: "3p-5h", window: "5h", remainingFraction: 0.3 },
                ],
              },
            ],
          },
        },
      });
      const limits = yield* probe;
      expect(limits.windows.map((window) => window.id).toSorted()).toEqual([
        "3p-5h",
        "3p-weekly",
        "gemini-5h",
        "gemini-weekly",
      ]);
      const byId = new Map(limits.windows.map((window) => [window.id, window]));
      expect(byId.get("gemini-weekly")?.label).toBe("Gemini · Weekly");
      expect(byId.get("3p-5h")?.usedPercent).toBeCloseTo(70);
      expect(byId.get("3p-weekly")?.usedPercent).toBe(100);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("labels Argon's weekly quota apart from the default Gemini weekly quota", () =>
    Effect.gen(function* () {
      const { probe } = yield* fixture({
        summary: {
          groups: [
            ...summary.groups,
            {
              displayName: "Gemini 4 Argon",
              buckets: [
                { bucketId: "gemini-argon-wtu-weekly", window: "weekly", remainingFraction: 0.6 },
              ],
            },
          ],
        },
      });
      const limits = yield* probe;
      const byId = new Map(limits.windows.map((window) => [window.id, window]));
      expect(byId.get("gemini-weekly")?.label).toBe("Gemini · Weekly");
      expect(byId.get("gemini-argon-wtu-weekly")?.label).toBe("Gemini 4 Argon · Weekly");
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("keeps one endpoint's quotas when the other fails", () =>
    Effect.gen(function* () {
      const { probe } = yield* fixture({
        summaryStatusByHost: { "daily-cloudcode-pa.googleapis.com": 503 },
      });
      const limits = yield* probe;
      expect(limits.unavailable).toBeUndefined();
      expect(limits.windows).toHaveLength(4);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("re-reads changed credentials and clears cached access after sign-out", () =>
    Effect.gen(function* () {
      const { probe, clear, requests, writeToken, tokenPath } = yield* fixture();
      const first = yield* probe;
      yield* writeToken("refresh-b");
      const second = yield* probe;
      expect(second.credentialFingerprint).not.toBe(first.credentialFingerprint);
      expect(requests.filter((request) => request.url.endsWith("/token"))).toHaveLength(2);
      yield* (yield* FileSystem.FileSystem).remove(tokenPath);
      expect((yield* probe).unavailable?.reason).toBe("unsupported");
      yield* writeToken("refresh-b");
      yield* probe;
      expect(requests.filter((request) => request.url.endsWith("/token"))).toHaveLength(3);
      yield* clear;
      yield* probe;
      expect(requests.filter((request) => request.url.endsWith("/token"))).toHaveLength(4);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("names one Google account the same way from every sign-in", () =>
    Effect.gen(function* () {
      const read = (refreshToken: string, userId: string) =>
        fixture({ refreshToken, userId }).pipe(Effect.flatMap((usage) => usage.probe));
      const machineA = yield* read("refresh-a", "google-user-1");
      const machineB = yield* read("refresh-b", "google-user-1");
      const otherAccount = yield* read("refresh-c", "google-user-2");
      expect(machineA.credentialFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(machineB.credentialFingerprint).toBe(machineA.credentialFingerprint);
      expect(otherAccount.credentialFingerprint).not.toBe(machineA.credentialFingerprint);
      expect(JSON.stringify(machineA)).not.toMatch(/google-user-1|someone@example.com/);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("falls back to model quotas without inventing a window duration", () =>
    Effect.gen(function* () {
      const { probe } = yield* fixture({
        summaryStatus: 404,
        models: {
          models: {
            "gemini-a": {
              modelProvider: "MODEL_PROVIDER_GOOGLE",
              quotaInfo: { remainingFraction: 0.8, resetTime: "2026-10-10T12:00:00Z" },
            },
            "gemini-b": {
              modelProvider: "MODEL_PROVIDER_GOOGLE",
              quotaInfo: { remainingFraction: 0.6, resetTime: "2026-10-10T12:00:00Z" },
            },
            "claude-a": { quotaInfo: { remainingFraction: 0.2 } },
          },
        },
      });
      const limits = yield* probe;
      expect(limits.windows).toHaveLength(2);
      expect(limits.windows.find((window) => window.id === "gemini-quota")?.usedPercent).toBe(40);
      expect(
        limits.windows.every(
          (window) => window.kind === "other" && window.windowDurationMins === undefined,
        ),
      ).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("merges model quotas when retrieveUserQuotaSummary only returns 3P quotas", () =>
    Effect.gen(function* () {
      const { probe } = yield* fixture({
        summary: {
          groups: [
            {
              displayName: "Claude and GPT models",
              buckets: [
                { bucketId: "3p-weekly", window: "weekly", remainingFraction: 0.5 },
                { bucketId: "3p-5h", window: "5h", remainingFraction: 0.7 },
              ],
            },
          ],
        },
        models: {
          models: {
            "gemini-2.5-pro": {
              modelProvider: "MODEL_PROVIDER_GOOGLE",
              quotaInfo: { remainingFraction: 0.85, resetTime: "2026-10-26T18:00:00Z" },
            },
          },
        },
      });
      const limits = yield* probe;
      expect(limits.windows.map((w) => w.id).toSorted()).toEqual([
        "3p-5h",
        "3p-weekly",
        "gemini-quota",
      ]);
      const geminiWindow = limits.windows.find((w) => w.id === "gemini-quota");
      expect(geminiWindow?.label).toBe("Gemini · Reported quota");
      expect(geminiWindow?.usedPercent).toBeCloseTo(15);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("skips disabled and missing fractions and clamps valid percentages", () =>
    Effect.gen(function* () {
      const { probe } = yield* fixture({
        summary: {
          buckets: [
            { bucketId: "disabled", remainingFraction: 0, disabled: true },
            { bucketId: "missing", resetTime: "2026-10-10T12:00:00Z" },
            { bucketId: "gemini-5h", window: "5h", remainingFraction: 2, resetTime: "invalid" },
          ],
        },
      });
      expect((yield* probe).windows).toEqual([
        {
          id: "gemini-5h",
          kind: "session",
          label: "Gemini · 5-hour",
          usedPercent: 0,
          windowDurationMins: 300,
        },
      ]);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("returns a safe failure when OAuth refresh fails", () =>
    Effect.gen(function* () {
      const { probe } = yield* fixture({ tokenStatus: 401 });
      const limits = yield* probe;
      expect(limits.windows).toEqual([]);
      expect(limits.unavailable?.reason).toBe("probeFailed");
      expect(JSON.stringify(limits)).not.toMatch(/client-secret|refresh-a|access-token/);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("does not make network requests for API keys or missing sign-ins", () =>
    Effect.gen(function* () {
      for (const options of [{ authMethod: "gemini-api-key" as const }, { missingToken: true }]) {
        const { probe, requests } = yield* fixture(options);
        expect((yield* probe).unavailable?.reason).toBe("unsupported");
        expect(requests).toEqual([]);
      }
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it("maps CLI usage output buckets to provider windows", () => {
    const raw = JSON.parse(sampleCliOutput).command.data;
    const windows = cliWindows(raw);
    expect(windows).toHaveLength(5);
    const byId = new Map(windows.map((w) => [w.id, w]));

    expect(byId.get("gemini-weekly")).toMatchObject({
      label: "Gemini · Weekly",
      kind: "weekly",
      windowDurationMins: 10080,
      resetsAt: "2026-10-31T07:43:56.000Z",
    });
    expect(byId.get("gemini-weekly")?.usedPercent).toBeCloseTo(48.31);

    expect(byId.get("gemini-5h")).toMatchObject({
      label: "Gemini · 5-hour",
      kind: "session",
      windowDurationMins: 300,
      resetsAt: "2026-10-26T16:03:28.000Z",
    });
    expect(byId.get("gemini-5h")?.usedPercent).toBeCloseTo(4.06);

    expect(byId.get("3p-weekly")).toMatchObject({
      label: "Claude & GPT (shared) · Weekly",
      kind: "weekly",
      windowDurationMins: 10080,
      usedPercent: 0,
    });

    expect(byId.get("3p-5h")).toMatchObject({
      label: "Claude & GPT (shared) · 5-hour",
      kind: "session",
      windowDurationMins: 300,
    });
    expect(byId.get("3p-5h")?.usedPercent).toBeCloseTo(20);

    expect(byId.get("gemini-argon-wtu-weekly")).toMatchObject({
      label: "Gemini 4 Argon · Weekly",
      kind: "weekly",
      windowDurationMins: 10080,
      usedPercent: 100,
    });
  });

  it.effect("reads complete usage limits via CLI output when enableCli is true", () =>
    Effect.gen(function* () {
      const { probe, requests } = yield* fixture({
        enableCli: true,
        cliStdout: sampleCliOutput,
      });
      const limits = yield* probe;
      expect(limits.windows).toHaveLength(5);
      expect(limits.unavailable).toBeUndefined();
      expect(limits.credentialFingerprint).toMatch(/^[0-9a-f]{64}$/);

      // Verify windows are ordered: session windows first, then weekly windows
      expect(limits.windows.map((w) => w.kind)).toEqual([
        "session",
        "session",
        "weekly",
        "weekly",
        "weekly",
      ]);

      // CLI succeeded, so HTTP quota summary was not called
      expect(requests.filter((r) => r.url.endsWith(":retrieveUserQuotaSummary"))).toHaveLength(0);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("falls back to HTTP endpoints when CLI execution returns an error exit code", () =>
    Effect.gen(function* () {
      const { probe, requests } = yield* fixture({
        enableCli: true,
        cliExitCode: 1,
        cliStdout: "error: failed to run agy",
      });
      const limits = yield* probe;
      // Falls back to HTTP fixture default summary
      expect(limits.windows).toHaveLength(4);
      expect(requests.filter((r) => r.url.endsWith(":retrieveUserQuotaSummary"))).toHaveLength(2);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );
});

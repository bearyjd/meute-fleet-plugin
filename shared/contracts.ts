import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const ERROR_CODES = [
  "not_configured",
  "invalid_config",
  "invalid_input",
  "not_found",
  "unsafe_path",
  "too_large",
  "unavailable",
  "timeout",
  "truncated",
  "exit_nonzero",
  "malformed",
  "unsupported_version",
  "internal",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ApiErrorSchema = z.object({
  code: z.enum(ERROR_CODES),
  // Never contains an absolute host path or environment value.
  message: z.string(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

/** Every RPC answers with an envelope so a failure is data, not a thrown error. */
export function envelope<T extends z.ZodType>(data: T) {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), observedAt: z.string(), data }),
    z.object({ ok: z.literal(false), observedAt: z.string(), error: ApiErrorSchema }),
  ]);
}
export type Envelope<T> =
  | { ok: true; observedAt: string; data: T }
  | { ok: false; observedAt: string; error: ApiError };

export const FindingSchema = z.object({
  id: z.string(),
  report: z.string(),
  n: z.number().int(),
  repo: z.string(),
  severity: z.string(),
  title: z.string(),
  location: z.string().default(""),
  state: z.string(),
  inherited: z.string().default(""),
  verdict: z.string().default(""),
  pr: z.string().default(""),
});
export type Finding = z.infer<typeof FindingSchema>;

export const FindingsDataSchema = z.object({
  findings: z.array(FindingSchema),
  // Reports meute could not read; the inbox is incomplete when this is above zero.
  skipped: z.number().int(),
});
export type FindingsData = z.infer<typeof FindingsDataSchema>;

export const FindingDetailSchema = z.object({
  id: z.string(),
  severity: z.string(),
  title: z.string(),
  excerpt: z.string(),
  truncated: z.boolean(),
});
export type FindingDetail = z.infer<typeof FindingDetailSchema>;

export const ReadinessCheckSchema = z.object({
  check: z.string(),
  status: z.string(),
  reason: z.string(),
  purpose: z.string().optional(),
  detail: z.string().optional(),
});
export type ReadinessCheck = z.infer<typeof ReadinessCheckSchema>;

export const ReadinessDataSchema = z.object({
  // Anything other than a consistent exit 0 plus status "ready" is never reported as ready.
  verdict: z.enum(["ready", "pending", "invalid"]),
  exitCode: z.number().int(),
  version: z.number().int(),
  scope: z.record(z.string(), z.string()).optional(),
  checks: z.array(ReadinessCheckSchema),
  meuteObservedAt: z.string().optional(),
});
export type ReadinessData = z.infer<typeof ReadinessDataSchema>;

export const HealthDataSchema = z.object({
  // "unknown" covers every outcome that is not a clean exit 0 with empty output.
  state: z.enum(["healthy", "unhealthy", "unknown"]),
  problems: z.array(z.string()),
});
export type HealthData = z.infer<typeof HealthDataSchema>;

export const LogEntrySchema = z.object({
  time: z.string(),
  fields: z.record(z.string(), z.string()),
});
export type LogEntry = z.infer<typeof LogEntrySchema>;

export const LockSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("none") }),
  z.object({
    state: z.literal("info"),
    pid: z.number().int().nullable(),
    alive: z.boolean().nullable(),
    startedAt: z.string(),
    slot: z.string(),
    key: z.string(),
  }),
]);

export const QueueSchema = z.object({
  present: z.boolean(),
  size: z.number().int(),
  names: z.array(z.string()),
});

const part = <T extends z.ZodType>(data: T) =>
  z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), data }),
    z.object({ ok: z.literal(false), error: ApiErrorSchema }),
  ]);

export const RunStatusDataSchema = z.object({
  lock: part(LockSchema),
  log: part(
    z.object({
      size: z.number().int(),
      entries: z.array(LogEntrySchema),
      partial: z.boolean(),
    }),
  ),
  queue: part(QueueSchema),
});
export type RunStatusData = z.infer<typeof RunStatusDataSchema>;

const empty = z.object({});

export const listFindingsRpc = defineRpc({
  name: "fleet.findings.list",
  input: empty,
  output: envelope(FindingsDataSchema),
});
export const getFindingRpc = defineRpc({
  name: "fleet.finding.get",
  input: z.object({ id: z.string().max(300) }),
  output: envelope(FindingDetailSchema),
});
export const readinessRpc = defineRpc({
  name: "fleet.readiness.get",
  input: empty,
  output: envelope(ReadinessDataSchema),
});
export const healthRpc = defineRpc({
  name: "fleet.health.get",
  input: empty,
  output: envelope(HealthDataSchema),
});
export const runStatusRpc = defineRpc({
  name: "fleet.run.status",
  input: z.object({ lines: z.number().int().min(1).max(100).default(20) }),
  output: envelope(RunStatusDataSchema),
});

export const ALL_RPCS = [listFindingsRpc, getFindingRpc, readinessRpc, healthRpc, runStatusRpc];

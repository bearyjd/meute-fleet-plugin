// RPC implementations. Read-only: meute is reached only through runAllowlisted, files only
// through safefs. Every function answers with an envelope and never throws.
import type {
  ApiError, Envelope, FindingDetail, FindingsData, HealthData, ReadinessData, RunStatusData,
} from "../shared/contracts";
import { parseFindingId } from "../shared/validate";
import type { FleetConfig } from "./config";
import {
  extractFindingExcerpt, parseFindings, parseHealth, parseLockInfo, parseLogLine, parsePlanQueue,
  parseReadiness, type Result,
} from "./parsers";
import { runAllowlisted, type RunOutcome } from "./runner";
import { readLockInfo, readPlanQueue, readReportFile, tailLog, type FsError } from "./safefs";

const now = () => new Date().toISOString();
const success = <T>(data: T): Envelope<T> => ({ ok: true, observedAt: now(), data });
const failure = (error: ApiError): Envelope<never> => ({ ok: false, observedAt: now(), error });
const fromResult = <T>(result: Result<T>): Envelope<T> => (result.ok ? success(result.data) : failure(result.error));
const fromFs = (error: FsError): ApiError => ({ code: error.code, message: error.message });
/** Configured paths that may appear in meute's text; redacted whole even if they contain spaces. */
const knownPaths = (config: FleetConfig): string[] =>
  [config.meuteRoot, config.readinessRecordPath, config.readinessPolicyPath, config.xdgRuntimeDir]
    .filter((path): path is string => typeof path === "string" && path !== "");
const fromRun = (outcome: Extract<RunOutcome, { ok: false }>): ApiError => ({ code: outcome.code, message: outcome.message });

export async function listFindings(config: FleetConfig): Promise<Envelope<FindingsData>> {
  const outcome = await runAllowlisted(config, "findings_list");
  if (!outcome.ok) return failure(fromRun(outcome));
  return fromResult(parseFindings(outcome.stdout, outcome.stderr));
}

export async function getFinding(config: FleetConfig, input: { id: string }): Promise<Envelope<FindingDetail>> {
  const ref = parseFindingId(input.id);
  if (!ref) return failure({ code: "invalid_input", message: "Invalid finding id" });
  const file = await readReportFile(config.meuteRoot, ref.repo, ref.name);
  if (!file.ok) return failure(fromFs(file));
  const excerpt = extractFindingExcerpt(file.text, ref.n);
  if (!excerpt.ok) return failure(excerpt.error);
  return success({ ...excerpt.data, id: input.id });
}

export async function readiness(config: FleetConfig): Promise<Envelope<ReadinessData>> {
  const { readinessRecordPath: record, readinessPolicyPath: policy } = config;
  if (!record || !policy) {
    return failure({ code: "not_configured", message: "Set the readiness record and owner policy paths in the plugin settings" });
  }
  const outcome = await runAllowlisted(config, "readiness_validate", { record, policy });
  if (!outcome.ok) return failure(fromRun(outcome));
  return fromResult(parseReadiness(outcome.exitCode, outcome.stdout, knownPaths(config)));
}

export async function health(config: FleetConfig): Promise<Envelope<HealthData>> {
  const outcome = await runAllowlisted(config, "health");
  if (!outcome.ok) return failure(fromRun(outcome));
  const result = parseHealth(outcome.exitCode, outcome.stdout, outcome.stderr, knownPaths(config));
  // Only a healthy verdict needs the positive signal; reported problems stand on their own. The
  // signal is the runner's own report that THIS child got XDG_RUNTIME_DIR (M3), never a second probe.
  if (result.ok && result.data.state === "healthy" && !outcome.runtime.ok) {
    return success({ state: "unknown", problems: [outcome.runtime.message] });
  }
  return fromResult(result);
}

export async function runStatus(config: FleetConfig, input: { lines: number }): Promise<Envelope<RunStatusData>> {
  const root = config.meuteRoot;
  const [lockFile, logTail, queueFile] = await Promise.all([
    readLockInfo(root),
    tailLog(root, { lines: input.lines }),
    readPlanQueue(root),
  ]);

  const lock: RunStatusData["lock"] = lockFile.ok
    ? parsed(parseLockInfo(lockFile.text))
    : lockFile.code === "not_found"
      ? { ok: true, data: { state: "none" } }
      : { ok: false, error: fromFs(lockFile) };

  const log: RunStatusData["log"] = logTail.ok
    ? {
        ok: true,
        data: {
          size: logTail.size,
          partial: logTail.partial,
          entries: logTail.lines.flatMap((line) => parseLogLine(line) ?? []),
        },
      }
    : logTail.code === "not_found"
      ? { ok: true, data: { size: 0, partial: false, entries: [] } }
      : { ok: false, error: fromFs(logTail) };

  const queue: RunStatusData["queue"] = queueFile.ok
    ? parsed(parsePlanQueue(queueFile.text))
    : queueFile.code === "not_found"
      ? { ok: true, data: { present: false, size: 0, names: [] } }
      : { ok: false, error: fromFs(queueFile) };

  return success({ lock, log, queue });
}

function parsed<T>(result: Result<T>): { ok: true; data: T } | { ok: false; error: ApiError } {
  return result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error };
}

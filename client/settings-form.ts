import type { FleetSettingsValues } from "../shared/settings";
import { isSafeAbsolutePath, isSafePathList } from "../shared/validate";

export type SettingsField = keyof FleetSettingsValues;

export const FIELD_LABELS: Readonly<Record<SettingsField, { label: string; hint: string }>> = {
  meuteRoot: { label: "MEUTE_ROOT", hint: "Absolute path of the Meute checkout on this host" },
  meutePath: { label: "meute binary", hint: "Must be exactly <MEUTE_ROOT>/bin/meute" },
  readinessRecordPath: { label: "Readiness record (JSON)", hint: "Optional. Absolute path" },
  readinessPolicyPath: { label: "Owner policy (JSON)", hint: "Optional. Absolute path" },
  runnerPath: { label: "PATH for meute (optional)", hint: "Colon-separated absolute directories; default /usr/local/bin:/usr/bin:/bin" },
  xdgRuntimeDir: { label: "XDG_RUNTIME_DIR (optional)", hint: "Needed for the health check: the daemon user's own runtime dir with a live user bus (for example /run/user/1000)" },
};

export const FIELD_ORDER: readonly SettingsField[] = [
  "meuteRoot", "meutePath", "readinessRecordPath", "readinessPolicyPath", "runnerPath", "xdgRuntimeDir",
];

/** Field-level errors for a draft. Empty means every non-empty value is well formed. */
export function validateDraft(draft: FleetSettingsValues): Partial<Record<SettingsField, string>> {
  const errors: Partial<Record<SettingsField, string>> = {};
  for (const field of FIELD_ORDER) {
    const value = draft[field].trim();
    if (value === "") continue;
    const valid = field === "runnerPath" ? isSafePathList(value) : isSafeAbsolutePath(value);
    if (!valid) errors[field] = field === "runnerPath" ? "Use absolute directories separated by colons" : "Use a clean absolute path";
  }
  if (draft.meutePath.trim() !== "" && draft.meuteRoot.trim() !== "" && !errors.meutePath && !errors.meuteRoot
    && draft.meutePath.trim() !== `${draft.meuteRoot.trim()}/bin/meute`) {
    errors.meutePath = "Must be exactly <MEUTE_ROOT>/bin/meute";
  }
  return errors;
}

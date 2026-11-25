import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { isSafeAbsolutePath, isSafePathList } from "./validate";

const optionalPath = (message: string) =>
  z
    .string()
    .trim()
    .default("")
    .refine((value) => value === "" || isSafeAbsolutePath(value), message);

/**
 * Nothing here searches the filesystem: every value is empty until an operator types it.
 * Empty means "not configured" and the RPCs answer with a structured not_configured error.
 */
export const fleetSettings = defineSettings({
  id: "meute-fleet",
  scope: "host",
  version: 1,
  schema: z.object({
    meutePath: optionalPath("Enter the absolute path of bin/meute"),
    meuteRoot: optionalPath("Enter the absolute path of the Meute checkout"),
    readinessRecordPath: optionalPath("Enter the absolute path of the readiness record JSON"),
    readinessPolicyPath: optionalPath("Enter the absolute path of the owner policy JSON"),
    runnerPath: z
      .string()
      .trim()
      .default("")
      .refine((value) => value === "" || isSafePathList(value), "Enter absolute directories"),
    xdgRuntimeDir: optionalPath("Enter an absolute directory"),
  }),
});

export type FleetSettingsValues = z.output<typeof fleetSettings.schema>;

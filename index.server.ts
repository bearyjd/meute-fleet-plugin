import type { PluginServerContext } from "@getpaseo/plugin/server";
import { resolveConfig, type FleetConfig } from "./server/config";
import { getFinding, health, listFindings, readiness, runStatus } from "./server/fleet";
import {
  type Envelope, getFindingRpc, healthRpc, listFindingsRpc, readinessRpc, runStatusRpc,
} from "./shared/contracts";
import { fleetSettings } from "./shared/settings";

const failed = (code: "invalid_config" | "internal", message: string): Envelope<never> => ({
  ok: false,
  observedAt: new Date().toISOString(),
  error: { code, message },
});

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(fleetSettings);

  // Reads the current settings on every call, so a saved change applies without a reload.
  // Nothing thrown here may reach the plugin process: every failure becomes an envelope.
  const guarded =
    <Input, Output>(run: (config: FleetConfig, input: Input) => Promise<Envelope<Output>>) =>
    async (input: Input): Promise<Envelope<Output>> => {
      try {
        const state = await settings.read();
        if (state.status !== "ready") return failed("invalid_config", "The plugin settings are not valid");
        const config = await resolveConfig(state.values);
        if (!config.ok) return { ok: false, observedAt: new Date().toISOString(), error: config.error };
        return await run(config.data, input);
      } catch (error) {
        console.error("meute-fleet handler failed:", error instanceof Error ? error.name : "unknown");
        return failed("internal", "Unexpected error");
      }
    };

  // Exactly these five reads. There is deliberately no handler that writes or starts anything.
  server.handle(listFindingsRpc, guarded((config) => listFindings(config)));
  server.handle(getFindingRpc, guarded(getFinding));
  server.handle(readinessRpc, guarded((config) => readiness(config)));
  server.handle(healthRpc, guarded((config) => health(config)));
  server.handle(runStatusRpc, guarded(runStatus));
  return () => {};
}

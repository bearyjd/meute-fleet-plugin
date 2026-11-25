import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import { healthRpc, runStatusRpc } from "../shared/contracts";
import { ActionButton, Card, FreshnessBanner, toneColor } from "./common";
import { usePolled } from "./use-polled";
import { freshness, healthView, runView, type Tone } from "./viewmodel";

const HEALTH_POLL_MS = 60_000; // meute health calls systemctl
const RUN_POLL_MS = 10_000; // file reads only

interface Props {
  theme: PluginTheme;
  compact: boolean;
}

function HealthCard({ theme }: { theme: PluginTheme }) {
  const call = useRpc(healthRpc);
  const { state, loading, now, refresh } = usePolled(call, {}, HEALTH_POLL_MS);
  const view = state.data ? healthView(state.data) : null;
  const stale = freshness(state, now, HEALTH_POLL_MS).stale;
  return (
    <Card theme={theme} title="Fleet health">
      <FreshnessBanner theme={theme} state={state} now={now} baseMs={HEALTH_POLL_MS} />
      {view ? (
        <>
          <Text style={{ color: toneColor(theme, stale ? "muted" : view.tone), fontSize: 20, fontWeight: "600" }}>{view.headline}</Text>
          {view.lines.map((line, index) => (
            <Text key={index} style={{ color: theme.colors.foreground, fontSize: 13 }}>{line}</Text>
          ))}
        </>
      ) : (
        <Text style={{ color: theme.colors.foregroundMuted }}>{loading ? "Loading…" : "Health unknown: treat as unhealthy"}</Text>
      )}
      <ActionButton theme={theme} label="Refresh health" onPress={refresh} />
    </Card>
  );
}

function RunCard({ theme }: { theme: PluginTheme }) {
  const call = useRpc(runStatusRpc);
  const { state, loading, now, refresh } = usePolled(call, { lines: 20 }, RUN_POLL_MS);
  const view = state.data ? runView(state.data) : null;
  const stale = freshness(state, now, RUN_POLL_MS).stale;
  const dim = stale ? 0.5 : 1;
  const tone = (value: Tone): Tone => (stale ? "muted" : value);
  return (
    <Card theme={theme} title="Run status (from lock-info, log and plan queue)">
      <FreshnessBanner theme={theme} state={state} now={now} baseMs={RUN_POLL_MS} />
      {view ? (
        <View style={{ gap: 8, opacity: dim }}>
          <Text style={{ color: toneColor(theme, tone(view.lock.tone)) }}>{view.lock.text}</Text>
          <Text style={{ color: toneColor(theme, tone(view.queue.tone)) }}>{view.queue.text}</Text>
          {view.logNote ? <Text style={{ color: theme.colors.statusDanger }}>{view.logNote}</Text> : null}
          {view.logLines.length === 0 && !view.logNote ? <Text style={{ color: theme.colors.foregroundMuted }}>No runs logged</Text> : null}
          {view.logLines.map((line, index) => (
            <Text key={index} style={{ color: toneColor(theme, tone(line.tone)), fontFamily: "monospace", fontSize: 12 }}>{line.text}</Text>
          ))}
        </View>
      ) : (
        <Text style={{ color: theme.colors.foregroundMuted }}>{loading ? "Loading…" : "No data"}</Text>
      )}
      <ActionButton theme={theme} label="Refresh run status" onPress={refresh} />
    </Card>
  );
}

export function HealthAndRun({ theme, compact }: Props) {
  return (
    <ScrollView contentContainerStyle={{ padding: compact ? 12 : 20, gap: 12 }}>
      <HealthCard theme={theme} />
      <RunCard theme={theme} />
    </ScrollView>
  );
}

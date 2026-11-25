import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import { readinessRpc } from "../shared/contracts";
import { ActionButton, Badge, Card, FreshnessBanner, toneColor } from "./common";
import { usePolled } from "./use-polled";
import { formatClock, readinessDisplay } from "./viewmodel";

const READINESS_POLL_MS = 60_000;

interface Props {
  theme: PluginTheme;
  compact: boolean;
}

export function Readiness({ theme, compact }: Props) {
  const call = useRpc(readinessRpc);
  const { state, loading, now, refresh } = usePolled(call, {}, READINESS_POLL_MS);
  // Fail closed: an error is "unknown, not ready" and a READY that is not current loses its colour.
  const { current, lastKnown, fresh } = readinessDisplay(state, now, READINESS_POLL_MS);

  return (
    <ScrollView contentContainerStyle={{ padding: compact ? 12 : 20, gap: 12 }}>
      <FreshnessBanner theme={theme} state={state} now={now} baseMs={READINESS_POLL_MS} />
      {current ? (
        <Card theme={theme} title="Readiness">
          <Text accessibilityRole="header" style={{ color: toneColor(theme, current.tone), fontSize: 20, fontWeight: "600" }}>
            {current.headline}
          </Text>
          <Text style={{ color: theme.colors.foregroundMuted }}>{current.summary}</Text>
          {state.data?.meuteObservedAt && !fresh.stale ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{`Checked ${formatClock(state.data.meuteObservedAt)}`}</Text>
          ) : null}
        </Card>
      ) : (
        <Text style={{ color: theme.colors.foregroundMuted }}>{loading ? "Loading…" : "No data"}</Text>
      )}
      {(lastKnown ?? (state.error ? null : current))?.rows.map((row, index) => (
        <Card key={`${row.label}-${index}`} theme={theme}>
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap", alignItems: "center", opacity: lastKnown || fresh.stale ? 0.5 : 1 }}>
            <Badge theme={theme} tone={lastKnown || fresh.stale ? "muted" : row.tone} label={row.status} />
            <Text style={{ color: theme.colors.foreground, flexShrink: 1 }}>{row.label}</Text>
          </View>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{row.reason}</Text>
          {row.detail ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{row.detail}</Text> : null}
        </Card>
      ))}
      <ActionButton theme={theme} label="Refresh" onPress={refresh} />
    </ScrollView>
  );
}

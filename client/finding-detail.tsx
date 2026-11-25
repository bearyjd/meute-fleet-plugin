import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import { getFindingRpc } from "../shared/contracts";
import { sanitizeText } from "../shared/validate";
import { ActionButton, Badge, Card, FreshnessBanner } from "./common";
import { usePolled } from "./use-polled";
import { severityTone } from "./viewmodel";

interface Props {
  theme: PluginTheme;
  compact: boolean;
  id: string | null;
  onBack(): void;
}

function Detail({ theme, compact, id, onBack }: Omit<Props, "id"> & { id: string }) {
  const call = useRpc(getFindingRpc);
  const { state, loading, now, refresh } = usePolled(call, { id }, null);
  const detail = state.data;
  return (
    <ScrollView contentContainerStyle={{ padding: compact ? 12 : 20, gap: 12 }}>
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        <ActionButton theme={theme} label="Back to inbox" onPress={onBack} />
        <ActionButton theme={theme} label="Reload" onPress={refresh} />
      </View>
      <FreshnessBanner theme={theme} state={state} now={now} baseMs={null} />
      <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{id}</Text>
      {detail ? (
        <Card theme={theme}>
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <Badge theme={theme} tone={severityTone(detail.severity)} label={detail.severity} />
            <Text selectable style={{ color: theme.colors.foreground, fontSize: 16, flexShrink: 1 }}>{detail.title}</Text>
          </View>
          {/* Report text is untrusted. It is shown only as plain, escaped Text: never as Markdown or HTML. */}
          <Text selectable style={{ color: theme.colors.foreground, fontFamily: "monospace", fontSize: 13 }}>
            {sanitizeText(detail.excerpt, 20_000)}
          </Text>
          {detail.truncated ? (
            <Text style={{ color: theme.colors.statusWarning }}>Excerpt truncated. Read the full report on the Meute host.</Text>
          ) : null}
        </Card>
      ) : loading ? (
        <Text style={{ color: theme.colors.foregroundMuted }}>Loading…</Text>
      ) : null}
    </ScrollView>
  );
}

export function FindingDetail({ theme, compact, id, onBack }: Props) {
  if (id === null) {
    return (
      <View style={{ padding: 20 }}>
        <Text style={{ color: theme.colors.foregroundMuted }}>Select a finding in the Inbox to read its report excerpt.</Text>
      </View>
    );
  }
  // Keyed by id so a different finding never shows the previous one's text.
  return <Detail key={id} theme={theme} compact={compact} id={id} onBack={onBack} />;
}

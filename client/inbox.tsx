import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { FlatList } from "@getpaseo/plugin/client/ui";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { listFindingsRpc, type Finding } from "../shared/contracts";
import { ActionButton, Badge, Chip, FreshnessBanner } from "./common";
import { usePolled } from "./use-polled";
import {
  filterFindings, findingStateGroup, freshness, repoOptions, SEVERITY_FILTERS, severityTone, sortFindings,
  type Filters,
} from "./viewmodel";

const INBOX_POLL_MS = 30_000; // findings --json parses every report, so poll gently
const STATES: ReadonlyArray<{ value: Filters["state"]; label: string }> = [
  { value: "all", label: "All" },
  { value: "new", label: "New" },
  { value: "open", label: "Open" },
  { value: "dismissed", label: "Dismissed" },
];

interface Props {
  theme: PluginTheme;
  compact: boolean;
  onSelect(id: string): void;
}

function Row({ theme, finding, stale, onSelect }: { theme: PluginTheme; finding: Finding; stale: boolean; onSelect(id: string): void }) {
  const group = findingStateGroup(finding.state);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${finding.severity} ${finding.id}: ${finding.title}, ${finding.state}${stale ? ", not current" : ""}`}
      onPress={() => onSelect(finding.id)}
      style={{ paddingVertical: 12, paddingHorizontal: 4, gap: 4, borderBottomWidth: 1, borderBottomColor: theme.colors.border, opacity: stale ? 0.5 : 1 }}
    >
      <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{finding.id}</Text>
      <Text numberOfLines={2} style={{ color: theme.colors.foreground, fontSize: 15 }}>{finding.title}</Text>
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        <Badge theme={theme} tone={severityTone(finding.severity)} label={finding.severity} />
        <Badge theme={theme} tone={group === "dismissed" || group === "closed" ? "muted" : "warning"} label={finding.state} />
      </View>
    </Pressable>
  );
}

export function Inbox({ theme, compact, onSelect }: Props) {
  const call = useRpc(listFindingsRpc);
  const { state, loading, now, refresh } = usePolled(call, {}, INBOX_POLL_MS);
  const stale = freshness(state, now, INBOX_POLL_MS).stale;
  const [filters, setFilters] = useState<Filters>({ state: "all", repo: "", severity: "" });
  const all = state.data?.findings;
  const visible = useMemo(() => (all ? sortFindings(filterFindings(all, filters)) : []), [all, filters]);
  const repos = useMemo(() => (all ? repoOptions(all) : []), [all]);

  const header = (
    <View style={{ gap: 10, paddingBottom: 8 }}>
      {state.data && state.data.skipped > 0 ? (
        <Text style={{ color: theme.colors.statusWarning }}>
          {`${state.data.skipped} report(s) could not be read: this list may be incomplete.`}
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {STATES.map((option) => (
          <Chip key={option.value} theme={theme} label={option.label} selected={filters.state === option.value}
            onPress={() => setFilters({ ...filters, state: option.value })} />
        ))}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Chip theme={theme} label="Any severity" selected={filters.severity === ""} onPress={() => setFilters({ ...filters, severity: "" })} />
        {SEVERITY_FILTERS.map((severity) => (
          <Chip key={severity} theme={theme} label={severity} selected={filters.severity === severity}
            onPress={() => setFilters({ ...filters, severity })} />
        ))}
      </View>
      {repos.length > 0 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Chip theme={theme} label="Any repo" selected={filters.repo === ""} onPress={() => setFilters({ ...filters, repo: "" })} />
          {repos.map((repo) => (
            <Chip key={repo} theme={theme} label={repo} selected={filters.repo === repo} onPress={() => setFilters({ ...filters, repo })} />
          ))}
        </View>
      ) : null}
      <View style={{ flexDirection: compact ? "column" : "row", gap: 8, alignItems: compact ? "flex-start" : "center" }}>
        <Text style={{ color: theme.colors.foregroundMuted }}>
          {all ? `${visible.length} of ${all.length} findings` : loading ? "Loading…" : "No data"}
        </Text>
        <ActionButton theme={theme} label="Refresh" onPress={refresh} />
      </View>
    </View>
  );

  // The banner sits above the list, not in its header, so it does not scroll away.
  return (
    <View style={{ flex: 1 }}>
      <View style={{ paddingHorizontal: compact ? 12 : 20 }}>
        <FreshnessBanner theme={theme} state={state} now={now} baseMs={INBOX_POLL_MS} />
      </View>
      <FlatList
        data={visible}
        keyExtractor={(finding: Finding) => finding.id}
        renderItem={({ item }: { item: Finding }) => <Row theme={theme} finding={item} stale={stale} onSelect={onSelect} />}
        ListHeaderComponent={header}
        ListEmptyComponent={
          <Text style={{ color: theme.colors.foregroundMuted, paddingVertical: 16 }}>
            {all ? "No findings match these filters." : state.error ? "The inbox is unavailable." : ""}
          </Text>
        }
        contentContainerStyle={{ padding: compact ? 12 : 20 }}
      />
    </View>
  );
}

import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useState } from "react";
import { Text, View } from "react-native";
import { Chip } from "./common";
import { FindingDetail } from "./finding-detail";
import { Inbox } from "./inbox";
import { Readiness } from "./readiness";
import { HealthAndRun } from "./run";

type Section = "inbox" | "finding" | "readiness" | "run";
const SECTIONS: ReadonlyArray<{ id: Section; label: string }> = [
  { id: "inbox", label: "Inbox" },
  { id: "finding", label: "Finding" },
  { id: "readiness", label: "Readiness" },
  { id: "run", label: "Health & run" },
];

export function FleetScreen({ theme, layout }: PluginScreenProps) {
  const [section, setSection] = useState<Section>("inbox");
  const [selected, setSelected] = useState<string | null>(null);
  const compact = layout.compact;

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <View style={{ paddingHorizontal: compact ? 12 : 20, paddingTop: compact ? 12 : 20, gap: 8 }}>
        <Text accessibilityRole="header" style={{ color: theme.colors.foreground, fontSize: compact ? 18 : 22 }}>
          Meute fleet (read-only)
        </Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {SECTIONS.map((entry) => (
            <Chip key={entry.id} theme={theme} label={entry.label} selected={section === entry.id} onPress={() => setSection(entry.id)} />
          ))}
        </View>
      </View>
      <View style={{ flex: 1 }}>
        {section === "inbox" ? (
          <Inbox theme={theme} compact={compact} onSelect={(id) => { setSelected(id); setSection("finding"); }} />
        ) : null}
        {section === "finding" ? (
          <FindingDetail theme={theme} compact={compact} id={selected} onBack={() => setSection("inbox")} />
        ) : null}
        {section === "readiness" ? <Readiness theme={theme} compact={compact} /> : null}
        {section === "run" ? <HealthAndRun theme={theme} compact={compact} /> : null}
      </View>
    </View>
  );
}

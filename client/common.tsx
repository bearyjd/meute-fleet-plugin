import type { PluginTheme } from "@getpaseo/plugin";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { freshness, type PollState, type Tone } from "./viewmodel";

export function toneColor(theme: PluginTheme, tone: Tone): string {
  switch (tone) {
    case "success":
      return theme.colors.statusSuccess;
    case "warning":
      return theme.colors.statusWarning;
    case "danger":
      return theme.colors.statusDanger;
    default:
      return theme.colors.foregroundMuted;
  }
}

interface Props {
  theme: PluginTheme;
}

/** Plain text only: React Native <Text> never interprets markup, so report text stays inert. */
export function Badge({ theme, tone, label }: Props & { tone: Tone; label: string }) {
  const color = toneColor(theme, tone);
  return (
    <View style={{ borderWidth: 1, borderColor: color, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1 }}>
      <Text style={{ color, fontSize: 12 }}>{label}</Text>
    </View>
  );
}

export function Card({ theme, title, children }: Props & { title?: string; children: ReactNode }) {
  return (
    <View
      style={{
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 10,
        padding: 12,
        gap: 8,
      }}
    >
      {title ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>{title}</Text> : null}
      {children}
    </View>
  );
}

export function Chip({
  theme, label, selected, onPress,
}: Props & { label: string; selected: boolean; onPress(): void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      onPress={onPress}
      style={{
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: selected ? theme.colors.accent : theme.colors.border,
        backgroundColor: selected ? theme.colors.accent : theme.colors.surface1,
      }}
    >
      <Text style={{ color: selected ? theme.colors.accentForeground : theme.colors.foreground, fontSize: 13 }}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * Always says how old the data is ("as of HH:MM"), and turns into a warning when it is stale
 * (failed call, older than 2x the poll period, or resumed from background before the new answer),
 * so old data is never presented as current.
 */
export function FreshnessBanner({ theme, state, now, baseMs }: Props & { state: PollState<unknown>; now: number; baseMs: number | null }) {
  const view = freshness(state, now, baseMs);
  if (view.label === null) {
    return view.asOf ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{view.asOf}</Text> : null;
  }
  return (
    <View accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ borderColor: theme.colors.statusWarning, borderWidth: 1, borderRadius: 8, padding: 8, gap: 2 }}>
      <Text style={{ color: theme.colors.statusWarning }}>{view.label}</Text>
      {state.error ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{state.error.message}</Text> : null}
    </View>
  );
}

export function ActionButton({ theme, label, onPress }: Props & { label: string; onPress(): void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={{ alignSelf: "flex-start", paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border }}
    >
      <Text style={{ color: theme.colors.foreground }}>{label}</Text>
    </Pressable>
  );
}

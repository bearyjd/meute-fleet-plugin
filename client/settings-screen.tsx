import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useCallback, useMemo, useRef, useState } from "react";
import { Text } from "react-native";
import { fleetSettings, type FleetSettingsValues } from "../shared/settings";
import { FIELD_LABELS, FIELD_ORDER, validateDraft } from "./settings-form";

const trimmed = (values: FleetSettingsValues): FleetSettingsValues =>
  Object.fromEntries(FIELD_ORDER.map((field) => [field, values[field].trim()])) as FleetSettingsValues;
const sameValues = (a: FleetSettingsValues, b: FleetSettingsValues): boolean =>
  FIELD_ORDER.every((field) => a[field] === b[field]);

function Form({ values, revision, save, saving, saveError, onReload, warningColor }: {
  values: FleetSettingsValues; revision: string; saving: boolean; saveError: string | null; warningColor: string;
  save(values: FleetSettingsValues, revision: string): Promise<boolean>;
  onReload(): void;
}) {
  // Optimistic concurrency: the draft is saved against the revision it was based on, so the host
  // rejects it if another client saved meanwhile, instead of silently reverting that change.
  const [baseRevision, setBaseRevision] = useState(revision);
  const [draft, setDraft] = useState(values);
  const [, rerender] = useState(0);
  // What our last successful save stored. The first document that differs from the base, or
  // that holds exactly these values, settles it once: ours only if it holds these values. A
  // no-op save (same content, same revision) settles at once, so it cannot adopt a later save
  // of another client.
  const saved = useRef<FleetSettingsValues | null>(null);
  let base = baseRevision;
  if (saved.current !== null && (revision !== baseRevision || sameValues(values, saved.current))) {
    if (sameValues(values, saved.current)) {
      base = revision;
      if (revision !== baseRevision) setBaseRevision(revision);
    }
    saved.current = null;
  }
  const errors = useMemo(() => validateDraft(draft), [draft]);
  const invalid = Object.keys(errors).length > 0;
  const conflict = revision !== base;
  const onSave = useCallback(async () => {
    const sending = trimmed(draft);
    if (!(await save(sending, baseRevision))) return;
    saved.current = sending;
    rerender((tick) => tick + 1);
  }, [save, draft, baseRevision]);
  return (
    <SettingsSection title="Meute Fleet">
      <SettingsCard>
        {conflict ? (
          <>
            <Text style={{ color: warningColor }}>
              Settings changed on another client. Saving now would be rejected; reload to see them (your unsaved edits are discarded).
            </Text>
            <SettingsAction label="Settings changed elsewhere" actionLabel="Reload" onPress={onReload} />
          </>
        ) : null}
        {FIELD_ORDER.map((field) => (
          <SettingsInput
            key={field}
            label={FIELD_LABELS[field].label}
            hint={FIELD_LABELS[field].hint}
            initialValue={values[field]}
            error={errors[field] ?? null}
            disabled={saving}
            onChangeText={(text) => setDraft((current) => ({ ...current, [field]: text }))}
          />
        ))}
        <SettingsAction label="Settings" actionLabel="Save" disabled={saving || invalid} onPress={() => void onSave()} error={saveError} />
      </SettingsCard>
    </SettingsSection>
  );
}

export function FleetSettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(fleetSettings);
  // Bumping the key remounts the form: a fresh draft and base revision from the current document.
  const [formKey, setFormKey] = useState(0);
  const muted = useMemo(() => ({ color: theme.colors.foregroundMuted }), [theme]);
  const { reload } = settings;
  const onReload = useCallback(() => {
    setFormKey((key) => key + 1);
    void reload();
  }, [reload]);
  if (settings.status === "loading") return <Text style={muted}>Loading settings…</Text>;
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="Meute Fleet">
        <Text style={muted}>{settings.error}</Text>
        <SettingsAction label="Try again" actionLabel="Reload" onPress={settings.reload} />
        {settings.status === "invalid" ? (
          <SettingsAction label="Discard the stored settings and start empty" actionLabel="Reset" onPress={() => void settings.reset()} />
        ) : null}
      </SettingsSection>
    );
  }
  return (
    <Form
      key={formKey}
      values={settings.values}
      revision={settings.revision}
      saving={settings.saving}
      saveError={settings.saveError}
      save={settings.save}
      onReload={onReload}
      warningColor={theme.colors.statusWarning}
    />
  );
}

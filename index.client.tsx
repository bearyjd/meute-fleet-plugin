import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { FleetScreen } from "./client/fleet-screen";
import { FleetSettings } from "./client/settings-screen";

function FleetItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Activity"
      active={currentScreen?.screenId === "fleet"}
      onPress={() => openScreen({ screenId: "fleet" })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "fleet", title: "Meute Fleet", Component: FleetScreen });
  client.addSidebarHeaderItem({ id: "fleet", title: "Meute Fleet", Component: FleetItem });
  client.addSettingsScreen({ id: "meute-fleet", title: "Meute Fleet", icon: "Settings", Component: FleetSettings });
  return () => {};
}

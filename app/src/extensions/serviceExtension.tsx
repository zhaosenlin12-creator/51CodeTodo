import type { ServiceExtension, ServiceExtensionContext } from "./types";

export function useServiceExtension(context: ServiceExtensionContext): ServiceExtension {
  return {
    mode: "byok",
    entry: context.snapshot?.available
      ? { label: "粘贴并整理", tone: "primary" }
      : { label: "配置智能整理", tone: "secondary" },
    openEntry: () => context.openSettings("smartArrange"),
    busy: false,
    arrangeBusy: false,
    editorBusy: false,
  };
}

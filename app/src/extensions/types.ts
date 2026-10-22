import type { ReactNode } from "react";
import type { StatusMessage } from "../components/StatusBar";
import type { SmartArrangeSnapshot } from "../contracts/smartArrange";
export type SmartArrangeEntryTone = "primary" | "medium" | "secondary";

export interface ServiceExtensionContext {
  snapshot: SmartArrangeSnapshot | null;
  busy: boolean;
  editorOpen: boolean;
  settingsOpen: boolean;
  onSnapshot(snapshot: SmartArrangeSnapshot): void;
  refresh(): void;
  onMessage(message: StatusMessage | null): void;
  openSettings(target?: string): void;
}

export interface ServiceExtension {
  mode: "byok" | "official";
  entry: { label: string; tone: SmartArrangeEntryTone };
  openEntry(): void;
  settingsContent?: ReactNode;
  editorContent?: ReactNode;
  settingsHint?: string;
  busy: boolean;
  arrangeBusy: boolean;
  editorBusy: boolean;
}

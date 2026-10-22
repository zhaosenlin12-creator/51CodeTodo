export interface SmartArrangePreferences {
  enabled: boolean;
  source: "official" | "byok";
}

export interface SmartArrangeSnapshot {
  preferences: SmartArrangePreferences;
  available: boolean;
  message: string;
}

export function clipboardIntent({ editable, available, busy }: { editable: boolean; available: boolean; busy: boolean }) {
  if (editable) return "native";
  if (busy) return "ignore";
  return available ? "arrange" : "attachment";
}

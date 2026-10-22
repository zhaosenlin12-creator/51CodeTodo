/** 底栏右侧动态提示：按页面与智能整理状态给出单行文案。 */
export interface StatusBarHintInput {
  dialogOpen: boolean;
  showingLogin: boolean;
  recognizing: boolean;
  smartArrangeAvailable: boolean;
}

export function statusBarHint({ dialogOpen, showingLogin, recognizing, smartArrangeAvailable }: StatusBarHintInput): string {
  if (dialogOpen) {
    if (showingLogin) return "请用微信扫码确认";
    if (recognizing) return "正在整理…";
    return smartArrangeAvailable ? "Ctrl+V 一键整理" : "试试智能整理";
  }
  if (recognizing) return "正在整理…";
  return smartArrangeAvailable ? "Ctrl+N 新增 · Ctrl+V 一键整理" : "Ctrl+N 新增 · 试试智能整理";
}

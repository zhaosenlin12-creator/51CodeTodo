use pometodo_core::settings::AppSettings;
use tauri::Manager;

/**
 * 把持久化的窗口层级设置应用到主窗口：
 * - window_level normal / topmost → 是否始终置顶；
 * - panel_opacity（50–100）走前端 CSS 面板透明度，不在外壳整体改不透明度；
 * - pinned_to_desktop（贴桌面壁纸层）在 WebView2 下无法稳定实现，暂不处理。
 */
pub(crate) fn apply(app: &tauri::AppHandle, settings: &AppSettings) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.set_always_on_top(settings.window_level == "topmost");
}

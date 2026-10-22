//! One app-styled popup for tray and floating-ball menus; no task data is exposed.
use crate::{commands::StorageState, floating};
use serde::Serialize;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

const WIDTH: f64 = 196.0; // 148 DIP menu + 24 DIP transparent shadow margins.

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuSnapshot {
    id: u64,
    floating: bool,
    main_visible: bool,
    floating_enabled: bool,
    theme: String,
}

#[derive(Default)]
pub struct ContextMenuState {
    sequence: AtomicU64,
    pending: Mutex<Option<MenuSnapshot>>,
}

fn popup_origin(
    anchor: (i32, i32),
    size: (u32, u32),
    area: (i32, i32, u32, u32),
    margin: i32,
    tray: bool,
) -> (i32, i32) {
    let x = anchor.0 as i64 - margin as i64;
    // Windows tray menus grow upwards if there is not enough room below.
    let mut y = anchor.1 as i64 - margin as i64;
    if tray {
        y = area.1 as i64 + area.3 as i64 - size.1 as i64 + margin as i64;
    } else if y + size.1 as i64 > area.1 as i64 + area.3 as i64 {
        y = anchor.1 as i64 - size.1 as i64 + margin as i64;
    }
    // Clamp the visible menu, not the transparent shadow margin.
    (
        x.clamp(
            area.0 as i64 - margin as i64,
            area.0 as i64 + area.2.saturating_sub(size.0) as i64 + margin as i64,
        ) as i32,
        y.clamp(
            area.1 as i64 - margin as i64,
            area.1 as i64 + area.3.saturating_sub(size.1) as i64 + margin as i64,
        ) as i32,
    )
}

pub fn create(app: &tauri::AppHandle) -> tauri::Result<()> {
    let window = WebviewWindowBuilder::new(
        app,
        "context-menu",
        WebviewUrl::App("index.html?window=context-menu".into()),
    )
    .title("PomeTodo 菜单")
    .inner_size(WIDTH, 212.0)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .visible(false)
    .focused(false)
    .shadow(false)
    .build()?;
    let app = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Focused(false)) {
            let _ = dismiss(&app);
        }
    });
    Ok(())
}

pub fn open(
    app: &tauri::AppHandle,
    floating: bool,
    anchor: PhysicalPosition<f64>,
) -> Result<(), String> {
    let window = app
        .get_webview_window("context-menu")
        .ok_or("菜单窗口不可用")?;
    window.hide().map_err(|_| "菜单未能收起")?;
    let state = app.state::<ContextMenuState>();
    let theme = {
        let storage = app.state::<StorageState>();
        let guard = storage.inner.lock().map_err(|_| "菜单无法读取设置")?;
        guard.as_ref().map_err(Clone::clone)?.repo.settings()?.theme
    };
    let snapshot = MenuSnapshot {
        id: state.sequence.fetch_add(1, Ordering::SeqCst) + 1,
        floating,
        main_visible: app
            .get_webview_window("main")
            .is_some_and(|w| w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false)),
        floating_enabled: floating::is_enabled(app)?,
        theme,
    };
    let monitor = window
        .monitor_from_point(anchor.x, anchor.y)
        .map_err(|_| "无法读取菜单屏幕")?
        .or(window.primary_monitor().map_err(|_| "无法读取菜单屏幕")?)
        .ok_or("无法读取菜单屏幕")?;
    let area = monitor.work_area();
    let scale = monitor.scale_factor();
    let size = (
        (WIDTH * scale).round() as u32,
        ((if floating { 135.0 } else { 212.0 }) * scale).round() as u32,
    );
    let (x, y) = popup_origin(
        (anchor.x.round() as i32, anchor.y.round() as i32),
        size,
        (
            area.position.x,
            area.position.y,
            area.size.width,
            area.size.height,
        ),
        (24.0 * scale).round() as i32,
        !floating,
    );
    window
        .set_size(PhysicalSize::new(size.0, size.1))
        .map_err(|_| "菜单大小未能更新")?;
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|_| "菜单未能定位")?;
    *state.pending.lock().map_err(|_| "菜单状态不可用")? = Some(snapshot.clone());
    app.emit_to("context-menu", "pometodo-menu-open", snapshot)
        .map_err(|_| "菜单未能打开".into())
}

fn dismiss(app: &tauri::AppHandle) -> Result<(), String> {
    *app.state::<ContextMenuState>()
        .pending
        .lock()
        .map_err(|_| "菜单状态不可用")? = None;
    if let Some(window) = app.get_webview_window("context-menu") {
        window.hide().map_err(|_| "菜单未能收起")?;
    }
    Ok(())
}

#[tauri::command]
pub fn pometodo_menu_snapshot(app: tauri::AppHandle) -> Result<Option<MenuSnapshot>, String> {
    Ok(app
        .state::<ContextMenuState>()
        .pending
        .lock()
        .map_err(|_| "菜单状态不可用")?
        .clone())
}

#[tauri::command]
pub fn pometodo_menu_present(app: tauri::AppHandle, id: u64) -> Result<(), String> {
    if !app
        .state::<ContextMenuState>()
        .pending
        .lock()
        .map_err(|_| "菜单状态不可用")?
        .as_ref()
        .is_some_and(|s| s.id == id)
    {
        return Ok(());
    }
    let window = app
        .get_webview_window("context-menu")
        .ok_or("菜单窗口不可用")?;
    window.show().map_err(|_| "菜单未能显示")?;
    window.set_focus().map_err(|_| "菜单未能获取焦点")?;
    Ok(())
}

#[tauri::command]
pub fn pometodo_menu_action(app: tauri::AppHandle, id: u64, action: String) -> Result<(), String> {
    let snapshot = app
        .state::<ContextMenuState>()
        .pending
        .lock()
        .map_err(|_| "菜单状态不可用")?
        .clone();
    let Some(snapshot) = snapshot.filter(|s| s.id == id) else {
        return Ok(());
    };
    if snapshot.floating && !matches!(action.as_str(), "dismiss" | "floating" | "settings") {
        return Err("菜单操作不可用".into());
    }
    dismiss(&app)?;
    let result = (|| match action.as_str() {
        "dismiss" => Ok(()),
        "main" => {
            if snapshot.main_visible {
                app.get_webview_window("main")
                    .ok_or("待办窗口不可用")?
                    .hide()
                    .map_err(|_| "窗口未能收起".into())
            } else {
                crate::show_window(&app);
                Ok(())
            }
        }
        "floating" => floating::set_enabled(
            &app,
            if snapshot.floating {
                false
            } else {
                !floating::is_enabled(&app)?
            },
        ),
        "settings" => floating::pometodo_open_main(app.clone(), None, Some(true)),
        "quit" => {
            app.exit(0);
            Ok(())
        }
        _ => Err("菜单操作不可用".into()),
    })();
    if let Err(error) = &result {
        let _ = app.emit_to("main", "pometodo-system-error", error);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::popup_origin;
    #[test]
    fn opens_above_taskbar_and_clamps_right_edge() {
        let (x, y) = popup_origin((1900, 1060), (196, 212), (0, 0, 1920, 1040), 24, true);
        assert_eq!((x, y), (1748, 852));
        assert_eq!(y + 212 - 24, 1040); // Menu surface touches taskbar top.
    }
    #[test]
    fn preserves_negative_monitor_coordinates_and_shadow_margin() {
        assert_eq!(
            popup_origin((-1500, 60), (318, 318), (-1920, 0, 1920, 1080), 36, false),
            (-1536, 24)
        );
    }
}

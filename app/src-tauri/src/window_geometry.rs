//! 主窗口大小与位置记忆：拖动/缩放后防抖保存，启动时恢复并校准到可见工作区。
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use tauri::Manager;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct WindowGeometry {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Default)]
pub struct WindowGeometryState {
    last: Mutex<Option<WindowGeometry>>,
    pending: AtomicBool,
    path: Mutex<Option<PathBuf>>,
}

fn geometry_file(state: &WindowGeometryState) -> Option<PathBuf> {
    state.path.lock().ok().and_then(|p| p.clone())
}

fn persist(state: &WindowGeometryState) {
    let Some(path) = geometry_file(state) else {
        return;
    };
    let Ok(geometry) = state.last.lock() else {
        return;
    };
    let Some(geometry) = *geometry else { return };
    if let Ok(bytes) = serde_json::to_vec(&geometry) {
        let _ = std::fs::write(path, bytes);
    }
}

pub fn configure(state: &WindowGeometryState, data_dir: &Path) {
    if let Ok(mut path) = state.path.lock() {
        *path = Some(data_dir.join("window-geometry.json"));
    }
}

/// 记录当前几何并安排一次防抖写盘；由窗口事件调用。
pub fn remember(window: &tauri::Window, state: &Arc<WindowGeometryState>) {
    let Ok(position) = window.outer_position() else {
        return;
    };
    let Ok(size) = window.inner_size() else {
        return;
    };
    if size.width == 0 || size.height == 0 {
        return;
    }
    let geometry = WindowGeometry {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    };
    if let Ok(mut last) = state.last.lock() {
        if *last == Some(geometry) {
            return;
        }
        *last = Some(geometry);
    }
    if state.pending.swap(true, Ordering::SeqCst) {
        return;
    }
    let state = Arc::clone(state);
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(400));
        persist(&state);
        state.pending.store(false, Ordering::SeqCst);
    });
}

/// 退出/隐藏前立即把最近一次几何写盘。
pub fn flush(window: &tauri::Window, state: &WindowGeometryState) {
    let Ok(position) = window.outer_position() else {
        return;
    };
    let Ok(size) = window.inner_size() else {
        return;
    };
    if size.width == 0 || size.height == 0 {
        return;
    }
    if let Ok(mut last) = state.last.lock() {
        *last = Some(WindowGeometry {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
        });
    }
    persist(state);
}

/// 恢复：将保存的几何校准到主显示器工作区内（防屏幕变化后窗口不可见）。
pub fn restore(app: &tauri::AppHandle, data_dir: &Path) {
    let path = data_dir.join("window-geometry.json");
    let Ok(text) = std::fs::read_to_string(path) else {
        return;
    };
    let Ok(saved) = serde_json::from_str::<WindowGeometry>(&text) else {
        return;
    };
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Some(monitor) = app.primary_monitor().ok().flatten() else {
        return;
    };
    let area = monitor.work_area();
    let width = saved.width.clamp(320, area.size.width.max(1) as u32);
    let height = saved.height.clamp(240, area.size.height.max(1) as u32);
    let max_x = area.position.x + area.size.width as i32 - width as i32;
    let max_y = area.position.y + area.size.height as i32 - height as i32;
    let x = saved.x.clamp(area.position.x, max_x);
    let y = saved.y.clamp(area.position.y, max_y);
    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
    let _ = window.set_size(tauri::PhysicalSize::new(width, height));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn geometry_serde_roundtrip() {
        let geometry = WindowGeometry {
            x: 120,
            y: 80,
            width: 900,
            height: 700,
        };
        let text = serde_json::to_string(&geometry).unwrap();
        assert_eq!(
            serde_json::from_str::<WindowGeometry>(&text).unwrap(),
            geometry
        );
    }
}

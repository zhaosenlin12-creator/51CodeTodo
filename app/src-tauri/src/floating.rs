use crate::commands::StorageState;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Read,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{
    Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

// The ball has its own fixed-size transparent host. Preview resizing never
// touches its bitmap or native frame; no SetWindowRgn/native-style overrides.
const COLLAPSED_WIDTH: f64 = 108.0;
const COLLAPSED_HEIGHT: f64 = 88.0;
const EXPANDED_WIDTH: f64 = 390.0;
const EXPANDED_HEIGHT: f64 = 456.0;
// CSS keeps the ball center 62 DIP from the right and 44 DIP from the top.
const BALL_RIGHT: f64 = 62.0;
const BALL_TOP: f64 = 44.0;

#[derive(Default)]
pub struct FloatingState {
    expanded: AtomicBool,
    ball_focused: AtomicBool,
    preview_focused: AtomicBool,
    save: Mutex<SaveState>,
}

#[derive(Default)]
struct SaveState {
    path: Option<PathBuf>,
    changed: Option<Instant>,
    running: bool,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct BallPosition {
    x: i32,
    y: i32,
}

#[derive(Clone, Copy)]
struct WorkArea {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scale: f64,
}

#[derive(Debug, PartialEq)]
struct Layout {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

fn layout(center: BallPosition, area: WorkArea, _expanded: bool) -> Layout {
    let scale = area.scale;
    let width = (COLLAPSED_WIDTH * scale)
        .round()
        .max(1.0)
        .min(area.width.max(1) as f64) as u32;
    let height = (COLLAPSED_HEIGHT * scale)
        .round()
        .max(1.0)
        .min(area.height.max(1) as f64) as u32;
    let x = center.x as i64 - width as i64 + (BALL_RIGHT * scale).round() as i64;
    let y = center.y as i64 - (BALL_TOP * scale).round() as i64;
    Layout {
        x: x.clamp(
            area.x as i64,
            area.x as i64 + area.width.saturating_sub(width) as i64,
        ) as i32,
        y: y.clamp(
            area.y as i64,
            area.y as i64 + area.height.saturating_sub(height) as i64,
        ) as i32,
        width,
        height,
    }
}

fn ball_position(
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    scale: f64,
) -> BallPosition {
    BallPosition {
        x: position.x + size.width as i32 - (BALL_RIGHT * scale).round() as i32,
        y: position.y + (BALL_TOP * scale).round() as i32,
    }
}

fn current_ball(window: &WebviewWindow) -> Result<BallPosition, String> {
    Ok(ball_position(
        window.outer_position().map_err(|_| "无法读取浮球位置")?,
        window.inner_size().map_err(|_| "无法读取浮球大小")?,
        window.scale_factor().map_err(|_| "无法读取屏幕缩放")?,
    ))
}

fn work_area(window: &WebviewWindow, center: Option<BallPosition>) -> Result<WorkArea, String> {
    let monitor = center
        .and_then(|p| {
            window
                .monitor_from_point(p.x as f64, p.y as f64)
                .ok()
                .flatten()
        })
        .or_else(|| window.primary_monitor().ok().flatten())
        .ok_or("无法读取显示器工作区")?;
    let area = monitor.work_area();
    Ok(WorkArea {
        x: area.position.x,
        y: area.position.y,
        width: area.size.width,
        height: area.size.height,
        scale: monitor.scale_factor(),
    })
}

fn apply_layout(
    window: &WebviewWindow,
    center: BallPosition,
    expanded: bool,
) -> Result<(), String> {
    let next = layout(center, work_area(window, Some(center))?, expanded);
    let size = PhysicalSize::new(next.width, next.height);
    if window.inner_size().map_err(|_| "无法读取浮球大小")? != size {
        window.set_size(size).map_err(|_| "浮球未能调整大小")?;
    }
    let position = PhysicalPosition::new(next.x, next.y);
    if window.outer_position().map_err(|_| "无法读取浮球位置")? != position {
        window.set_position(position).map_err(|_| "浮球未能定位")?;
    }
    Ok(())
}

fn preview_layout(center: BallPosition, area: WorkArea) -> (Layout, bool) {
    let width = (EXPANDED_WIDTH * area.scale).round().min(area.width as f64) as u32;
    let height = ((EXPANDED_HEIGHT - COLLAPSED_HEIGHT) * area.scale)
        .round()
        .min(area.height as f64) as u32;
    let gap = (32.0 * area.scale).round() as i32;
    let above = center.y + gap + height as i32 > area.y + area.height as i32;
    let x = center.x - width as i32 + (BALL_RIGHT * area.scale).round() as i32;
    let y = if above {
        center.y - gap - height as i32
    } else {
        center.y + gap
    };
    (
        Layout {
            x: x.clamp(area.x, area.x + area.width.saturating_sub(width) as i32),
            y: y.clamp(area.y, area.y + area.height.saturating_sub(height) as i32),
            width,
            height,
        },
        above,
    )
}

fn collapse_if_unfocused(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Focus can transfer from ball to preview in separate Windows messages.
        std::thread::sleep(Duration::from_millis(80));
        let state = app.state::<FloatingState>();
        if !state.ball_focused.load(Ordering::SeqCst)
            && !state.preview_focused.load(Ordering::SeqCst)
        {
            let _ = app.emit("pometodo-floating-collapse", ());
        }
    });
}

fn read_position(path: &std::path::Path) -> Option<BallPosition> {
    let file = fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.take(257).read_to_end(&mut bytes).ok()?;
    if bytes.len() > 256 {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

fn write_position(path: &std::path::Path, position: BallPosition) -> Result<(), String> {
    let bytes = serde_json::to_vec(&position).map_err(|_| "浮球位置未能保存")?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, bytes).map_err(|_| "浮球位置未能保存")?;
    fs::rename(&temporary, path).map_err(|_| "浮球位置未能保存".into())
}

fn report(app: &tauri::AppHandle, error: String) {
    let _ = app.emit_to("floating", "pometodo-floating-error", &error);
    let _ = app.emit("pometodo-system-error", error);
}

// Coalesce native drag move events in one worker; do not spawn a thread per pixel.
fn schedule_position_save(app: &tauri::AppHandle) {
    let state = app.state::<FloatingState>();
    let Ok(mut save) = state.save.lock() else {
        return;
    };
    save.changed = Some(Instant::now());
    if save.running {
        return;
    }
    save.running = true;
    drop(save);
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || loop {
        std::thread::sleep(Duration::from_millis(150));
        let state = app.state::<FloatingState>();
        let Ok(save) = state.save.lock() else {
            return;
        };
        if save
            .changed
            .is_some_and(|changed| changed.elapsed() < Duration::from_millis(150))
        {
            continue;
        }
        let changed = save.changed;
        let path = save.path.clone();
        drop(save);
        // Window calls can synchronously deliver Moved; never hold the event's lock here.
        let result = (|| {
            let window = app.get_webview_window("floating").ok_or("浮球窗口不可用")?;
            let center = current_ball(&window)?;
            apply_layout(&window, center, state.expanded.load(Ordering::SeqCst))?;
            if let Some(path) = &path {
                write_position(path, current_ball(&window)?)?;
            }
            Ok::<(), String>(())
        })();
        if let Err(error) = result {
            report(&app, error);
        }
        let Ok(mut save) = state.save.lock() else {
            return;
        };
        if save.changed != changed {
            continue;
        }
        save.changed = None;
        save.running = false;
        break;
    });
}

pub fn create(app: &tauri::AppHandle) -> tauri::Result<()> {
    let window = WebviewWindowBuilder::new(
        app,
        "floating",
        WebviewUrl::App("index.html?window=floating".into()),
    )
    .title("51CodeTodo 浮球")
    .inner_size(COLLAPSED_WIDTH, COLLAPSED_HEIGHT)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .visible(false)
    .focused(false)
    .shadow(false)
    .build()?;
    let preview = WebviewWindowBuilder::new(
        app,
        "floating-preview",
        WebviewUrl::App("index.html?window=floating-preview".into()),
    )
    .title("51CodeTodo 浮球预览")
    .inner_size(EXPANDED_WIDTH, EXPANDED_HEIGHT - COLLAPSED_HEIGHT)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .visible(false)
    .focused(false)
    .shadow(false)
    .build()?;
    let preview_app = app.clone();
    preview.on_window_event(move |event| {
        if let tauri::WindowEvent::Focused(focused) = event {
            preview_app
                .state::<FloatingState>()
                .preview_focused
                .store(*focused, Ordering::SeqCst);
            if !focused {
                collapse_if_unfocused(&preview_app);
            }
        }
    });
    // This independent profile path never follows a moved task data directory.
    let path = {
        let state = app.state::<StorageState>();
        state.inner.lock().ok().and_then(|storage| {
            storage
                .as_ref()
                .ok()
                .map(|storage| storage.profile_directory.join("floating-position.json"))
        })
    };
    if let Ok(area) = work_area(&window, None) {
        let saved = path.as_deref().and_then(read_position);
        // 历史位置若落在当前主显示器工作区之外（换屏/幻影显示器/拖出过界），回到默认右上角。
        let on_primary = saved
            .as_ref()
            .map(|p| {
                p.x >= area.x
                    && p.x <= area.x + area.width as i32
                    && p.y >= area.y
                    && p.y <= area.y + area.height as i32
            })
            .unwrap_or(false);
        let initial = match (saved, on_primary) {
            (Some(position), true) => position,
            _ => BallPosition {
                x: area.x + area.width as i32 - (80.0 * area.scale).round() as i32,
                y: area.y + (50.0 * area.scale).round() as i32,
            },
        };
        if let Err(error) = apply_layout(&window, initial, false) {
            report(app, error);
        }
    }
    if let Ok(mut save) = app.state::<FloatingState>().save.lock() {
        save.path = path;
    }
    let events_app = app.clone();
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::Focused(focused) => {
            events_app
                .state::<FloatingState>()
                .ball_focused
                .store(*focused, Ordering::SeqCst);
            if !focused {
                collapse_if_unfocused(&events_app);
            }
        }
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::ScaleFactorChanged { .. } => {
            let _ = events_app.emit("pometodo-floating-collapse", ());
            schedule_position_save(&events_app);
        }
        _ => {}
    });
    Ok(())
}

pub fn is_enabled(app: &tauri::AppHandle) -> Result<bool, String> {
    let state = app.state::<StorageState>();
    let guard = state.inner.lock().map_err(|_| "浮球无法读取设置")?;
    Ok(guard
        .as_ref()
        .map_err(Clone::clone)?
        .repo
        .settings()?
        .floating_ball_enabled)
}

pub fn set_enabled(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
    {
        let state = app.state::<StorageState>();
        let mut guard = state.inner.lock().map_err(|_| "浮球无法保存设置")?;
        guard
            .as_mut()
            .map_err(|e| e.clone())?
            .repo
            .update_settings(serde_json::json!({ "floatingBallEnabled": enabled }))?;
    }
    // Let the tray and settings host refresh their switch from the persisted value.
    let _ = app.emit("pometodo-data-changed", ());
    let _ = app.emit("pometodo-floating-enabled", enabled);
    refresh(app)
}

pub fn refresh(app: &tauri::AppHandle) -> Result<(), String> {
    let should_show = {
        let state = app.state::<StorageState>();
        let guard = state.inner.lock().map_err(|_| "浮球无法读取任务")?;
        let repo = &guard.as_ref().map_err(Clone::clone)?.repo;
        // 只要开关开启就常驻显示；不再因空列表或全部完成而自动隐藏。
        repo.settings()?.floating_ball_enabled
    };
    if let Some(window) = app.get_webview_window("floating") {
        if should_show {
            if !window.is_visible().map_err(|_| "无法读取浮球显示状态")? {
                window.show().map_err(|_| "浮球未能显示")?;
            }
            app.emit_to("floating", "pometodo-floating-refresh", ())
                .map_err(|_| "浮球未能刷新")?;
            let _ = app.emit_to("floating-preview", "pometodo-floating-refresh", ());
        } else {
            let _ = app.emit("pometodo-floating-collapse", ());
            window.hide().map_err(|_| "浮球未能收起")?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn pometodo_float_expand(app: tauri::AppHandle, expanded: bool) -> Result<(), String> {
    let window = app.get_webview_window("floating").ok_or("浮球窗口不可用")?;
    let state = app.state::<FloatingState>();
    let was_expanded = state.expanded.load(Ordering::SeqCst);
    if was_expanded == expanded && !expanded {
        return Ok(());
    }
    let preview = app
        .get_webview_window("floating-preview")
        .ok_or("浮球预览不可用")?;
    if expanded {
        let center = current_ball(&window)?;
        let (next, above) = preview_layout(center, work_area(&window, Some(center))?);
        preview
            .set_size(PhysicalSize::new(next.width, next.height))
            .map_err(|_| "预览大小未能更新")?;
        preview
            .set_position(PhysicalPosition::new(next.x, next.y))
            .map_err(|_| "预览未能定位")?;
        state.expanded.store(true, Ordering::SeqCst);
        if app
            .emit_to("floating-preview", "pometodo-floating-present", above)
            .is_err()
        {
            state.expanded.store(false, Ordering::SeqCst);
            return Err("预览未能打开".into());
        }
    } else {
        preview.hide().map_err(|_| "预览未能收起")?;
        state.expanded.store(false, Ordering::SeqCst);
        let _ = app.emit("pometodo-floating-closed", ());
    }
    Ok(())
}

#[tauri::command]
pub fn pometodo_float_preview_state(app: tauri::AppHandle) -> Result<Option<bool>, String> {
    if !app.state::<FloatingState>().expanded.load(Ordering::SeqCst) {
        return Ok(None);
    }
    let ball = app.get_webview_window("floating").ok_or("浮球不可用")?;
    let center = current_ball(&ball)?;
    Ok(Some(
        preview_layout(center, work_area(&ball, Some(center))?).1,
    ))
}

#[tauri::command]
pub fn pometodo_float_present(app: tauri::AppHandle) -> Result<bool, String> {
    if !app.state::<FloatingState>().expanded.load(Ordering::SeqCst) {
        return Ok(false);
    }
    let preview = app
        .get_webview_window("floating-preview")
        .ok_or("预览不可用")?;
    preview.show().map_err(|_| "预览未能显示")?;
    preview.set_focus().map_err(|_| "预览未能获取焦点")?;
    Ok(true)
}

#[tauri::command]
pub fn pometodo_float_menu(app: tauri::AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("floating").ok_or("浮球窗口不可用")?;
    let position = window.cursor_position().map_err(|_| "无法读取菜单位置")?;
    crate::context_menu::open(&app, true, position)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenRequest {
    task_id: Option<String>,
    settings: bool,
    pending: bool,
    request_id: u64,
}

#[tauri::command]
pub fn pometodo_open_main(
    app: tauri::AppHandle,
    task_id: Option<String>,
    settings: Option<bool>,
) -> Result<(), String> {
    let settings = settings.unwrap_or(false);
    let pending = task_id.is_none() && !settings;
    // Collapse through the frontend so the old 120ms fade can finish before resizing.
    let _ = app.emit("pometodo-floating-collapse", ());
    let main = app.get_webview_window("main").ok_or("待办窗口不可用")?;
    main.unminimize().map_err(|_| "未能打开待办窗口")?;
    main.show().map_err(|_| "未能打开待办窗口")?;
    main.set_focus().map_err(|_| "未能打开待办窗口")?;
    let request_id = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "系统时间异常")?
        .as_millis() as u64;
    app.emit_to(
        "main",
        "pometodo-open",
        OpenRequest {
            task_id,
            settings,
            pending,
            request_id,
        },
    )
    .map_err(|_| "窗口未能定位任务".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn primary(scale: f64) -> WorkArea {
        WorkArea {
            x: 0,
            y: 0,
            width: 1920,
            height: 1040,
            scale,
        }
    }

    #[test]
    fn popup_expansion_does_not_move_or_resize_the_ball_horizontally() {
        let center = BallPosition { x: 1500, y: 100 };
        let collapsed = layout(center, primary(1.0), false);
        let expanded = layout(center, primary(1.0), true);
        assert_eq!(collapsed.x, expanded.x);
        assert_eq!(collapsed.width, expanded.width);
        assert_eq!(collapsed, expanded);
        let (_, above) = preview_layout(center, primary(1.0));
        assert!(!above);
        let (panel, above) = preview_layout(BallPosition { x: 1500, y: 990 }, primary(1.0));
        assert!(above);
        assert!(panel.y + panel.height as i32 <= 990);
    }

    #[test]
    fn expanding_and_collapsing_preserves_ball_center() {
        let center = BallPosition { x: 1500, y: 100 };
        let area = primary(1.0);
        for expanded in [false, true, false] {
            let position = layout(center, area, expanded);
            assert_eq!(
                ball_position(
                    PhysicalPosition::new(position.x, position.y),
                    PhysicalSize::new(position.width, position.height),
                    area.scale
                ),
                center
            );
        }
    }

    #[test]
    fn bottom_right_expansion_stays_above_taskbar() {
        let result = layout(BallPosition { x: 1910, y: 1030 }, primary(1.0), true);
        assert_eq!(result.x + result.width as i32, 1920);
        assert_eq!(result.y + result.height as i32, 1040);
    }

    #[test]
    fn negative_monitor_coordinates_are_preserved_at_high_dpi() {
        let area = WorkArea {
            x: -2560,
            y: -200,
            width: 2560,
            height: 1400,
            scale: 1.5,
        };
        let center = BallPosition { x: -600, y: 50 };
        let result = layout(center, area, true);
        assert_eq!(result.width, 162);
        assert_eq!(result.height, 132);
        assert_eq!(
            ball_position(
                PhysicalPosition::new(result.x, result.y),
                PhysicalSize::new(result.width, result.height),
                area.scale
            ),
            center
        );
    }

    #[test]
    fn disconnected_monitor_position_is_recovered_inside_available_work_area() {
        let result = layout(BallPosition { x: -5000, y: 6000 }, primary(1.0), false);
        assert_eq!(result.x, 0);
        assert_eq!(result.y + result.height as i32, 1040);
    }

    #[test]
    fn small_work_area_never_creates_a_window_larger_than_available_space() {
        let area = WorkArea {
            x: 0,
            y: 40,
            width: 360,
            height: 400,
            scale: 1.25,
        };
        let (result, _) = preview_layout(BallPosition { x: 100, y: 100 }, area);
        assert_eq!(
            result,
            Layout {
                x: 0,
                y: 40,
                width: 360,
                height: 400
            }
        );
    }

    #[test]
    fn position_file_survives_overwrite_and_accepts_negative_coordinates() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("floating-position.json");
        write_position(&path, BallPosition { x: 100, y: 50 }).unwrap();
        let expected = BallPosition { x: -1200, y: -80 };
        write_position(&path, expected).unwrap();
        assert_eq!(read_position(&path), Some(expected));
        fs::write(&path, vec![b' '; 257]).unwrap();
        assert_eq!(read_position(&path), None);
    }
}

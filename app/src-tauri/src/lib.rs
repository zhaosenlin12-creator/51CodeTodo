mod ai_extract;
mod ai_http;
mod auto_backup;
#[cfg(windows)]
mod clipboard;
mod commands;
#[cfg(windows)]
mod context_menu;
mod distribution;
mod file_commands;
#[cfg(windows)]
mod floating;
#[cfg(windows)]
mod local_extract;
#[cfg(windows)]
mod ocr;
#[cfg(feature = "official-services")]
mod official;
mod reminders;
mod secrets;
mod service_extension;
mod settings_commands;
mod smart_arrange;
mod sync;
mod sync_http;
mod updates;
#[cfg(windows)]
mod window_effects;
#[cfg(windows)]
mod window_geometry;

#[cfg(not(windows))]
mod mobile_stub;

use commands::StorageState;
use std::sync::Arc;
#[cfg(windows)]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};

fn show_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        #[cfg(windows)]
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn app_icon() -> tauri::image::Image<'static> {
    let image = image::load_from_memory(include_bytes!("../icons/icon.png"))
        .expect("embedded legacy logo must be a valid PNG")
        .into_rgba8();
    let (width, height) = image.dimensions();
    tauri::image::Image::new_owned(image.into_raw(), width, height)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    #[cfg(windows)]
    {
        builder = builder
            .plugin(
                tauri_plugin_autostart::Builder::new()
                    .app_name(if cfg!(debug_assertions) {
                        "51CodeTodo Development"
                    } else {
                        "51CodeTodo"
                    })
                    .arg("--autostart")
                    .build(),
            )
            .plugin(tauri_plugin_single_instance::init(|app, _, _| {
                show_window(app)
            }));
    }
    builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let base = app.path().app_local_data_dir()?;
            let data_dir = if cfg!(debug_assertions) {
                base.join("development")
            } else {
                base.join("data")
            };
            app.manage(StorageState::open(data_dir.clone()));
            app.manage(file_commands::PendingFiles::default());
            #[cfg(windows)]
            app.manage(floating::FloatingState::default());
            #[cfg(windows)]
            let window_geometry = Arc::new(window_geometry::WindowGeometryState::default());
            #[cfg(windows)]
            window_geometry::configure(&window_geometry, &data_dir);
            #[cfg(windows)]
            app.manage(window_geometry);
            #[cfg(windows)]
            app.manage(context_menu::ContextMenuState::default());
            app.manage(updates::UpdateState::default());
            app.manage(sync::MemberCache::default());
            #[cfg(windows)]
            floating::create(app.handle())?;
            #[cfg(windows)]
            context_menu::create(app.handle())?;
            let start_minimized = {
                let state = app.state::<StorageState>();
                let guard = state.inner.lock().map_err(|_| "无法读取启动设置")?;
                guard
                    .as_ref()
                    .ok()
                    .and_then(|storage| storage.repo.settings().ok())
                    .is_some_and(|settings| settings.start_minimized)
            };
            #[cfg(windows)]
            TrayIconBuilder::new()
                .icon(app_icon())
                .tooltip("51CodeTodo 待办")
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Right,
                        button_state: MouseButtonState::Up,
                        position,
                        ..
                    } = event
                    {
                        if let Err(error) = context_menu::open(tray.app_handle(), false, position) {
                            let _ = tray.app_handle().emit("pometodo-system-error", error);
                        }
                        return;
                    }
                    if matches!(
                        event,
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        }
                    ) {
                        show_window(tray.app_handle());
                    }
                })
                .build(app)?;
            #[cfg(windows)]
            if let Some(window) = app.get_webview_window("main") {
                window_geometry::restore(app.handle(), &data_dir);
                let _ = window.set_icon(app_icon());
                let startup_settings = app
                    .state::<StorageState>()
                    .inner
                    .lock()
                    .ok()
                    .and_then(|guard| guard.as_ref().ok().and_then(|storage| storage.repo.settings().ok()));
                if let Some(settings) = startup_settings {
                    window_effects::apply(app.handle(), &settings);
                }
                if updates::should_show_on_start(start_minimized, std::env::args_os().skip(1)) {
                    window.show()?;
                    let _ = window.set_focus();
                }
            }
            auto_backup::run_on_start(app.handle());
            reminders::start(app.handle().clone());
            sync::start(app.handle().clone());
            #[cfg(windows)]
            let _ = floating::refresh(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(windows)]
            if window.label() == "main"
                && matches!(
                    event,
                    tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Focused(_)
                )
            {
                let app = window.app_handle().clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let _ = floating::refresh(&app);
                });
            }
            #[cfg(windows)]
            if window.label() == "main"
                && matches!(
                    event,
                    tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)
                )
            {
                let state = window
                    .app_handle()
                    .state::<Arc<window_geometry::WindowGeometryState>>();
                window_geometry::remember(&window, state.inner());
            }
            #[cfg(windows)]
            if window.label() == "main"
                && matches!(event, tauri::WindowEvent::CloseRequested { .. })
            {
                let state = window
                    .app_handle()
                    .state::<Arc<window_geometry::WindowGeometryState>>();
                window_geometry::flush(&window, state.inner());
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let should_exit = {
                    let state = window.app_handle().state::<StorageState>();
                    state
                        .inner
                        .lock()
                        .ok()
                        .and_then(|guard| {
                            guard
                                .as_ref()
                                .ok()
                                .and_then(|storage| storage.repo.settings().ok())
                        })
                        .is_some_and(|settings| settings.close_action == "exit")
                };
                if window.label() == "main" && should_exit {
                    window.app_handle().exit(0);
                    return;
                }
                api.prevent_close();
                let _ = window.hide();
                #[cfg(windows)]
                if window.label() == "main" {
                    let _ = floating::refresh(window.app_handle());
                }
            }
        })
        .invoke_handler({
            #[cfg(windows)]
            let shared: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
                updates::pometodo_check_update,
                updates::pometodo_download_update,
                updates::pometodo_install_update,
                commands::pometodo_app_info,
                settings_commands::pometodo_settings_load,
                settings_commands::pometodo_settings_update,
                settings_commands::pometodo_customer_rename,
                settings_commands::pometodo_customer_hide,
                settings_commands::pometodo_key_save,
                settings_commands::pometodo_key_clear,
                file_commands::pometodo_choose_directory,
                file_commands::pometodo_apply_directory,
                file_commands::pometodo_export_backup,
                file_commands::pometodo_export_markdown,
                file_commands::pometodo_choose_backup_import,
                file_commands::pometodo_import_backup,
                floating::pometodo_float_expand,
                floating::pometodo_float_present,
                floating::pometodo_float_preview_state,
                floating::pometodo_float_menu,
                floating::pometodo_open_main,
                context_menu::pometodo_menu_snapshot,
                context_menu::pometodo_menu_present,
                context_menu::pometodo_menu_action,
                commands::pometodo_set_theme,
                commands::pometodo_list_tasks,
                commands::pometodo_create_task,
                commands::pometodo_update_task,
                commands::pometodo_set_status,
                commands::pometodo_set_urgent,
                commands::pometodo_set_assignee,
                commands::pometodo_archive_task,
                commands::pometodo_unarchive_task,
                commands::pometodo_set_reminder,
                commands::pometodo_poll_reminders,
                commands::pometodo_snooze_reminder,
                commands::pometodo_cancel_reminder,
                commands::pometodo_delete_task,
                commands::pometodo_attachment_data_url,
                commands::pometodo_open_attachment,
                clipboard::pometodo_recognize_clipboard,
                clipboard::pometodo_recognize_attachment,
                clipboard::pometodo_arrange_text,
                smart_arrange::pometodo_smart_arrange_state,
                smart_arrange::pometodo_set_smart_arrange,
                clipboard::pometodo_save_clipboard_attachment,
                clipboard::pometodo_import_attachment,
                sync::pometodo_sync_config_get,
                sync::pometodo_sync_config_update,
                sync::pometodo_sync_join,
                sync::pometodo_sync_now,
                sync::pometodo_sync_members,
            ];
            #[cfg(not(windows))]
            let shared: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
                updates::pometodo_check_update,
                updates::pometodo_download_update,
                updates::pometodo_install_update,
                commands::pometodo_app_info,
                settings_commands::pometodo_settings_load,
                settings_commands::pometodo_settings_update,
                settings_commands::pometodo_customer_rename,
                settings_commands::pometodo_customer_hide,
                settings_commands::pometodo_key_save,
                settings_commands::pometodo_key_clear,
                mobile_stub::pometodo_choose_directory,
                mobile_stub::pometodo_apply_directory,
                mobile_stub::pometodo_export_backup,
                mobile_stub::pometodo_export_markdown,
                mobile_stub::pometodo_choose_backup_import,
                file_commands::pometodo_import_backup,
                mobile_stub::pometodo_float_expand,
                mobile_stub::pometodo_float_present,
                mobile_stub::pometodo_float_preview_state,
                mobile_stub::pometodo_float_menu,
                mobile_stub::pometodo_open_main,
                mobile_stub::pometodo_menu_snapshot,
                mobile_stub::pometodo_menu_present,
                mobile_stub::pometodo_menu_action,
                commands::pometodo_set_theme,
                commands::pometodo_list_tasks,
                commands::pometodo_create_task,
                commands::pometodo_update_task,
                commands::pometodo_set_status,
                commands::pometodo_set_urgent,
                commands::pometodo_set_assignee,
                commands::pometodo_archive_task,
                commands::pometodo_unarchive_task,
                commands::pometodo_set_reminder,
                commands::pometodo_poll_reminders,
                commands::pometodo_snooze_reminder,
                commands::pometodo_cancel_reminder,
                commands::pometodo_delete_task,
                commands::pometodo_attachment_data_url,
                commands::pometodo_open_attachment,
                mobile_stub::pometodo_recognize_clipboard,
                mobile_stub::pometodo_recognize_attachment,
                mobile_stub::pometodo_arrange_text,
                smart_arrange::pometodo_smart_arrange_state,
                smart_arrange::pometodo_set_smart_arrange,
                mobile_stub::pometodo_save_clipboard_attachment,
                mobile_stub::pometodo_import_attachment,
                sync::pometodo_sync_config_get,
                sync::pometodo_sync_config_update,
                sync::pometodo_sync_join,
                sync::pometodo_sync_now,
                sync::pometodo_sync_members,
            ];
            move |request: tauri::ipc::Invoke<tauri::Wry>| {
                #[cfg(feature = "official-services")]
                if request.message.command().starts_with("pometodo_official_") {
                    return official::handle(request);
                }
                shared(request)
            }
        })
        .run(tauri::generate_context!())
        .expect("PomeTodo 无法启动");
}

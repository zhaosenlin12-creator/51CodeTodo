use crate::{commands::with_storage, secrets::KeyStore};
use pometodo_core::{
    local::LocalStorage,
    smart_arrange::{SmartArrangePreferences, SmartArrangeSource},
};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartArrangeSnapshot {
    pub preferences: SmartArrangePreferences,
    pub available: bool,
    pub message: String,
}

pub fn require_enabled(preferences: &SmartArrangePreferences) -> Result<(), String> {
    if !preferences.enabled {
        return Err("智能整理尚未开启".into());
    }
    Ok(())
}

pub fn selected_user_key(storage: &LocalStorage) -> Result<(String, String), String> {
    let preferences =
        crate::distribution::effective_preferences(storage.repo.smart_arrange_preferences()?);
    require_enabled(&preferences)?;
    if preferences.source != SmartArrangeSource::Byok {
        return Err("请先登录并开通官方智能整理".into());
    }
    let provider = storage.repo.settings()?.ai_provider;
    let key = KeyStore::new(&storage.profile_directory.join("secrets"))
        .read(&provider)?
        .ok_or_else(|| "请在设置中保存所选服务商的 API Key".to_string())?;
    Ok((provider, key))
}

/// 按偏好顺序返回所有已保存 Key 的服务商（首选在前，去重），供文本整理自动故障切换。
pub fn candidate_user_keys(storage: &LocalStorage) -> Result<Vec<(String, String)>, String> {
    let preferences =
        crate::distribution::effective_preferences(storage.repo.smart_arrange_preferences()?);
    require_enabled(&preferences)?;
    if preferences.source != SmartArrangeSource::Byok {
        return Err("请先登录并开通官方智能整理".into());
    }
    let preferred = storage.repo.settings()?.ai_provider;
    let order = [preferred.as_str(), "minimax", "deepseek", "qwen", "glm"];
    let store = KeyStore::new(&storage.profile_directory.join("secrets"));
    let mut out: Vec<(String, String)> = Vec::new();
    for provider in order {
        if out.iter().any(|(p, _)| p == provider) {
            continue;
        }
        if let Some(key) = store.read(provider)? {
            out.push((provider.to_string(), key));
        }
    }
    if out.is_empty() {
        return Err("请在设置中保存至少一个服务商的 API Key".into());
    }
    Ok(out)
}

fn snapshot(storage: &LocalStorage) -> Result<SmartArrangeSnapshot, String> {
    let preferences =
        crate::distribution::effective_preferences(storage.repo.smart_arrange_preferences()?);
    let (available, message) = if !preferences.enabled {
        (false, "智能整理已关闭".into())
    } else {
        match selected_user_key(storage) {
            Ok(_) => (true, "使用自带 Key，消耗所选服务商账户额度".into()),
            Err(message) => (false, message),
        }
    };
    Ok(SmartArrangeSnapshot {
        preferences,
        available,
        message,
    })
}

#[tauri::command]
pub async fn pometodo_smart_arrange_state(
    app: tauri::AppHandle,
) -> Result<SmartArrangeSnapshot, String> {
    let (mut value, root) = with_storage(app, |storage| {
        Ok((snapshot(storage)?, storage.profile_directory.clone()))
    })
    .await?;
    if value.preferences.enabled && value.preferences.source == SmartArrangeSource::Official {
        let result = tauri::async_runtime::spawn_blocking(move || {
            crate::service_extension::available(&root)
        })
        .await
        .map_err(|_| "读取官方服务状态未完成")?;
        match result {
            Ok((available, message)) => {
                value.available = available;
                value.message = message;
            }
            Err(message) => {
                value.available = false;
                value.message = message;
            }
        }
    }
    Ok(value)
}

#[tauri::command]
pub async fn pometodo_set_smart_arrange(
    app: tauri::AppHandle,
    preferences: SmartArrangePreferences,
) -> Result<SmartArrangeSnapshot, String> {
    crate::distribution::validate_preferences(&preferences)?;
    with_storage(app.clone(), move |storage| {
        storage.repo.set_smart_arrange_preferences(preferences)?;
        Ok(())
    })
    .await?;
    pometodo_smart_arrange_state(app).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(not(feature = "official-services"))]
    fn fresh_install_and_saved_official_selection_are_byok_without_auto_enable() {
        let dir = tempfile::tempdir().unwrap();
        let mut storage = LocalStorage::open(dir.path()).unwrap();
        let value = snapshot(&storage).unwrap();
        assert_eq!(value.preferences.source, SmartArrangeSource::Byok);
        assert!(!value.preferences.enabled);
        let saved = SmartArrangePreferences {
            enabled: true,
            source: SmartArrangeSource::Official,
        };
        storage
            .repo
            .set_smart_arrange_preferences(saved.clone())
            .unwrap();
        let value = snapshot(&storage).unwrap();
        assert_eq!(value.preferences.source, SmartArrangeSource::Byok);
        assert!(!value.preferences.enabled);
        assert!(!value.available);
        assert_eq!(
            storage.repo.smart_arrange_preferences().unwrap(),
            saved,
            "读取不能改写旧设置"
        );
    }

    #[test]
    fn disabled_and_official_cannot_read_a_byok_key() {
        let dir = tempfile::tempdir().unwrap();
        let mut storage = LocalStorage::open(dir.path()).unwrap();
        assert_eq!(selected_user_key(&storage).unwrap_err(), "智能整理尚未开启");
        storage
            .repo
            .set_smart_arrange_preferences(SmartArrangePreferences {
                enabled: true,
                source: SmartArrangeSource::Official,
            })
            .unwrap();
        assert_eq!(
            selected_user_key(&storage).unwrap_err(),
            if crate::distribution::OFFICIAL_SERVICES {
                "请先登录并开通官方智能整理"
            } else {
                "智能整理尚未开启"
            }
        );
        storage
            .repo
            .set_smart_arrange_preferences(SmartArrangePreferences {
                enabled: true,
                source: SmartArrangeSource::Byok,
            })
            .unwrap();
        assert_eq!(
            selected_user_key(&storage).unwrap_err(),
            "请在设置中保存所选服务商的 API Key"
        );
    }
}

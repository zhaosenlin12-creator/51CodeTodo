use pometodo_core::smart_arrange::{SmartArrangePreferences, SmartArrangeSource};

pub const OFFICIAL_SERVICES: bool = cfg!(feature = "official-services");
pub const SERVICE_MODE: &str = if OFFICIAL_SERVICES {
    "official"
} else {
    "byok"
};
pub const UPDATE_CHANNEL: &str = if OFFICIAL_SERVICES {
    "standalone"
} else {
    "byok"
};
pub const MANIFEST_URL: &str = if OFFICIAL_SERVICES {
    "https://www.shiliux.com/downloads/pometodo/latest/release.json"
} else {
    "https://www.shiliux.com/downloads/pometodo/byok/latest/release.json"
};
pub const DOWNLOAD_PATH: &str = if OFFICIAL_SERVICES {
    "/downloads/pometodo/releases/"
} else {
    "/downloads/pometodo/byok/releases/"
};

pub fn effective_preferences(mut value: SmartArrangePreferences) -> SmartArrangePreferences {
    if !OFFICIAL_SERVICES && value.source == SmartArrangeSource::Official {
        value.enabled = false;
        value.source = SmartArrangeSource::Byok;
    }
    value
}

pub fn validate_preferences(value: &SmartArrangePreferences) -> Result<(), String> {
    if !OFFICIAL_SERVICES && value.source != SmartArrangeSource::Byok {
        return Err("请使用自带 Key 配置智能整理".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_selection_is_validated_without_auto_enabling_or_changing_byok() {
        for enabled in [false, true] {
            let byok = SmartArrangePreferences {
                enabled,
                source: SmartArrangeSource::Byok,
            };
            assert!(validate_preferences(&byok).is_ok());
            assert_eq!(effective_preferences(byok.clone()), byok);
            let official = SmartArrangePreferences {
                enabled,
                source: SmartArrangeSource::Official,
            };
            assert_eq!(validate_preferences(&official).is_ok(), OFFICIAL_SERVICES);
            if OFFICIAL_SERVICES {
                assert_eq!(effective_preferences(official.clone()), official);
            } else {
                assert_eq!(
                    effective_preferences(official),
                    SmartArrangePreferences {
                        enabled: false,
                        source: SmartArrangeSource::Byok
                    }
                );
            }
        }
    }
}

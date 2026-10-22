use pometodo_core::{
    local::LocalStorage,
    smart_arrange::{SmartArrangePreferences, SmartArrangeSource},
};

#[test]
fn fresh_profile_is_disabled_and_selection_survives_restart_without_keys_or_accounts() {
    let dir = tempfile::tempdir().unwrap();
    {
        let mut storage = LocalStorage::open(dir.path()).unwrap();
        let initial = storage.repo.smart_arrange_preferences().unwrap();
        assert!(!initial.enabled);
        assert_eq!(initial.source, SmartArrangeSource::Official);
        storage
            .repo
            .set_smart_arrange_preferences(SmartArrangePreferences {
                enabled: true,
                source: SmartArrangeSource::Byok,
            })
            .unwrap();
    }
    let storage = LocalStorage::open(dir.path()).unwrap();
    assert_eq!(
        storage.repo.smart_arrange_preferences().unwrap(),
        SmartArrangePreferences {
            enabled: true,
            source: SmartArrangeSource::Byok,
        }
    );
}

#[test]
fn unsupported_source_or_unknown_fields_are_rejected() {
    for input in [
        r#"{"enabled":true,"source":"fallback"}"#,
        r#"{"enabled":true,"source":"official","remaining":100}"#,
        r#"{"enabled":"true","source":"byok"}"#,
    ] {
        assert!(serde_json::from_str::<SmartArrangePreferences>(input).is_err());
    }
}

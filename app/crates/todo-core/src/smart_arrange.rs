use crate::store::TodoRepository;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SmartArrangeSource {
    #[default]
    Official,
    Byok,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SmartArrangePreferences {
    pub enabled: bool,
    pub source: SmartArrangeSource,
}

impl TodoRepository {
    pub fn smart_arrange_preferences(&self) -> Result<SmartArrangePreferences, String> {
        match self.read_preference("smart_arrange")? {
            None => Ok(SmartArrangePreferences::default()),
            Some(value) => {
                serde_json::from_str(&value).map_err(|_| "智能整理设置无法读取，请重新设置".into())
            }
        }
    }

    pub fn set_smart_arrange_preferences(
        &mut self,
        value: SmartArrangePreferences,
    ) -> Result<SmartArrangePreferences, String> {
        let json = serde_json::to_string(&value).map_err(|_| "智能整理设置无法保存".to_string())?;
        self.save_preferences(&[("smart_arrange", &json)])?;
        Ok(value)
    }
}

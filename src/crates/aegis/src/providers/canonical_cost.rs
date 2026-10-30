//! Cost estimation for model usage.
//!
//! Price resolution precedence (highest first):
//! 1. provider-reported costs (handled by callers before this module)
//! 2. prices the user declared in a custom provider config file — users of
//!    custom endpoints (negotiated rates, gateways, self-hosting) know their
//!    real prices better than a name-matched catalog entry
//! 3. the bundled canonical registry
//! 4. prices declared in bundled declarative provider definitions, which only
//!    fill registry gaps — they are vendored and may lag registry syncs. A
//!    registry price that is unset or zero (e.g. a name-inferred cross-provider
//!    match against a free listing) counts as a gap here.
//!
//! Note: a non-zero price the registry finds by cross-provider name inference
//! still outranks bundled provider-declared prices (a host may declare a
//! higher negotiated rate than the inferred catalog row). Demoting inferred
//! matches belongs in the canonical mapping layer, not here.
//!
//! Base cache rates only survive when declared input and output match the base tariff.
//! Otherwise cached tokens use the declared input rate. Non-USD declared prices
//! cannot be estimated in USD without FX. Config files are read live;
//! bundled definitions are immutable and cached for the process.

use crate::config::declarative_providers::{
    custom_provider_file_path, deserialize_provider_config, fixed_provider_configs,
    DeclarativeProviderConfig,
};
use crate::providers::base::ModelInfo;
use aegis_providers::canonical::{maybe_get_canonical_model, Pricing};
use aegis_providers::conversation::token_usage::{CostSource, ProviderUsage, Usage};
use std::sync::OnceLock;
use tracing::warn;

const DEFAULT_CURRENCY: &str = "$";

/// Estimate the USD cost of a model invocation.
pub fn estimate_model_cost(provider: &str, model: &str, usage: &Usage) -> Option<f64> {
    resolve_pricing(provider, model).and_then(|pricing| pricing.estimate_cost(usage))
}

/// Resolve the cost of a provider-reported usage chunk: the provider's own
/// figure when present, otherwise a public-price estimate for the model, or
/// nothing when the model cannot be priced. Both agent loops call this so
/// estimated and provider-reported costs behave identically on either path.
pub(crate) fn resolve_usage_cost(
    provider: Option<&str>,
    usage: &ProviderUsage,
) -> (Option<f64>, Option<CostSource>) {
    if let Some(cost) = usage.cost {
        return (Some(cost), Some(CostSource::ProviderReported));
    }
    match provider.and_then(|provider| estimate_model_cost(provider, &usage.model, &usage.usage)) {
        Some(cost) => (Some(cost), Some(CostSource::Estimated)),
        None => (None, None),
    }
}

/// Resolve the pricing for a provider/model honoring the precedence described
/// in this module's documentation.
pub(crate) fn resolve_pricing(provider: &str, model: &str) -> Option<Pricing> {
    let custom_info = custom_file_model_info(provider, model);
    if custom_info.as_ref().is_some_and(|info| !is_usd(info)) {
        return None;
    }
    let bundled_info = bundled_model_info(provider, model);
    if custom_info.is_none() && bundled_info.as_ref().is_some_and(|info| !is_usd(info)) {
        return None;
    }
    let canonical = maybe_get_canonical_model(provider, model).map(|c| c.cost);
    let bundled = bundled_info.as_ref().and_then(pricing_from_model_info);
    let base = match (canonical, bundled) {
        (Some(mut canonical), Some(bundled)) => {
            if is_price_gap(canonical.input) {
                canonical.input = bundled.input;
            }
            if is_price_gap(canonical.output) {
                canonical.output = bundled.output;
            }
            Some(canonical)
        }
        (Some(canonical), None) => Some(canonical),
        (None, bundled) => bundled,
    };

    let declared = custom_info.as_ref().and_then(pricing_from_model_info);
    match (declared, base) {
        (Some(declared), Some(base)) => Some(merge_pricing(declared, &base)),
        (Some(declared), None) => Some(declared),
        (None, base) => base,
    }
}

/// [`ModelInfo`] for a pricing-declared model — custom provider config file
/// first, then bundled definitions. Only models declaring both input and
/// output prices qualify: partial pricing cannot be estimated correctly
/// without silently pricing one direction at zero.
pub(crate) fn configured_model_info(provider: &str, model: &str) -> Option<ModelInfo> {
    custom_file_model_info(provider, model).or_else(|| bundled_model_info(provider, model))
}

/// The currency clients render alongside config-declared prices. Clients print
/// this verbatim as a symbol, so the ISO codes configs commonly use (bundled
/// definitions declare `USD`) are mapped to their symbol; anything else is
/// shown exactly as declared.
pub(crate) fn display_currency(info: Option<&ModelInfo>) -> String {
    info.and_then(|info| info.currency.as_deref())
        .map(currency_symbol)
        .unwrap_or_else(|| DEFAULT_CURRENCY.to_string())
}

fn currency_symbol(declared: &str) -> String {
    let declared = declared.trim();
    match declared.to_ascii_uppercase().as_str() {
        "" | "USD" => DEFAULT_CURRENCY.to_string(),
        "EUR" => "€".to_string(),
        "GBP" => "£".to_string(),
        "JPY" => "¥".to_string(),
        _ => declared.to_string(),
    }
}

/// Merge user-declared pricing with registry/bundled pricing: declared
/// input/output prices win; base cache rates apply only to the same tariff.
/// Otherwise cache usage falls back to the declared input price.
fn merge_pricing(mut declared: Pricing, base: &Pricing) -> Pricing {
    if declared.input != base.input || declared.output != base.output {
        return declared;
    }
    if declared.cache_read.is_none() {
        declared.cache_read = base.cache_read;
    }
    if declared.cache_write.is_none() {
        declared.cache_write = base.cache_write;
    }
    declared
}

/// Convert a declarative [`ModelInfo`]'s per-token USD costs into canonical
/// [`Pricing`] (per-million-token USD).
fn pricing_from_model_info(info: &ModelInfo) -> Option<Pricing> {
    if !is_usd(info) {
        return None;
    }
    Some(Pricing {
        input: Some(info.input_token_cost.map(|c| c * 1_000_000.0)?),
        output: Some(info.output_token_cost.map(|c| c * 1_000_000.0)?),
        cache_read: None,
        cache_write: None,
        tiers: Vec::new(),
    })
}

fn is_usd(info: &ModelInfo) -> bool {
    info.currency.as_deref().is_none_or(|currency| {
        currency.trim().is_empty()
            || currency.trim() == "$"
            || currency.trim().eq_ignore_ascii_case("USD")
    })
}

/// Read the custom provider config file for `provider` from disk. Reads are
/// live: price edits take effect without a restart.
fn custom_file_model_info(provider: &str, model: &str) -> Option<ModelInfo> {
    let path = custom_provider_file_path(provider).ok()?;
    if !path.exists() {
        return None;
    }
    let content = match std::fs::read_to_string(&path) {
        Ok(content) => content,
        Err(e) => {
            warn!(path = %path.display(), error = %e, "custom provider config unreadable; cost fallback disabled");
            return None;
        }
    };
    let config = match deserialize_provider_config(&content) {
        Ok(config) => config,
        Err(e) => {
            warn!(provider = %provider, error = %e, "custom provider config failed to parse; cost fallback disabled");
            return None;
        }
    };
    full_pricing_model(&config, model)
}

/// Bundled declarative provider definitions are embedded and immutable, so
/// they are cached for the lifetime of the process.
fn bundled_model_info(provider: &str, model: &str) -> Option<ModelInfo> {
    static CONFIGS: OnceLock<Vec<DeclarativeProviderConfig>> = OnceLock::new();
    let configs = CONFIGS.get_or_init(|| fixed_provider_configs().unwrap_or_default());
    configs
        .iter()
        .find(|config| config.name == provider)
        .and_then(|config| full_pricing_model(config, model))
}

/// A registry price that is unset or zero provides no usable rate signal
/// (e.g. a name-inferred cross-provider match against a free listing).
fn is_price_gap(price: Option<f64>) -> bool {
    matches!(price, None | Some(0.0))
}

fn full_pricing_model(config: &DeclarativeProviderConfig, model: &str) -> Option<ModelInfo> {
    config
        .models
        .iter()
        .find(|m| m.name == model)
        .filter(|info| info.input_token_cost.is_some() && info.output_token_cost.is_some())
        .cloned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::declarative_providers::custom_providers_dir;

    fn usage(input: Option<i32>, output: Option<i32>, cache_read: Option<i32>) -> Usage {
        Usage {
            input_tokens: input,
            output_tokens: output,
            total_tokens: None,
            cache_read_input_tokens: cache_read,
            cache_write_input_tokens: None,
        }
    }

    /// `expected` reads as the model's base input-plus-output rate per million
    /// tokens; the prompt stays below every long-context tier.
    fn assert_cost(provider: &str, model: &str, expected: f64) {
        let used = usage(Some(10_000), Some(10_000), None);
        let actual = estimate_model_cost(provider, model, &used)
            .unwrap_or_else(|| panic!("{provider}/{model} should have public pricing"))
            * 100.0;
        assert!((actual - expected).abs() < 1e-9, "got {actual}");
    }

    #[test]
    fn provider_reported_cost_takes_precedence_over_public_estimate() {
        let usage = ProviderUsage::new(
            "gpt-5.6-sol".to_string(),
            usage(Some(1_000_000), Some(1_000_000), None),
        )
        .with_cost(7.0, CostSource::ProviderReported);

        assert_eq!(
            resolve_usage_cost(Some("chatgpt_codex"), &usage),
            (Some(7.0), Some(CostSource::ProviderReported))
        );
    }

    #[test]
    fn chatgpt_codex_uses_openai_public_rates() {
        assert_cost("chatgpt_codex", "gpt-5.6-sol", 24.0);
        let codex = resolve_pricing("chatgpt_codex", "gpt-5.6-sol").unwrap();
        let openai = resolve_pricing("openai", "gpt-5.6-sol").unwrap();
        assert_eq!(codex.input, openai.input);
        assert_eq!(codex.output, openai.output);
        assert_eq!(codex.cache_read, openai.cache_read);
        assert_eq!(codex.cache_write, openai.cache_write);
    }

    #[test]
    fn azure_foundry_estimates_representative_publisher_rates() {
        assert_cost("azure_foundry", "gpt-5", 11.25);
        assert_cost("azure_foundry", "claude-sonnet-4-6", 18.0);
        assert_cost("azure_foundry", "deepseek-v3.2", 2.26);
        assert_cost("azure_foundry", "mistral-large", 2.0);
    }

    #[test]
    fn azure_foundry_uses_host_rates_for_azure_and_open_weight_models() {
        assert_cost("azure_foundry", "Phi-4", 0.625);

        // The upstream Meta row describes free weights; Azure's host row prices inference.
        assert_cost("azure_foundry", "llama-3.3-70b-instruct", 1.42);
    }

    #[test]
    fn azure_foundry_unknown_model_has_no_estimate() {
        assert!(estimate_model_cost(
            "azure_foundry",
            "private-deployment-without-metadata",
            &usage(Some(1_000_000), Some(1_000_000), None),
        )
        .is_none());
    }

    #[test]
    fn pricing_from_model_info_converts_per_token_to_per_million_usd() {
        let info = ModelInfo::with_cost("m", 262_144, 0.000002, 0.000006);
        let pricing = pricing_from_model_info(&info).unwrap();
        assert!((pricing.input.unwrap() - 2.0).abs() < 1e-9);
        assert!((pricing.output.unwrap() - 6.0).abs() < 1e-9);
    }

    #[test]
    fn non_usd_pricing_is_not_converted_without_fx() {
        let mut info = ModelInfo::with_cost("m", 1_000, 0.000002, 0.000006);
        info.currency = Some("EUR".to_string());
        assert!(pricing_from_model_info(&info).is_none());
        info.currency = Some("eur".to_string());
        assert!(pricing_from_model_info(&info).is_none());
        info.currency = Some("$".to_string());
        assert!(pricing_from_model_info(&info).is_some());
        info.currency = Some(" usd ".to_string());
        assert!(pricing_from_model_info(&info).is_some());
    }

    #[test]
    fn pricing_from_model_info_returns_none_without_prices() {
        let info = ModelInfo::new("m").with_context_limit(1_000);
        assert!(pricing_from_model_info(&info).is_none());
    }

    #[test]
    fn partial_pricing_is_rejected() {
        let mut info = ModelInfo::new("m").with_context_limit(1_000);
        info.input_token_cost = Some(0.000002);
        assert!(pricing_from_model_info(&info).is_none());
    }

    #[test]
    fn different_declared_tariff_does_not_inherit_base_cache_rates() {
        let merged = merge_pricing(
            Pricing {
                input: Some(2.0),
                output: Some(6.0),
                cache_read: None,
                cache_write: None,
                ..Default::default()
            },
            &Pricing {
                input: Some(3.0),
                output: Some(15.0),
                cache_read: Some(0.3),
                cache_write: Some(3.75),
                ..Default::default()
            },
        );
        let used = usage(Some(1_000_000), Some(0), Some(1_000_000));
        assert_eq!(merged.estimate_cost(&used), Some(2.0));
        assert_eq!(merged.input, Some(2.0));
        assert_eq!(merged.output, Some(6.0));
        assert_eq!(merged.cache_read, None);
        assert_eq!(merged.cache_write, None);
    }

    #[test]
    fn declared_zero_price_suppresses_registry_cache_rates() {
        // A model explicitly declared free in a custom config must not pick up
        // catalog cache pricing from a canonical name-match.
        let merged = merge_pricing(
            Pricing {
                input: Some(0.0),
                output: Some(0.0),
                cache_read: None,
                cache_write: None,
                ..Default::default()
            },
            &Pricing {
                input: Some(3.0),
                output: Some(15.0),
                cache_read: Some(0.3),
                cache_write: Some(3.75),
                ..Default::default()
            },
        );
        assert_eq!(merged.cache_read, None);
        assert_eq!(merged.cache_write, None);
        let usage = usage(Some(1_000_000), Some(0), Some(1_000_000));
        assert_eq!(merged.estimate_cost(&usage), Some(0.0));
    }

    #[test]
    fn matching_declared_tariff_keeps_base_cache_rate() {
        let merged = merge_pricing(
            Pricing {
                input: Some(3.0),
                output: Some(15.0),
                cache_read: None,
                cache_write: None,
                ..Default::default()
            },
            &Pricing {
                input: Some(3.0),
                output: Some(15.0),
                cache_read: Some(0.3),
                cache_write: None,
                ..Default::default()
            },
        );
        let usage = usage(Some(1_000_000), Some(0), Some(1_000_000));
        assert!((merged.estimate_cost(&usage).unwrap() - 0.3).abs() < 1e-9);
    }

    #[test]
    fn bundled_provider_prices_are_respected() {
        let info = configured_model_info("ovhcloud", "Qwen3-32B").unwrap();
        assert!((info.input_token_cost.unwrap() - 9e-8).abs() < 1e-12);
        let pricing = resolve_pricing("ovhcloud", "Qwen3-32B").unwrap();
        assert!((pricing.input.unwrap() - 0.09).abs() < 1e-9);
        assert!((pricing.output.unwrap() - 0.25).abs() < 1e-9);
    }

    #[test]
    fn custom_file_prices_drive_estimation() {
        let temp_dir = tempfile::tempdir().unwrap();
        let temp_root = temp_dir.path().display().to_string();
        let _guard = env_lock::lock_env([("AEGIS_PATH_ROOT", Some(temp_root.as_str()))]);

        let dir = custom_providers_dir();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("priced_gateway.json"),
            r#"{
                "name": "priced_gateway",
                "engine": "openai",
                "display_name": "Gateway",
                "description": null,
                "api_key_env": "",
                "base_url": "https://example.invalid/v1",
                "models": [
                    {
                        "name": "claude-sonnet-4-5",
                        "context_limit": 200000,
                        "input_token_cost": 0.000001,
                        "output_token_cost": 0.000004
                    }
                ],
                "requires_auth": false
            }"#,
        )
        .unwrap();

        let used = usage(Some(10_000), Some(100), None);
        let cost = estimate_model_cost("priced_gateway", "claude-sonnet-4-5", &used).unwrap();
        let expected = (10_000.0 * 1.0 + 100.0 * 4.0) / 1_000_000.0;
        assert!((cost - expected).abs() < 1e-12);
    }

    #[test]
    fn non_usd_custom_tariff_does_not_fall_back_to_registry() {
        let temp_dir = tempfile::tempdir().unwrap();
        let temp_root = temp_dir.path().display().to_string();
        let _guard = env_lock::lock_env([("AEGIS_PATH_ROOT", Some(temp_root.as_str()))]);
        let dir = custom_providers_dir();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("priced_gateway.json"),
            r#"{
            "name": "priced_gateway",
            "engine": "openai",
            "display_name": "Gateway",
            "description": null,
            "api_key_env": "",
            "base_url": "https://example.invalid/v1",
            "models": [{
                "name": "claude-sonnet-4-5",
                "context_limit": 200000,
                "input_token_cost": 0.000001,
                "output_token_cost": 0.000004,
                "currency": "EUR"
            }],
            "requires_auth": false
        }"#,
        )
        .unwrap();
        let used = usage(Some(1_000), Some(100), None);
        assert!(resolve_pricing("priced_gateway", "claude-sonnet-4-5").is_none());
        assert!(estimate_model_cost("priced_gateway", "claude-sonnet-4-5", &used).is_none());
        let reported = ProviderUsage::new("claude-sonnet-4-5".to_string(), used)
            .with_cost(0.07, CostSource::ProviderReported);
        assert_eq!(
            resolve_usage_cost(Some("priced_gateway"), &reported),
            (Some(0.07), Some(CostSource::ProviderReported))
        );
    }

    #[test]
    fn declared_currency_is_rendered_as_a_symbol() {
        let mut info = ModelInfo::with_cost("m", 1_000, 0.000001, 0.000004);
        info.currency = Some("EUR".to_string());
        assert_eq!(display_currency(Some(&info)), "€");

        info.currency = Some("¥".to_string());
        assert_eq!(display_currency(Some(&info)), "¥");
    }

    #[test]
    fn missing_or_usd_currency_falls_back_to_the_dollar_symbol() {
        let mut info = ModelInfo::new("m").with_context_limit(1_000);
        assert_eq!(display_currency(Some(&info)), "$");
        assert_eq!(display_currency(None), "$");

        // Bundled definitions declare the ISO code, which clients would
        // otherwise print verbatim as "USD0.01".
        info.currency = Some("usd".to_string());
        assert_eq!(display_currency(Some(&info)), "$");
    }

    #[test]
    fn unpriced_everywhere_yields_none() {
        assert!(estimate_model_cost(
            "definitely-not-a-registry-provider",
            "nope-xqzj-model",
            &usage(Some(1), Some(1), None),
        )
        .is_none());
    }
}

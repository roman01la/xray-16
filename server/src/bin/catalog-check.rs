use anyhow::{Context, Result};
use zone_server::catalog::Catalog;
use zone_server::reload_timing::ReloadTimings;
fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let path = args
        .next()
        .context("usage: catalog-check CATALOG_JSON [RELOAD_TIMINGS_JSON]")?;
    let reload_timings = args.next();
    anyhow::ensure!(
        args.next().is_none(),
        "usage: catalog-check CATALOG_JSON [RELOAD_TIMINGS_JSON]"
    );
    let catalog = Catalog::load(std::path::Path::new(&path))?;
    zone_server::survival_rules::SurvivalRules::default().validate(&catalog)?;
    let mut items = 0;
    let mut failures = Vec::new();
    for name in catalog.item_names() {
        if let Err(error) = catalog
            .initial_state(name)
            .and_then(|state| catalog.weight(name, &state))
        {
            failures.push(format!("{name}: {error}"));
        }
        items += 1;
    }
    let mut report = serde_json::json!({
        "sha256":catalog.sha256, "sections":catalog.sections_len(), "items":items, "invalidInitialStates":failures
    });
    if let Some(path) = reload_timings {
        ReloadTimings::load(std::path::Path::new(&path), &catalog)?;
        report["reloadTimingsValidated"] = serde_json::json!(true);
    }
    println!("{report}");
    anyhow::ensure!(failures.is_empty(), "catalog item validation failed");
    Ok(())
}

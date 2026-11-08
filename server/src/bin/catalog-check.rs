use anyhow::{Context, Result};
use zone_server::catalog::Catalog;
fn main() -> Result<()> {
    let path = std::env::args()
        .nth(1)
        .context("usage: catalog-check CATALOG_JSON")?;
    let catalog = Catalog::load(std::path::Path::new(&path))?;
    zone_server::survival_rules::SurvivalRules::default().validate(&catalog)?;
    let mut items = 0;
    let mut failures = Vec::new();
    for name in catalog.item_names() {
        if let Err(error) = catalog.initial_state(name).and_then(|state|catalog.weight(name,&state)) {
            failures.push(format!("{name}: {error}"));
        }
        items += 1;
    }
    println!(
        "{}",
        serde_json::json!({"sha256":catalog.sha256,"sections":catalog.sections_len(),"items":items,"invalidInitialStates":failures})
    );
    anyhow::ensure!(failures.is_empty(), "catalog item validation failed");
    Ok(())
}

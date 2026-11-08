//! Disposable transport test provisioning. Never run against a live database.
use anyhow::{Context,Result,ensure};
use std::{path::Path,sync::Arc};
use zone_server::{catalog::Catalog,persistence::Database};
fn main()->Result<()> {
    let args:Vec<String>=std::env::args().skip(1).collect();
    ensure!(args.len()==4&&args[3]=="--allow-test-fixtures","usage: inventory-fixture NEW_DATABASE CATALOG_JSON OUTPUT_JSON --allow-test-fixtures");
    let database=Path::new(&args[0]);ensure!(!database.exists(),"fixture database must be new");
    let catalog=Arc::new(Catalog::load(Path::new(&args[1]))?);let mut db=Database::open(database)?;db.set_catalog(catalog.clone());
    let source=db.provision_world_container("synthetic-flat-v1",[0.0,0.0,1.0])?;
    let item=db.provision_inventory_item(&source,"wpn_ak74",&catalog.initial_state("wpn_ak74")?,"rucksack")?;
    let fixture=serde_json::json!({"source":source,"item":item,"revision":0,"catalog":catalog.sha256,"scope":"synthetic transport acceptance only; not authored loot"});
    std::fs::write(&args[2],serde_json::to_vec_pretty(&fixture)?).context("write fixture")?;
    println!("{}",fixture);Ok(())
}

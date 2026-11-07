use std::{path::PathBuf, time::Duration};
use zone_server::persistence::{Operation, Persistence};
fn path() -> PathBuf {
    std::env::temp_dir().join(format!(
        "zone-operations-{}-{}.sqlite",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}
#[tokio::test]
async fn worker_polling_flush_metrics_and_canonical_exclusion() {
    let path = path();
    let store = Persistence::start(&path).unwrap();
    let alias = path
        .parent()
        .unwrap()
        .join(".")
        .join(path.file_name().unwrap());
    assert!(Persistence::start(&alias).is_err());
    let credential = "a".repeat(64);
    let principal = store
        .execute(credential, Operation::Register)
        .await
        .unwrap()["principalId"]
        .as_str()
        .unwrap()
        .to_owned();
    store.flush().await.unwrap();
    assert_eq!(store.metrics()["completed"], 1);
    assert_eq!(store.metrics()["queued"], 0);
    let mut runtime = store.runtime();
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute("UPDATE principals SET revoked=1 WHERE id=?1", [principal])
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), runtime.changed())
        .await
        .unwrap()
        .unwrap();
    assert!(runtime.borrow().healthy);
    assert_eq!(runtime.borrow().auth_epoch, 1);
    drop(conn);
    drop(store);
    drop(runtime);
    // Worker releases its process lock after the last producer is dropped.
    let mut next = None;
    for _ in 0..30 {
        if let Ok(s) = Persistence::start(&path) {
            next = Some(s);
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(next.is_some());
    drop(next);
}

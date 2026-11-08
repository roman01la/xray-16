//! Cross-language control-wire acceptance fixture, not a server endpoint.
use serde_json::{Value, json};
use std::io::{self, Read};
fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();
    let packets: Vec<Vec<u8>> = serde_json::from_str(&input).unwrap();
    let commands: Vec<Value> = packets
        .iter()
        .map(|p| zone_server::control::decode_command(p).unwrap_or(Value::Null))
        .collect();
    let events = vec![
        json!({"type":"welcome","version":3,"contract":zone_server::contract::current(),"playerId":7,"principalId":"a".repeat(32),"tickHz":30,"safeZones":[{"x":-1.25,"z":2.0,"radius":10.5}]}),
        json!({"type":"ownership_dirty"}),
        json!({"type":"inventory_dirty"}),
        json!({"type":"vitals","state":[9,900,800,700,300,200,3,12345,50000,60000,1000]}),
        json!({"type":"weapon","state":{"ammo":29,"reserve":90,"reloadReadyTick":null}}),
        json!({"type":"lifecycle","revision":4294967295u32,"tick":100,"upsert":[{"id":7,"kind":1,"model":"stalker","persistentId":"b".repeat(32)}],"remove":[8,9]}),
        json!({"type":"action_result","sequence":1,"result":{"status":"hit","target":7,"damage":25,"killed":false}}),
        json!({"type":"action_result","sequence":2,"result":"unsupported_action"}),
        json!({"type":"action_result","sequence":3,"result":{"status":"respawned"}}),
        json!({"type":"action_result","sequence":4,"result":{"status":"rejected","reason":"cooldown"}}),
        json!({"type":"weapon_shot","sequence":5,"tick":100,"result":{"status":"blocked","ammo":6}}),
        json!({"type":"detonations","effects":[["wpn_fake_missile2",-15.5,3.25,7.0]]}),
    ];
    let encoded: Vec<Vec<u8>> = events
        .iter()
        .map(|e| zone_server::control::encode_event(e).unwrap())
        .collect();
    println!(
        "{}",
        json!({"commands":commands,"events":events,"encoded":encoded})
    );
}

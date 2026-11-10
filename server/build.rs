fn main() {
    let engine = "../src/xrGame";
    let wrapper = "src/xray_combat_rules.cpp";
    for file in ["ZoneConditionState.h", "ZoneConditionProtocol.h", "ZoneConditionImport.h", "ZoneConditionHit.h"] {
        println!("cargo:rerun-if-changed={engine}/{file}");
    }
    println!("cargo:rerun-if-changed=src/xray_condition.cpp");
    println!("cargo:rerun-if-changed={engine}/CombatRules.h");
    println!("cargo:rerun-if-changed={wrapper}");
    cc::Build::new()
        .cpp(true)
        .std("c++17")
        .include(engine)
        .file(wrapper)
        .file("src/xray_condition.cpp")
        .compile("xray_combat_rules");
    for directory in ["../src/Common", "../src/xrCommon", "../src/xrCore", "../src/Include/xrAPI", "../src/utils/xrMiscMath"] {
        println!("cargo:rerun-if-changed={directory}");
    }
    println!("cargo:rerun-if-changed=src/xray_collision.cpp");
    cc::Build::new()
        .cpp(true)
        .std("c++17")
        .define("NDEBUG", None)
        .define("XRAY_STATIC_BUILD", None)
        .include("../src")
        .include("../src/xrCore")
        .file("src/xray_collision.cpp")
        .file("../src/utils/xrMiscMath/vector.cpp")
        .compile("xray_collision");
}

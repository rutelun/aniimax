use aniimax::fast_layout::refine_json;
use serde_json::{json, Value};

#[test]
fn narrow_bay_reaches_exact_minimum_without_overlap() {
    let input = json!({
        "rectangles":[{"x":6,"y":0,"w":2,"h":2,"weight":1,"movable":true},{"x":0,"y":0,"w":2,"h":2}],
        "producer_count":1,"store_count":1,"cells":[{"x":0,"y":0,"w":8,"h":2}],
        "iterations":50000,"temperature":0.5,"penalty":30,"seed":1
    });
    let out: Value = serde_json::from_str(&refine_json(&input.to_string()).unwrap()).unwrap();
    assert!((out["cost"].as_f64().unwrap() - 2.0).abs() < 1e-8);
    let poses = out["poses"].as_array().unwrap();
    let x0 = poses[0][0].as_f64().unwrap();
    let x1 = poses[1][0].as_f64().unwrap();
    assert!((x0 - x1).abs() >= 2.0);
    assert!(x0 >= 0.0 && x0 <= 6.0 && x1 >= 0.0 && x1 <= 6.0);
}

#[test]
fn no_storage_is_a_safe_noop() {
    let input = json!({"rectangles":[{"x":0,"y":0,"w":2,"h":2,"weight":1}],"producer_count":1,"store_count":0,"cells":[{"x":0,"y":0,"w":8,"h":8}]});
    let out: Value = serde_json::from_str(&refine_json(&input.to_string()).unwrap()).unwrap();
    assert_eq!(out["poses"], json!([[0.0, 0.0, 2.0, 2.0]]));
}

#[test]
fn malformed_geometry_is_rejected_before_search() {
    let input = json!({"rectangles":[{"x":0,"y":0,"w":-2,"h":2}],"producer_count":1,"store_count":0,"cells":[{"x":0,"y":0,"w":8,"h":8}]});
    assert!(refine_json(&input.to_string()).is_err());
}

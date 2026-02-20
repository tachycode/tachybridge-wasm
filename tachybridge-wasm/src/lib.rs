use serde_json::{json, Value};
use wasm_bindgen::prelude::*;

fn from_js(value: JsValue) -> Result<Value, JsValue> {
    serde_wasm_bindgen::from_value(value)
        .map_err(|e| JsValue::from_str(&format!("invalid js value: {e}")))
}

fn to_js(value: Value) -> Result<JsValue, JsValue> {
    serde_wasm_bindgen::to_value(&value)
        .map_err(|e| JsValue::from_str(&format!("cannot encode value: {e}")))
}

#[wasm_bindgen]
pub fn build_subscribe(
    topic: String,
    msg_type: String,
    compression: Option<String>,
) -> Result<JsValue, JsValue> {
    to_js(json!({
        "op": "subscribe",
        "topic": topic,
        "type": msg_type,
        "compression": compression,
    }))
}

#[wasm_bindgen]
pub fn build_unsubscribe(topic: String) -> Result<JsValue, JsValue> {
    to_js(json!({
        "op": "unsubscribe",
        "topic": topic,
    }))
}

#[wasm_bindgen]
pub fn build_advertise(topic: String, msg_type: String) -> Result<JsValue, JsValue> {
    to_js(json!({
        "op": "advertise",
        "topic": topic,
        "type": msg_type,
    }))
}

#[wasm_bindgen]
pub fn build_publish(topic: String, msg: JsValue) -> Result<JsValue, JsValue> {
    let msg_value = from_js(msg)?;
    to_js(json!({
        "op": "publish",
        "topic": topic,
        "msg": msg_value,
    }))
}

#[wasm_bindgen]
pub fn build_call_service(
    service: String,
    srv_type: String,
    args: JsValue,
    id: Option<String>,
) -> Result<JsValue, JsValue> {
    let args_value = from_js(args)?;
    to_js(json!({
        "op": "call_service",
        "service": service,
        "type": srv_type,
        "args": args_value,
        "id": id,
    }))
}

#[wasm_bindgen]
pub fn build_send_action_goal(
    action: String,
    action_type: String,
    goal: JsValue,
    id: Option<String>,
    session_id: Option<String>,
) -> Result<JsValue, JsValue> {
    let goal_value = from_js(goal)?;
    to_js(json!({
        "op": "send_action_goal",
        "action": action,
        "action_type": action_type,
        "goal": goal_value,
        "id": id,
        "session_id": session_id,
    }))
}

#[wasm_bindgen]
pub fn build_cancel_action_goal(
    action: String,
    action_type: String,
    session_id: Option<String>,
) -> Result<JsValue, JsValue> {
    to_js(json!({
        "op": "cancel_action_goal",
        "action": action,
        "action_type": action_type,
        "session_id": session_id,
    }))
}

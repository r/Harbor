//! Access the on-device Apple model through the bundled Swift helper.

use super::{ChatCompletion, CompletionRequest, RpcError};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

pub const MODEL_ID: &str = "apple:system";

fn helper_path() -> Option<PathBuf> {
    if !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        return None;
    }
    Some(
        std::env::current_exe()
            .ok()?
            .parent()?
            .join("harbor-apple-model"),
    )
}

pub async fn is_available() -> bool {
    if super::get_config()
        .and_then(|config| {
            config
                .resolve_provider("apple")
                .map(|provider| !provider.enabled)
        })
        .unwrap_or(false)
    {
        return false;
    }
    let Some(path) = helper_path() else {
        return false;
    };
    helper_available(&path).await
}

async fn helper_available(path: &Path) -> bool {
    run_helper(path, "availability", None, Duration::from_secs(5))
        .await
        .is_ok_and(|output| output.trim() == "available")
}

pub async fn complete(request: CompletionRequest) -> Result<ChatCompletion, RpcError> {
    let path =
        helper_path().ok_or_else(|| model_error("Apple Intelligence requires an eligible Mac"))?;
    complete_with_helper(&path, request).await
}

async fn complete_with_helper(
    path: &Path,
    mut request: CompletionRequest,
) -> Result<ChatCompletion, RpcError> {
    if request.model != MODEL_ID {
        return Err(RpcError {
            code: -32602,
            message: format!("Unknown Apple Intelligence model: {}", request.model),
        });
    }
    // Credentials are irrelevant to the local provider and never enter its process.
    request.api_key = None;
    request.stream = None;
    for tool in request.tools.iter_mut().flatten() {
        apple_tool_parameters(&mut tool.function.parameters);
    }
    let input = serde_json::to_vec(&request).map_err(|error| model_error(error.to_string()))?;
    let output = run_helper(path, "chat", Some(input), Duration::from_secs(120)).await?;
    let response: ChatCompletion = serde_json::from_str(&output)
        .map_err(|error| model_error(format!("Invalid Apple Intelligence response: {}", error)))?;
    if response.choices.is_empty() || response.model != MODEL_ID {
        return Err(model_error("Invalid Apple Intelligence completion"));
    }
    Ok(response)
}

/// Keywords that describe a schema rather than constrain it. When a nullable
/// type becomes an `anyOf`, these stay on the outer schema.
const ANNOTATIONS: [&str; 4] = ["description", "title", "default", "examples"];

/// Rewrite a tool's input schema into the JSON Schema that Apple's
/// `GenerationSchema` reads, so one tool's schema can't fail the whole run.
///
/// Apple's decoder rejects `type` arrays, `oneOf` and an object schema without
/// `type`, and every `pattern` fails the model call, even when nested. Page
/// tools still validate their own input, so dropping `pattern` only loosens
/// what the model is told. A shape with no Apple equivalent, such as
/// `type: ["string", "number"]`, is left alone: the helper then leaves that
/// one tool out.
fn apple_tool_parameters(parameters: &mut serde_json::Value) {
    if !parameters.is_object() {
        *parameters = serde_json::json!({});
    }
    apple_schema(parameters);
    let map = parameters.as_object_mut().expect("parameters is an object");
    map.entry("type").or_insert_with(|| "object".into());
    if map.get("type").and_then(|t| t.as_str()) == Some("object") {
        map.entry("properties")
            .or_insert_with(|| serde_json::json!({}));
    }
}

fn apple_schema(schema: &mut serde_json::Value) {
    let serde_json::Value::Object(map) = schema else {
        return;
    };
    map.remove("pattern");
    if let Some(one_of) = map.remove("oneOf") {
        map.entry("anyOf").or_insert(one_of);
    }
    if let Some(serde_json::Value::Array(types)) = map.get("type").cloned() {
        let non_null: Vec<_> = types
            .iter()
            .filter(|t| t.as_str() != Some("null"))
            .cloned()
            .collect();
        match non_null.as_slice() {
            [only] if non_null.len() == types.len() => {
                map.insert("type".into(), only.clone());
            }
            [only] => {
                let mut variant = serde_json::Map::new();
                for (key, value) in std::mem::take(map) {
                    if ANNOTATIONS.contains(&key.as_str()) {
                        map.insert(key, value);
                    } else {
                        variant.insert(key, value);
                    }
                }
                variant.insert("type".into(), only.clone());
                map.insert(
                    "anyOf".into(),
                    serde_json::json!([variant, { "type": "null" }]),
                );
            }
            _ => {}
        }
    }
    if !map.contains_key("type") && map.contains_key("properties") {
        map.insert("type".into(), "object".into());
    }
    for key in ["properties", "$defs", "definitions"] {
        if let Some(serde_json::Value::Object(children)) = map.get_mut(key) {
            children.values_mut().for_each(apple_schema);
        }
    }
    for key in ["items", "additionalProperties", "not", "anyOf", "allOf"] {
        match map.get_mut(key) {
            Some(serde_json::Value::Array(children)) => children.iter_mut().for_each(apple_schema),
            Some(child) => apple_schema(child),
            None => {}
        }
    }
}

async fn run_helper(
    path: &Path,
    operation: &str,
    input: Option<Vec<u8>>,
    timeout: Duration,
) -> Result<String, RpcError> {
    let run = async {
        let mut child = Command::new(path)
            .arg(operation)
            .stdin(if input.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| {
                model_error(format!("Could not start Apple Intelligence: {}", error))
            })?;
        if let Some(input) = input {
            if let Some(mut stdin) = child.stdin.take() {
                stdin
                    .write_all(&input)
                    .await
                    .map_err(|error| model_error(error.to_string()))?;
            }
        }
        let output = child
            .wait_with_output()
            .await
            .map_err(|error| model_error(error.to_string()))?;
        if !output.status.success() {
            return Err(model_error(format!(
                "Apple Intelligence unavailable: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )));
        }
        // On success the helper only writes to stderr to say what it left
        // out, such as a tool whose schema Apple's model can't read.
        let notes = String::from_utf8_lossy(&output.stderr);
        for note in notes.lines().filter(|line| !line.trim().is_empty()) {
            tracing::warn!("Apple Intelligence: {}", note.trim());
        }
        String::from_utf8(output.stdout).map_err(|error| model_error(error.to_string()))
    };
    tokio::time::timeout(timeout, run)
        .await
        .map_err(|_| model_error("Apple Intelligence request timed out"))?
}

fn model_error(message: impl Into<String>) -> RpcError {
    RpcError {
        code: -32001,
        message: message.into(),
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct HelperFixture(PathBuf);

    impl HelperFixture {
        fn new(script: &str) -> Self {
            static NEXT_ID: AtomicU64 = AtomicU64::new(0);
            let directory = std::env::temp_dir().join(format!(
                "harbor-apple-helper-test-{}-{}",
                std::process::id(),
                NEXT_ID.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&directory).unwrap();
            let path = directory.join("helper");
            std::fs::write(&path, format!("#!/bin/sh\n{}\n", script)).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
            Self(path)
        }
    }

    impl Drop for HelperFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(self.0.parent().unwrap());
        }
    }

    #[tokio::test]
    async fn availability_requires_ready_output_and_success() {
        let ready = HelperFixture::new("printf available");
        assert!(helper_available(&ready.0).await);
        let unavailable = HelperFixture::new("printf 'unavailable: modelNotReady'");
        assert!(!helper_available(&unavailable.0).await);
        let failure = HelperFixture::new("printf available; exit 1");
        assert!(!helper_available(&failure.0).await);
        assert!(!helper_available(&ready.0.with_file_name("missing")).await);
    }

    #[tokio::test]
    async fn native_completion_keeps_conversation_and_tools_and_excludes_credentials() {
        let fixture = HelperFixture::new(
            r#"
if [ "$1" != "chat" ]; then exit 2; fi
cat > "$0.request"
printf '%s' '{"id":"apple-test","object":"chat.completion","created":0,"model":"apple:system","provider":"apple","choices":[{"index":0,"message":{"role":"assistant","content":null,"tool_calls":[{"id":"call_time","type":"function","function":{"name":"time_now","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}'
"#,
        );
        let request: CompletionRequest = serde_json::from_value(serde_json::json!({
            "model": MODEL_ID,
            "api_key": "must-stay-outside-native-request",
            "stream": true,
            "messages": [
                { "role": "system", "content": "Use the connected clock." },
                { "role": "user", "content": "What time is it?" },
                { "role": "assistant", "content": null, "tool_calls": [{ "id": "old_call", "type": "function", "function": { "name": "time_now", "arguments": "{}" } }] },
                { "role": "tool", "tool_call_id": "old_call", "content": "12:00" }
            ],
            "tools": [{ "type": "function", "function": { "name": "time_now", "parameters": { "type": "object", "properties": {} } } }]
        })).unwrap();
        let response = complete_with_helper(&fixture.0, request).await.unwrap();
        assert_eq!(
            response.choices[0].message.tool_calls.as_ref().unwrap()[0].id,
            "call_time"
        );
        let input: serde_json::Value =
            serde_json::from_slice(&std::fs::read(fixture.0.with_extension("request")).unwrap())
                .unwrap();
        assert!(input.get("api_key").is_none());
        assert!(input.get("stream").is_none());
        assert_eq!(input["messages"][0]["role"], "system");
        assert_eq!(input["messages"][3]["tool_call_id"], "old_call");
        assert_eq!(input["tools"][0]["function"]["name"], "time_now");
    }

    #[tokio::test]
    async fn tool_schemas_reach_the_helper_in_a_form_apple_can_read() {
        let fixture = HelperFixture::new(
            r#"
cat > "$0.request"
printf '%s' '{"id":"apple-test","object":"chat.completion","created":0,"model":"apple:system","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}'
"#,
        );
        // tale.fyi's `mark` page tool, as the page registers it.
        let mark = serde_json::json!({
            "type": "object",
            "properties": {
                "anchor": { "type": "string", "description": "A section or paragraph anchor id from this book." },
                "note": { "type": ["string", "null"], "maxLength": 4000, "description": "Markdown, stored and shared verbatim if set." },
                "dueDate": { "type": ["string", "null"], "pattern": "^\\d{4}-\\d{2}-\\d{2}$" },
                "label": { "type": ["string", "null"], "maxLength": 200 }
            },
            "required": ["anchor"],
            "additionalProperties": false
        });
        let request: CompletionRequest = serde_json::from_value(serde_json::json!({
            "model": MODEL_ID,
            "messages": [{ "role": "user", "content": "Mark this paragraph." }],
            "tools": [{ "type": "function", "function": { "name": "page:tale.fyi/mark", "parameters": mark } }]
        }))
        .unwrap();
        complete_with_helper(&fixture.0, request).await.unwrap();
        let input: serde_json::Value =
            serde_json::from_slice(&std::fs::read(fixture.0.with_extension("request")).unwrap())
                .unwrap();
        let sent = &input["tools"][0]["function"]["parameters"];
        assert_eq!(
            sent["properties"]["note"],
            serde_json::json!({
                "description": "Markdown, stored and shared verbatim if set.",
                "anyOf": [{ "type": "string", "maxLength": 4000 }, { "type": "null" }]
            })
        );
        assert_eq!(
            sent["properties"]["dueDate"],
            serde_json::json!({ "anyOf": [{ "type": "string" }, { "type": "null" }] })
        );
        assert_eq!(sent["properties"]["anchor"]["type"], "string");
        assert_eq!(sent["required"], serde_json::json!(["anchor"]));
        assert_eq!(sent["additionalProperties"], false);
    }

    fn apple(mut parameters: serde_json::Value) -> serde_json::Value {
        apple_tool_parameters(&mut parameters);
        parameters
    }

    #[test]
    fn schema_rewrites_cover_nesting_and_leave_what_apple_cannot_express() {
        use serde_json::json;
        // A single-type array is just that type.
        assert_eq!(
            apple(json!({ "type": "object", "properties": { "a": { "type": ["integer"] } } })),
            json!({ "type": "object", "properties": { "a": { "type": "integer" } } })
        );
        // Two real types have no Apple equivalent; the helper leaves the tool out.
        assert_eq!(
            apple(
                json!({ "type": "object", "properties": { "a": { "type": ["string", "number"] } } })
            ),
            json!({ "type": "object", "properties": { "a": { "type": ["string", "number"] } } })
        );
        // oneOf becomes anyOf, and its branches are rewritten too.
        assert_eq!(
            apple(
                json!({ "type": "object", "properties": { "a": { "oneOf": [{ "type": "string", "pattern": "x" }, { "type": "null" }] } } })
            ),
            json!({ "type": "object", "properties": { "a": { "anyOf": [{ "type": "string" }, { "type": "null" }] } } })
        );
        // pattern goes at any depth; a property named "pattern" stays.
        assert_eq!(
            apple(json!({ "type": "object", "properties": {
                "pattern": { "type": "string" },
                "tags": { "type": "array", "items": { "type": "string", "pattern": "^a$" } },
                "inner": { "properties": { "code": { "type": ["string", "null"], "pattern": "\\d" } } }
            } })),
            json!({ "type": "object", "properties": {
                "pattern": { "type": "string" },
                "tags": { "type": "array", "items": { "type": "string" } },
                "inner": { "type": "object", "properties": { "code": { "anyOf": [{ "type": "string" }, { "type": "null" }] } } }
            } })
        );
        // A tool with no schema, or one without type, still describes an object.
        assert_eq!(
            apple(serde_json::Value::Null),
            json!({ "type": "object", "properties": {} })
        );
        assert_eq!(
            apple(json!({})),
            json!({ "type": "object", "properties": {} })
        );
        // An already-readable schema is unchanged.
        let readable = json!({ "type": "object", "properties": { "city": { "type": "string", "maxLength": 80, "enum": ["Paris", "Rome"] } }, "required": ["city"] });
        assert_eq!(apple(readable.clone()), readable);
    }

    #[tokio::test]
    async fn helper_notes_on_stderr_do_not_fail_a_successful_call() {
        let fixture = HelperFixture::new("printf 'Left out tool x: reason' >&2; printf available");
        assert!(helper_available(&fixture.0).await);
    }

    #[tokio::test]
    async fn helper_errors_and_invalid_completions_propagate() {
        let request = CompletionRequest {
            model: MODEL_ID.to_string(),
            messages: vec![any_llm::Message::user("hello")],
            ..Default::default()
        };
        for script in ["cat >/dev/null; printf malformed", "cat >/dev/null; printf 'model is not ready' >&2; exit 1", "cat >/dev/null; printf '%s' '{\"id\":\"empty\",\"object\":\"chat.completion\",\"created\":0,\"model\":\"apple:system\",\"choices\":[]}'"] {
            let fixture = HelperFixture::new(script);
            assert_eq!(complete_with_helper(&fixture.0, request.clone()).await.unwrap_err().code, -32001);
        }
        let fixture = HelperFixture::new("sleep 1");
        assert!(
            run_helper(&fixture.0, "availability", None, Duration::from_millis(10))
                .await
                .unwrap_err()
                .message
                .contains("timed out")
        );
        let request = CompletionRequest {
            model: "apple:unknown".into(),
            ..request
        };
        assert_eq!(
            complete_with_helper(&fixture.0, request)
                .await
                .unwrap_err()
                .code,
            -32602
        );
    }
}

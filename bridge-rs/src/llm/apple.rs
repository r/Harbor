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
    let input = serde_json::to_vec(&request).map_err(|error| model_error(error.to_string()))?;
    let output = run_helper(path, "chat", Some(input), Duration::from_secs(120)).await?;
    let response: ChatCompletion = serde_json::from_str(&output)
        .map_err(|error| model_error(format!("Invalid Apple Intelligence response: {}", error)))?;
    if response.choices.is_empty() || response.model != MODEL_ID {
        return Err(model_error("Invalid Apple Intelligence completion"));
    }
    Ok(response)
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

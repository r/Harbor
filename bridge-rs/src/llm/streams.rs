//! Running `llm.chat_stream` tasks, so the extension can stop one.
//!
//! When a page stops reading a streaming prompt, the extension sends
//! `llm.cancel_stream { id }`. Aborting the task drops the in-flight
//! request to the model provider, so the model stops generating instead of
//! running to the end of a response nobody will read.

use crate::rpc::RpcError;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tokio::task::AbortHandle;

fn running() -> &'static Mutex<HashMap<String, AbortHandle>> {
    static RUNNING: OnceLock<Mutex<HashMap<String, AbortHandle>>> = OnceLock::new();
    RUNNING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The registry key for a stream's JSON-RPC id (a string or a number).
pub fn stream_key(id: &serde_json::Value) -> String {
    match id {
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// Remember a running stream task so `llm.cancel_stream` can stop it.
pub fn register(key: &str, handle: AbortHandle) {
    running().lock().unwrap().insert(key.to_string(), handle);
}

/// Forget a stream that has ended on its own.
pub fn finish(key: &str) {
    running().lock().unwrap().remove(key);
}

/// `llm.cancel_stream { id }` -> `{ cancelled }`. Stops the stream task with
/// that id, if it's still running. Cancelling a stream that has already
/// ended (or never existed) isn't an error: the caller just wants it gone.
pub async fn cancel_stream(params: serde_json::Value) -> Result<serde_json::Value, RpcError> {
    let id = params
        .get("id")
        .filter(|id| id.is_string() || id.is_number())
        .ok_or_else(|| RpcError::invalid_params("llm.cancel_stream needs the stream's id"))?;
    let handle = running().lock().unwrap().remove(&stream_key(id));
    let cancelled = match handle {
        Some(handle) => {
            handle.abort();
            true
        }
        None => false,
    };
    Ok(serde_json::json!({ "cancelled": cancelled }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::sync::mpsc;

    /// A stand-in for chat_stream: holds its sender until it's stopped.
    fn endless(tx: mpsc::Sender<()>) -> impl std::future::Future<Output = ()> + Send + 'static {
        async move {
            let _tx = tx;
            tokio::time::sleep(Duration::from_secs(3600)).await;
        }
    }

    async fn closed(rx: &mut mpsc::Receiver<()>) -> bool {
        matches!(
            tokio::time::timeout(Duration::from_secs(1), rx.recv()).await,
            Ok(None)
        )
    }

    #[tokio::test]
    async fn cancel_stream_aborts_a_running_stream_task() {
        let (tx, mut rx) = mpsc::channel::<()>(1);
        reserve("stream-1");
        assert!(spawn("stream-1", endless(tx)));

        let result = cancel_stream(serde_json::json!({ "id": "stream-1" }))
            .await
            .unwrap();
        assert_eq!(result, serde_json::json!({ "cancelled": true }));
        assert!(closed(&mut rx).await, "the stream task kept running");
    }

    #[tokio::test]
    async fn a_cancel_that_arrives_before_the_task_starts_still_stops_it() {
        // The bridge reserves the id in order as the request arrives; the
        // cancel can then be handled before the stream's own task spawns.
        let (tx, mut rx) = mpsc::channel::<()>(1);
        reserve("stream-early");
        let result = cancel_stream(serde_json::json!({ "id": "stream-early" }))
            .await
            .unwrap();
        assert_eq!(result, serde_json::json!({ "cancelled": true }));

        assert!(!spawn("stream-early", endless(tx)), "a cancelled stream was started");
        assert!(closed(&mut rx).await);
        finish("stream-early");
    }

    #[tokio::test]
    async fn cancel_stream_reports_an_unknown_or_finished_stream() {
        let (tx, _rx) = mpsc::channel::<()>(1);
        reserve("stream-2");
        assert!(spawn("stream-2", endless(tx)));
        finish("stream-2");
        let result = cancel_stream(serde_json::json!({ "id": "stream-2" }))
            .await
            .unwrap();
        assert_eq!(result, serde_json::json!({ "cancelled": false }));
        let unknown = cancel_stream(serde_json::json!({ "id": "nope" }))
            .await
            .unwrap();
        assert_eq!(unknown, serde_json::json!({ "cancelled": false }));
    }

    #[tokio::test]
    async fn cancel_stream_accepts_a_numeric_id() {
        let (tx, mut rx) = mpsc::channel::<()>(1);
        let key = stream_key(&serde_json::json!(42));
        reserve(&key);
        assert!(spawn(&key, endless(tx)));
        let result = cancel_stream(serde_json::json!({ "id": 42 })).await.unwrap();
        assert_eq!(result, serde_json::json!({ "cancelled": true }));
        assert!(closed(&mut rx).await);
    }

    #[tokio::test]
    async fn cancel_stream_requires_an_id() {
        let error = cancel_stream(serde_json::json!({})).await.unwrap_err();
        assert_eq!(error.code, -32602);
    }

    #[test]
    fn stream_key_matches_string_and_numeric_ids() {
        assert_eq!(stream_key(&serde_json::json!("abc")), "abc");
        assert_eq!(stream_key(&serde_json::json!(7)), "7");
    }

    #[tokio::test]
    async fn llm_cancel_stream_is_an_rpc_method() {
        let response = crate::rpc::handle(crate::rpc::RpcRequest {
            id: serde_json::json!(1),
            method: "llm.cancel_stream".to_string(),
            params: serde_json::json!({ "id": "not-running" }),
        })
        .await;
        assert!(
            response.error.is_none(),
            "llm.cancel_stream isn't registered"
        );
    }
}

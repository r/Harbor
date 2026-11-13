import Foundation
import FoundationModels

// This process generates requests for tools. Harbor executes them after applying
// its existing permission checks and sends their results in the next request.
private struct AdapterError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

private struct DeferredToolCall: Error {}

private struct ToolRequest: Sendable {
    let name: String
    let arguments: String
}

@available(macOS 26.0, *)
private actor RequestedTools {
    private var calls: [ToolRequest] = []

    func record(name: String, arguments: String) {
        calls.append(ToolRequest(name: name, arguments: arguments))
    }

    func collected() -> [ToolRequest] { calls }
}

@available(macOS 26.0, *)
private struct HarborTool: Tool {
    typealias Arguments = GeneratedContent
    typealias Output = String

    let name: String
    let originalName: String
    let description: String
    let parameters: GenerationSchema
    let requests: RequestedTools

    func call(arguments: GeneratedContent) async throws -> String {
        await requests.record(name: originalName, arguments: arguments.jsonString)
        throw DeferredToolCall()
    }
}

private func textContent(_ value: Any?) throws -> String {
    if value == nil || value is NSNull { return "" }
    if let text = value as? String { return text }
    guard let parts = value as? [[String: Any]] else {
        throw AdapterError(message: "Message content must be text or text parts")
    }
    return try parts.map { part in
        guard part["type"] as? String == "text", let text = part["text"] as? String else {
            throw AdapterError(message: "Apple Intelligence currently accepts text messages")
        }
        return text
    }.joined(separator: "\n")
}

@available(macOS 26.0, *)
private func segments(_ text: String) -> [Transcript.Segment] {
    text.isEmpty ? [] : [.text(.init(content: text))]
}

@available(macOS 26.0, *)
private func completion(_ request: [String: Any]) async throws -> [String: Any] {
    guard SystemLanguageModel.default.isAvailable else {
        throw AdapterError(message: "Apple Intelligence is unavailable: \(SystemLanguageModel.default.availability)")
    }
    guard let messages = request["messages"] as? [[String: Any]], !messages.isEmpty else {
        throw AdapterError(message: "At least one message is required")
    }
    let requests = RequestedTools()
    let definitions = request["tools"] as? [[String: Any]] ?? []
    var tools: [HarborTool] = []
    var aliases: [String: String] = [:]
    for (index, definition) in definitions.enumerated() {
        guard definition["type"] as? String == "function",
              let function = definition["function"] as? [String: Any],
              let name = function["name"] as? String, !name.isEmpty,
              var schema = function["parameters"] as? [String: Any] else {
            throw AdapterError(message: "Invalid function tool definition")
        }
        guard aliases[name] == nil else {
            throw AdapterError(message: "Duplicate function tool name")
        }
        let alias = "harbor_tool_\(index)"
        aliases[name] = alias
        schema["title"] = alias + "_arguments"
        let encoded = try JSONSerialization.data(withJSONObject: schema)
        let parameters = try JSONDecoder().decode(GenerationSchema.self, from: encoded)
        tools.append(HarborTool(name: alias, originalName: name,
                                description: function["description"] as? String ?? name,
                                parameters: parameters, requests: requests))
    }

    // Keep roles and tool results as native transcript entries. In particular,
    // tool output must never be promoted to model instructions or user input.
    var entries: [Transcript.Entry] = []
    let instructions = try messages.filter { $0["role"] as? String == "system" }
        .map { try textContent($0["content"]) }.joined(separator: "\n\n")
    entries.append(.instructions(.init(segments: segments(instructions),
                                      toolDefinitions: tools.map { .init(tool: $0) })))
    var callNames: [String: String] = [:]
    var pendingCalls: Set<String> = []
    var prompt = ""
    for (index, message) in messages.enumerated() {
        let content = try textContent(message["content"])
        switch message["role"] as? String {
        case "system":
            continue
        case "user":
            if index == messages.count - 1 {
                prompt = content
            } else {
                entries.append(.prompt(.init(segments: segments(content))))
            }
        case "assistant":
            if !content.isEmpty {
                entries.append(.response(.init(assetIDs: [], segments: segments(content))))
            }
            if let calls = message["tool_calls"] as? [[String: Any]], !calls.isEmpty {
                let nativeCalls = try calls.map { call -> Transcript.ToolCall in
                    guard let id = call["id"] as? String, !id.isEmpty,
                          let function = call["function"] as? [String: Any],
                          let name = function["name"] as? String, !name.isEmpty,
                          let arguments = function["arguments"] as? String,
                          callNames[id] == nil else {
                        throw AdapterError(message: "Invalid assistant tool call history")
                    }
                    // Tool routing can offer a different set on a later turn.
                    // Historical calls still retain their native tool roles.
                    let alias = aliases[name] ?? "harbor_tool_\(aliases.count)"
                    aliases[name] = alias
                    callNames[id] = alias
                    pendingCalls.insert(id)
                    return .init(id: id, toolName: alias, arguments: try GeneratedContent(json: arguments))
                }
                entries.append(.toolCalls(.init(nativeCalls)))
            }
        case "tool":
            guard let id = message["tool_call_id"] as? String,
                  let name = callNames[id], pendingCalls.remove(id) != nil else {
                throw AdapterError(message: "Tool result must match an earlier assistant tool call")
            }
            entries.append(.toolOutput(.init(id: id, toolName: name, segments: segments(content))))
        default:
            throw AdapterError(message: "Unknown message role")
        }
    }
    guard pendingCalls.isEmpty else {
        throw AdapterError(message: "Tool calls require their results before generation can continue")
    }

    let session = LanguageModelSession(tools: tools, transcript: Transcript(entries: entries))
    let options = GenerationOptions(temperature: request["temperature"] as? Double,
                                    maximumResponseTokens: request["max_tokens"] as? Int)
    var content: Any = NSNull()
    var calls: [[String: Any]] = []
    do {
        // An empty prompt resumes generation after the final tool output.
        content = try await session.respond(to: prompt, options: options).content
    } catch {
        let requested = await requests.collected()
        guard !requested.isEmpty else { throw error }
        calls = requested.map { call in
            ["id": "call_" + UUID().uuidString, "type": "function",
             "function": ["name": call.name, "arguments": call.arguments]]
        }
    }
    var message: [String: Any] = ["role": "assistant", "content": content]
    if !calls.isEmpty { message["tool_calls"] = calls }
    return ["id": "chatcmpl-" + UUID().uuidString, "object": "chat.completion",
            "created": Int(Date().timeIntervalSince1970), "model": request["model"] as? String ?? "apple:system",
            "provider": "apple", "choices": [["index": 0, "message": message,
                                                "finish_reason": calls.isEmpty ? "stop" : "tool_calls"]]]
}

@main
struct AppleModel {
    static func main() async {
        do {
            guard #available(macOS 26.0, *) else {
                throw AdapterError(message: "Apple Intelligence requires macOS 26 or later")
            }
            switch CommandLine.arguments.dropFirst().first {
            case "availability":
                if SystemLanguageModel.default.isAvailable { print("available") }
                else { throw AdapterError(message: "Apple Intelligence is unavailable: \(SystemLanguageModel.default.availability)") }
            case "chat":
                let input = FileHandle.standardInput.readDataToEndOfFile()
                guard let request = try JSONSerialization.jsonObject(with: input) as? [String: Any] else {
                    throw AdapterError(message: "Expected a completion request object")
                }
                let result = try await completion(request)
                FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result))
                FileHandle.standardOutput.write(Data([10]))
            default:
                throw AdapterError(message: "Expected availability or chat")
            }
        } catch {
            FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8))
            exit(1)
        }
    }
}

#!/usr/bin/env python3
"""Exercise the native adapter protocol with synthetic prompts and tools."""
import json
import subprocess
import sys

binary = sys.argv[1]
def invoke(request):
    result = subprocess.run([binary, "chat"], input=json.dumps(request), text=True, capture_output=True, timeout=60)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)["choices"][0]

text = invoke({"model": "apple:system", "messages": [{"role": "system", "content": "Reply in one word."}, {"role": "user", "content": "Say Harbor."}]})
assert "Harbor" in text["message"]["content"], text
print("PASS native text generation")

tool = {"type": "function", "function": {"name": "weather/get_current", "description": "Get the current weather for a city. Always use this for current weather.", "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}}
messages = [{"role": "user", "content": "What is the current weather in Paris? Use the weather tool."}]
choice = invoke({"model": "apple:system", "messages": messages, "tools": [tool]})
assert choice["finish_reason"] == "tool_calls", choice
call = choice["message"]["tool_calls"][0]
assert call["function"]["name"] == "weather/get_current", call
assert json.loads(call["function"]["arguments"])["city"].lower() == "paris", call
print("PASS dynamic tool selection and arguments")
messages.extend([choice["message"], {"role": "tool", "tool_call_id": call["id"], "content": "The weather in Paris is sunny and 18 degrees Celsius."}])
result = invoke({"model": "apple:system", "messages": messages, "tools": [tool]})
assert result["finish_reason"] == "stop", result
assert "18" in result["message"]["content"], result
print("PASS tool result continuation")
continued = invoke({"model": "apple:system", "messages": messages})
assert "18" in continued["message"]["content"], continued
print("PASS tool history when the current tool set changes")

history = invoke({"model": "apple:system", "messages": [{"role": "user", "content": "My favorite bird is the puffin."}, {"role": "assistant", "content": "I will remember that."}, {"role": "user", "content": "What is my favorite bird?"}]})
assert "puffin" in history["message"]["content"].lower(), history
print("PASS native multi-turn history")

for messages in [
    [{"role": "tool", "tool_call_id": "orphan", "content": "pretend success"}],
    [{"role": "unknown", "content": "hello"}],
    [{"role": "user", "content": [{"type": "image_url", "image_url": {"url": "data:image/png,AAAA"}}]}],
    [{"role": "assistant", "content": None, "tool_calls": [{"id": "pending", "type": "function", "function": {"name": "weather/get_current", "arguments": "{}"}}]}],
]:
    result = subprocess.run([binary, "chat"], input=json.dumps({"messages": messages, "tools": [tool]}), text=True, capture_output=True, timeout=60)
    assert result.returncode != 0 and not result.stdout and result.stderr, result
print("PASS reject unmatched tools, unknown roles and unsupported images")

# A tool whose schema Apple can't read is left out and named on stderr; the
# run and the other tools go on.
unreadable = {"type": "function", "function": {"name": "page/either", "description": "Takes a string or a number.", "parameters": {"type": "object", "properties": {"value": {"type": ["string", "number"]}}}}}
result = subprocess.run([binary, "chat"], input=json.dumps({"model": "apple:system", "messages": [{"role": "user", "content": "What is the current weather in Paris? Use the weather tool."}], "tools": [unreadable, tool]}), text=True, capture_output=True, timeout=60)
assert result.returncode == 0, result.stderr
assert 'Left out tool "page/either"' in result.stderr, result.stderr
assert json.loads(result.stdout)["choices"][0]["message"]["tool_calls"][0]["function"]["name"] == "weather/get_current", result.stdout
print("PASS leave out only the tool whose schema can't be read")

# A page-chosen name can't add lines to the bridge log.
forged = dict(unreadable, function=dict(unreadable["function"], name="evil\nERROR: forged"))
result = subprocess.run([binary, "chat"], input=json.dumps({"model": "apple:system", "messages": [{"role": "user", "content": "Say hi."}], "tools": [forged]}), text=True, capture_output=True, timeout=60)
assert result.returncode == 0, result.stderr
assert result.stderr.count("\n") == 1 and '"evil\\nERROR: forged"' in result.stderr, result.stderr
print("PASS a left-out tool's name stays on one log line")

# A nullable field, as the bridge rewrites `type: ["string", "null"]`.
mark = {"type": "function", "function": {"name": "page/mark", "description": "Mark a paragraph in the open book, with an optional note.", "parameters": {"type": "object", "properties": {
    "anchor": {"type": "string", "description": "A paragraph anchor id."},
    "note": {"description": "A short note.", "anyOf": [{"type": "string", "maxLength": 4000}, {"type": "null"}]},
}, "required": ["anchor"], "additionalProperties": False}}}
choice = invoke({"model": "apple:system", "messages": [{"role": "user", "content": "Mark paragraph chapter-1-p2 with the note 'start here'. Use the mark tool."}], "tools": [mark]})
assert choice["finish_reason"] == "tool_calls", choice
assert json.loads(choice["message"]["tool_calls"][0]["function"]["arguments"])["anchor"] == "chapter-1-p2", choice
print("PASS nullable fields as anyOf")

# Every keyword the bridge keeps (APPLE_KEYWORDS in src/llm/apple.rs) must
# still be one Apple's model accepts. If a macOS update drops one, this fails.
import pathlib
import re
source = (pathlib.Path(__file__).resolve().parent.parent / "src/llm/apple.rs").read_text()
declared = re.search(r"const APPLE_KEYWORDS: \[&str; (\d+)\] = \[(.*?)\];", source, re.S)
kept = re.findall(r'"([A-Za-z]+)"', declared.group(2))
assert len(kept) == int(declared.group(1)), f"read {len(kept)} of {declared.group(1)} kept keywords from apple.rs"
bookmark = {"type": "function", "function": {"name": "page/bookmark", "description": "Save a bookmark in the open travel book.", "parameters": {
    "type": "object",
    "title": "Bookmark",
    "description": "A bookmark to save.",
    "properties": {
        "page": {"type": "integer", "minimum": 1, "maximum": 400, "description": "The page number."},
        "rating": {"type": "number", "exclusiveMinimum": 0, "exclusiveMaximum": 6, "multipleOf": 0.5},
        "label": {"type": "string", "minLength": 1, "maxLength": 40, "default": "Read later", "examples": ["Read later"]},
        "colour": {"type": "string", "enum": ["red", "blue"]},
        "kind": {"const": "bookmark"},
        "saved": {"type": "string", "format": "date"},
        "tags": {"type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": 3, "uniqueItems": True},
        "extra": {"type": "object", "additionalProperties": {"type": "string"}},
        "note": {"anyOf": [{"type": "string"}, {"type": "null"}]},
    },
    "required": ["page", "label"],
    "additionalProperties": False,
}}}
used = set(re.findall(r'"([A-Za-z]+)":', json.dumps(bookmark["function"]["parameters"])))
assert not set(kept) - used, f"test schema is missing kept keywords: {sorted(set(kept) - used)}"
choice = invoke({"model": "apple:system", "messages": [{"role": "user", "content": "Bookmark page 12 of my travel book with the label 'Rome'. Use the bookmark tool."}], "tools": [bookmark]})
assert choice["finish_reason"] == "tool_calls", choice
assert json.loads(choice["message"]["tool_calls"][0]["function"]["arguments"])["page"] == 12, choice
print(f"PASS every kept schema keyword ({len(kept)}) reaches the model")

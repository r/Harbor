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

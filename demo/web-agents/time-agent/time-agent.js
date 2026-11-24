const output = document.getElementById('output');
const button = document.getElementById('call');

button.addEventListener('click', async () => {
  button.disabled = true;
  output.textContent = 'Calling time.now...';
  try {
    if (!window.agent?.requestPermissions) throw new Error('Load Harbor to use this demo.');
    const tool = 'time-wasm/time.now';
    const permission = await window.agent.requestPermissions({
      scopes: ['mcp:tools.call'],
      tools: [tool],
      reason: 'Call the built-in time tool to show the current UTC time.',
    });
    if (!permission.granted) throw new Error('Permission denied. Allow the time tool to continue.');
    const result = await window.agent.tools.call({ tool, args: {} });
    output.textContent = JSON.stringify(result, null, 2);
  } catch (error) {
    output.textContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    button.disabled = false;
  }
});

import { spawn } from "node:child_process";
import { once } from "node:events";
import { connectA2aClient } from "@a2a-workbench/client";

const python = process.env.A2A_PYTHON ?? "python3";
const fixture = new URL("../conformance/interop/python_agent.py", import.meta.url);
const results = [];

for (const [binding, port] of [["JSONRPC", 18121], ["HTTP+JSON", 18122]]) {
  results.push(await runBinding(binding, port));
}

console.log(JSON.stringify({
  label: "A2A v1 client conformance — spec/TCK-derived",
  fixture: "a2a-sdk[http-server]==1.1.0",
  results,
}, null, 2));

async function runBinding(binding, port) {
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(python, [fixture.pathname, "--port", String(port), "--binding", binding], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostics = "";
  child.stdout.on("data", (chunk) => { diagnostics += chunk.toString(); });
  child.stderr.on("data", (chunk) => { diagnostics += chunk.toString(); });
  try {
    await waitForCard(origin, child, () => diagnostics);
    const client = await connectA2aClient({ agentUrl: origin, allowLocalhost: true });
    if (client.connection.selectedInterface.protocolBinding !== binding) {
      throw new Error(`selected ${client.connection.selectedInterface.protocolBinding}; expected ${binding}`);
    }
    const sent = await client.sendMessage(messageRequest(`${binding}-send`));
    const taskId = "id" in sent && typeof sent.id === "string" ? sent.id : undefined;
    if (!taskId) throw new Error(`${binding} SendMessage did not return a Task`);
    const fetched = await client.getTask({ id: taskId });
    if (fetched.id !== taskId) throw new Error(`${binding} GetTask correlation failed`);
    const listed = await client.listTasks({ pageSize: 10 });
    if (!listed.tasks.some((task) => task.id === taskId)) throw new Error(`${binding} ListTasks omitted the task`);
    const stream = [];
    for await (const event of client.sendStreamingMessage(messageRequest(`${binding}-stream`))) {
      stream.push(event);
    }
    if (stream.length === 0) throw new Error(`${binding} streaming returned no events`);
    return { binding, status: "passed", operations: ["discover", "send", "stream", "get", "list"] };
  } finally {
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 2_000))]);
  }
}

function messageRequest(messageId) {
  return {
    message: {
      messageId,
      role: "ROLE_USER",
      parts: [{ text: "Cross-language interoperability check" }],
    },
    configuration: { acceptedOutputModes: ["text/plain"] },
  };
}

async function waitForCard(origin, child, diagnostics) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Python fixture exited with ${child.exitCode}: ${diagnostics()}`);
    }
    try {
      const response = await fetch(`${origin}/.well-known/agent-card.json`, {
        headers: { "A2A-Version": "1.0" },
      });
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for Python fixture: ${diagnostics()}`);
}

import { connectLegacyClient } from "@a2a-workbench/client/compat";

const client = await connectLegacyClient({
  mode: "direct",
  endpoint: "https://legacy-agent.example.com/a2a",
  binding: "HTTP+JSON",
});

await client.sendMessage({
  message: {
    messageId: crypto.randomUUID(),
    role: "ROLE_USER",
    parts: [{ text: "Explicit compatibility request" }],
  },
});

console.log(client.connection.mode, client.connection.protocolVersion);

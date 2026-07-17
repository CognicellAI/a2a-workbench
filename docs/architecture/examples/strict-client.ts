import {
  MemoryAgentCardCache,
  connectA2aClient,
  createStaticCredentialProvider,
  type EvidenceEvent,
  type SendMessageRequest,
} from "@a2a-workbench/client";

const evidence: EvidenceEvent[] = [];
const client = await connectA2aClient({
  agentUrl: "https://agent.example.com",
  cache: new MemoryAgentCardCache(),
  requestedExtensions: ["https://a2ui.org/a2a-extension/a2ui/v0.9"],
  credentialProvider: createStaticCredentialProvider({
    agentBearer: { type: "bearer", token: "injected-at-runtime" },
  }),
  evidenceSink: {
    emit(event) {
      evidence.push(event);
    },
  },
});

const request: SendMessageRequest = {
  message: {
    messageId: crypto.randomUUID(),
    role: "ROLE_USER",
    parts: [{ text: "Hello" }],
  },
  configuration: { acceptedOutputModes: ["text/plain"] },
};

await client.sendMessage(request);
for await (const event of client.sendStreamingMessage(request)) {
  console.log(event);
}
await client.getTask({ id: "task-id" });
await client.listTasks({ pageSize: 25 });
await client.cancelTask({ id: "task-id" });
for await (const event of client.subscribeToTask({ id: "task-id" })) {
  console.log(event);
}
await client.getExtendedAgentCard();
await client.refreshAgentCard();

console.log(client.connection, client.getAgentCard(), evidence);

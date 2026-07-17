"""Deterministic A2A v1 server fixture backed by the official Python SDK."""

from __future__ import annotations

import argparse

import uvicorn
from starlette.applications import Starlette

from a2a.server.agent_execution.agent_executor import AgentExecutor
from a2a.server.agent_execution.context import RequestContext
from a2a.server.events.event_queue import EventQueue
from a2a.server.request_handlers import DefaultRequestHandler
from a2a.server.routes import (
    create_agent_card_routes,
    create_jsonrpc_routes,
    create_rest_routes,
)
from a2a.server.tasks.inmemory_task_store import InMemoryTaskStore
from a2a.server.tasks.task_updater import TaskUpdater
from a2a.types import (
    AgentCapabilities,
    AgentCard,
    AgentInterface,
    AgentSkill,
    Part,
    Task,
    TaskState,
    TaskStatus,
)


class InteropAgentExecutor(AgentExecutor):
    """Completes each request with one deterministic agent message."""

    async def execute(self, context: RequestContext, event_queue: EventQueue) -> None:
        if context.task_id is None or context.context_id is None:
            return
        updater = TaskUpdater(event_queue, context.task_id, context.context_id)
        await event_queue.enqueue_event(
            Task(
                id=context.task_id,
                context_id=context.context_id,
                status=TaskStatus(state=TaskState.TASK_STATE_SUBMITTED),
            )
        )
        await updater.start_work()
        await updater.complete(
            updater.new_agent_message([Part(text="Hello from the pinned Python A2A fixture")])
        )

    async def cancel(self, context: RequestContext, event_queue: EventQueue) -> None:
        if context.task_id is None or context.context_id is None:
            return
        updater = TaskUpdater(event_queue, context.task_id, context.context_id)
        await updater.cancel()


def build_app(host: str, port: int, binding: str):
    endpoint = f"http://{host}:{port}"
    rpc_path = "/a2a" if binding == "HTTP+JSON" else "/rpc"
    card = AgentCard(
        name="Pinned Python A2A v1 interop fixture",
        description="Independent cross-language fixture for @a2a-workbench/client",
        version="1.0.0",
        supported_interfaces=[
            AgentInterface(
                url=f"{endpoint}{rpc_path}",
                protocol_binding=binding,
                protocol_version="1.0",
            )
        ],
        capabilities=AgentCapabilities(streaming=True, push_notifications=False),
        default_input_modes=["text/plain"],
        default_output_modes=["text/plain"],
        skills=[
            AgentSkill(
                id="interop",
                name="Interop echo",
                description="Completes deterministic A2A tasks",
                tags=["interop"],
            )
        ],
    )
    handler = DefaultRequestHandler(
        agent_executor=InteropAgentExecutor(),
        task_store=InMemoryTaskStore(),
        agent_card=card,
    )
    routes = create_agent_card_routes(card)
    if binding == "HTTP+JSON":
        routes.extend(create_rest_routes(handler, path_prefix=rpc_path))
    else:
        routes.extend(create_jsonrpc_routes(handler, rpc_url=rpc_path))
    return Starlette(routes=routes)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--binding", choices=["JSONRPC", "HTTP+JSON"], required=True)
    args = parser.parse_args()
    uvicorn.run(build_app(args.host, args.port, args.binding), host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()

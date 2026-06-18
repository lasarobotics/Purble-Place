"""Lightweight realtime layer.

Locally this is a plain WebSocket fan-out (the SignalR stand-in described in
the proposal).  On Azure Container Apps WebSockets work the same way, so the
client code is unchanged; swapping in Azure SignalR later only touches this
file.
"""
from __future__ import annotations

import asyncio
import json
from typing import Any

from fastapi import WebSocket


class Hub:
    def __init__(self) -> None:
        self._clients: set[WebSocket] = set()
        self._lock = asyncio.Lock()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        async with self._lock:
            self._clients.add(ws)

    async def disconnect(self, ws: WebSocket) -> None:
        async with self._lock:
            self._clients.discard(ws)

    async def broadcast(self, event: str, payload: Any = None) -> None:
        message = json.dumps({"event": event, "payload": payload})
        async with self._lock:
            targets = list(self._clients)
        dead: list[WebSocket] = []
        for ws in targets:
            try:
                await ws.send_text(message)
            except Exception:
                dead.append(ws)
        if dead:
            async with self._lock:
                for ws in dead:
                    self._clients.discard(ws)


hub = Hub()


def emit(event: str, payload: Any = None) -> None:
    """Fire-and-forget broadcast usable from sync request handlers."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    loop.create_task(hub.broadcast(event, payload))

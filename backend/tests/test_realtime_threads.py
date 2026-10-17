"""Realtime events must leave synchronous FastAPI worker threads immediately."""
import asyncio
import threading

from app.realtime import Hub


class FakeWebSocket:
    def __init__(self):
        self.messages: list[str] = []

    async def accept(self):
        return None

    async def send_text(self, message: str):
        self.messages.append(message)


def test_worker_thread_publish_reaches_connected_clients():
    async def scenario():
        hub = Hub()
        socket = FakeWebSocket()
        await hub.connect(socket)  # captures this running server loop

        worker = threading.Thread(
            target=hub.publish,
            args=("picklist_changed", {"version": 7}),
        )
        worker.start()
        worker.join()

        for _ in range(20):
            if socket.messages:
                break
            await asyncio.sleep(0.005)

        await hub.disconnect(socket)
        assert len(socket.messages) == 1
        assert '"picklist_changed"' in socket.messages[0]
        assert '"version": 7' in socket.messages[0]

    asyncio.run(scenario())

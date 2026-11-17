"""Server HTTP multithread + SSE in tempo reale per Monopoly Pay & Real Estate."""

from __future__ import annotations

import json
import mimetypes
import os
import queue
import socket
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import monopoly_engine as engine

BASE_DIR = Path(__file__).resolve().parent
PUBLIC_DIR = BASE_DIR / "public"
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)


def get_lan_ip() -> str:
    """Rileva l'IP locale sulla rete Wi-Fi per i QR Code di invito."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


class RoomStore:
    """Archivio thread-safe delle stanze con persistenza JSON e notifiche SSE."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._rooms: Dict[str, Dict[str, Any]] = {}
        self._subscribers: Dict[str, List[queue.Queue]] = {}
        self._load_existing()

    def _load_existing(self) -> None:
        for path in DATA_DIR.glob("*.json"):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                code = data.get("code")
                if code:
                    self._rooms[code.upper()] = data
            except Exception:
                pass

    def _save(self, room: Dict[str, Any]) -> None:
        code = room["code"].upper()
        path = DATA_DIR / f"{code}.json"
        path.write_text(json.dumps(room, ensure_ascii=False, indent=2), encoding="utf-8")

    def _broadcast(self, room: Dict[str, Any]) -> None:
        code = room["code"].upper()
        payload = json.dumps(room, ensure_ascii=False)
        subs = self._subscribers.get(code, [])
        dead: List[queue.Queue] = []
        for q in subs:
            try:
                q.put_nowait(payload)
            except Exception:
                dead.append(q)
        for q in dead:
            if q in subs:
                subs.remove(q)

    def subscribe(self, code: str) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=50)
        with self._lock:
            self._subscribers.setdefault(code.upper(), []).append(q)
        return q

    def unsubscribe(self, code: str, q: queue.Queue) -> None:
        with self._lock:
            subs = self._subscribers.get(code.upper(), [])
            if q in subs:
                subs.remove(q)

    def create_room(self, body: Dict[str, Any]) -> Dict[str, Any]:
        with self._lock:
            room, banker_id = engine.create_room_state(
                banker_name=body.get("bankerName", ""),
                banker_token=body.get("token", "cilindro"),
                banker_color=body.get("color", "#0A84FF"),
                currency=body.get("currency", "€"),
                starting_balance=int(body.get("startingBalance", 1500)),
                free_parking_enabled=bool(body.get("freeParkingEnabled", False)),
                custom_deck=body.get("customDeck"),
            )
            while room["code"] in self._rooms:
                room["code"] = engine.generate_room_code()
            self._rooms[room["code"]] = room
            self._save(room)
            return {"room": room, "playerId": banker_id}

    def get_room(self, code: str) -> Dict[str, Any]:
        with self._lock:
            room = self._rooms.get(code.upper())
            if not room:
                raise engine.RuleViolationError(f"Stanza {code.upper()} non trovata.", code="NOT_FOUND")
            return room

    def mutate(self, code: str, fn) -> Dict[str, Any]:
        with self._lock:
            room = self.get_room(code)
            result = fn(room)
            self._save(room)
            self._broadcast(room)
            return {"room": room, "result": result}


STORE = RoomStore()


class MonopolyHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:
        # Log compatto
        pass

    def _send_json(self, status: int, data: Any) -> None:
        raw = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def _read_json(self) -> Dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def _handle_error(self, err: Exception) -> None:
        if isinstance(err, engine.RuleViolationError):
            status = 400
            if err.code == "NOT_FOUND":
                status = 404
            elif err.code == "FORBIDDEN":
                status = 403
            elif err.code == "INSUFFICIENT_FUNDS":
                status = 409
            self._send_json(
                status,
                {"error": err.message, "code": err.code, "extra": err.extra},
            )
        else:
            self._send_json(500, {"error": str(err), "code": "INTERNAL_ERROR"})

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/health":
            self._send_json(200, {"status": "ok"})
            return

        if path == "/api/server-info":
            port = self.server.server_address[1]
            self._send_json(200, {"lanIp": get_lan_ip(), "port": port})
            return

        if path.startswith("/api/rooms/"):
            parts = [p for p in path.split("/") if p]
            # /api/rooms/<code>
            if len(parts) == 3:
                code = parts[2]
                try:
                    room = STORE.get_room(code)
                    self._send_json(200, {"room": room})
                except Exception as e:
                    self._handle_error(e)
                return

            # /api/rooms/<code>/stream
            if len(parts) == 4 and parts[3] == "stream":
                code = parts[2]
                try:
                    room = STORE.get_room(code)
                except Exception as e:
                    self._handle_error(e)
                    return

                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "text/event-stream; charset=utf-8")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "keep-alive")
                self.send_header("X-Accel-Buffering", "no")
                self.end_headers()

                q = STORE.subscribe(code)
                try:
                    initial = json.dumps(room, ensure_ascii=False)
                    self.wfile.write(f"data: {initial}\n\n".encode("utf-8"))
                    self.wfile.flush()

                    while True:
                        try:
                            payload = q.get(timeout=15)
                            self.wfile.write(f"data: {payload}\n\n".encode("utf-8"))
                            self.wfile.flush()
                        except queue.Empty:
                            self.wfile.write(b": keepalive\n\n")
                            self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, OSError):
                    pass
                finally:
                    STORE.unsubscribe(code, q)
                return

        self._serve_static(path)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            body = self._read_json()

            if path == "/api/rooms":
                res = STORE.create_room(body)
                self._send_json(201, res)
                return

            parts = [p for p in path.split("/") if p]
            if len(parts) >= 4 and parts[0] == "api" and parts[1] == "rooms":
                code = parts[2]
                action = "/".join(parts[3:])

                if action == "join":
                    out = STORE.mutate(
                        code,
                        lambda r: engine.join_room(
                            r,
                            body.get("name", ""),
                            body.get("token", "cane"),
                            body.get("color", "#30D158"),
                        ),
                    )
                    self._send_json(200, {"room": out["room"], "playerId": out["result"]})
                    return

                if action == "settings":
                    out = STORE.mutate(
                        code,
                        lambda r: engine.update_room_settings(
                            r, body.get("actorId", ""), body.get("freeParkingEnabled")
                        ),
                    )
                    self._send_json(200, out)
                    return

                if action == "deck":
                    out = STORE.mutate(
                        code,
                        lambda r: engine.update_deck(r, body.get("actorId", ""), body.get("deck", [])),
                    )
                    self._send_json(200, out)
                    return

                if action == "transfer":
                    out = STORE.mutate(
                        code,
                        lambda r: engine.transfer_funds(
                            r,
                            body.get("actorId", ""),
                            body.get("fromId", ""),
                            body.get("toId", ""),
                            int(body.get("amount", 0)),
                            body.get("reason", "Trasferimento"),
                            bool(body.get("isTaxOrFine", False)),
                        ),
                    )
                    self._send_json(200, out)
                    return

                if action == "free-parking/claim":
                    out = STORE.mutate(
                        code,
                        lambda r: engine.claim_free_parking(
                            r, body.get("actorId", ""), body.get("toPlayerId", "")
                        ),
                    )
                    self._send_json(200, out)
                    return

                if action == "properties/buy":
                    out = STORE.mutate(
                        code,
                        lambda r: engine.buy_property(r, body.get("actorId", ""), body.get("propertyId", "")),
                    )
                    self._send_json(200, out)
                    return

                if action == "rent/calculate":
                    room = STORE.get_room(code)
                    dice = body.get("diceRoll")
                    res = engine.calculate_rent(
                        room, body.get("propertyId", ""), int(dice) if dice is not None else None
                    )
                    self._send_json(200, res)
                    return

                if action == "rent/request":
                    dice = body.get("diceRoll")
                    out = STORE.mutate(
                        code,
                        lambda r: engine.request_rent(
                            r,
                            body.get("actorId", ""),
                            body.get("propertyId", ""),
                            body.get("debtorId", ""),
                            int(dice) if dice is not None else None,
                        ),
                    )
                    self._send_json(200, out)
                    return

                if action == "rent/respond":
                    out = STORE.mutate(
                        code,
                        lambda r: engine.respond_rent(
                            r, body.get("actorId", ""), body.get("requestId", ""), bool(body.get("accept", True))
                        ),
                    )
                    self._send_json(200, out)
                    return

                if action == "build/request":
                    out = STORE.mutate(
                        code,
                        lambda r: engine.request_build(
                            r, body.get("actorId", ""), body.get("propertyId", ""), body.get("action", "build")
                        ),
                    )
                    self._send_json(200, out)
                    return

                if action == "build/approve":
                    out = STORE.mutate(
                        code,
                        lambda r: engine.approve_build(
                            r, body.get("actorId", ""), body.get("requestId", ""), bool(body.get("approve", True))
                        ),
                    )
                    self._send_json(200, out)
                    return

                if action == "mortgage/request":
                    out = STORE.mutate(
                        code,
                        lambda r: engine.request_mortgage(
                            r, body.get("actorId", ""), body.get("propertyId", ""), body.get("action", "mortgage")
                        ),
                    )
                    self._send_json(200, out)
                    return

                if action == "mortgage/approve":
                    out = STORE.mutate(
                        code,
                        lambda r: engine.approve_mortgage(
                            r, body.get("actorId", ""), body.get("requestId", ""), bool(body.get("approve", True))
                        ),
                    )
                    self._send_json(200, out)
                    return

                if action == "trade/create":
                    out = STORE.mutate(
                        code,
                        lambda r: engine.create_trade(
                            r,
                            body.get("actorId", ""),
                            body.get("toPlayerId", ""),
                            body.get("offerProperties", []),
                            int(body.get("offerCash", 0)),
                            body.get("requestProperties", []),
                            int(body.get("requestCash", 0)),
                        ),
                    )
                    self._send_json(200, out)
                    return

                if action == "trade/respond":
                    out = STORE.mutate(
                        code,
                        lambda r: engine.respond_trade(
                            r, body.get("actorId", ""), body.get("requestId", ""), bool(body.get("accept", True))
                        ),
                    )
                    self._send_json(200, out)
                    return

                if action == "trade/approve":
                    out = STORE.mutate(
                        code,
                        lambda r: engine.approve_trade(
                            r, body.get("actorId", ""), body.get("requestId", ""), bool(body.get("approve", True))
                        ),
                    )
                    self._send_json(200, out)
                    return

                if action == "bankruptcy":
                    out = STORE.mutate(
                        code,
                        lambda r: engine.declare_bankruptcy(
                            r, body.get("actorId", ""), body.get("creditorId", "BANK")
                        ),
                    )
                    self._send_json(200, out)
                    return

            self._send_json(404, {"error": "Endpoint non trovato."})
        except Exception as e:
            self._handle_error(e)

    def _serve_static(self, req_path: str) -> None:
        rel = "index.html" if req_path == "/" else req_path.lstrip("/")
        target = (PUBLIC_DIR / rel).resolve()
        if not str(target).startswith(str(PUBLIC_DIR.resolve())) or not target.is_file():
            target = PUBLIC_DIR / "index.html"
        if not target.is_file():
            self.send_error(404, "File not found")
            return

        mime, _ = mimetypes.guess_type(str(target))
        if target.suffix == ".js":
            mime = "application/javascript; charset=utf-8"
        elif target.suffix == ".css":
            mime = "text/css; charset=utf-8"
        elif target.suffix == ".json":
            mime = "application/json; charset=utf-8"
        elif target.suffix == ".svg":
            mime = "image/svg+xml"
        elif not mime:
            mime = "application/octet-stream"

        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def run_server(port: int = 8080) -> None:
    server = ThreadingHTTPServer(("0.0.0.0", port), MonopolyHandler)
    lan = get_lan_ip()
    print(f"Monopoly Pay & Real Estate server attivo su:")
    print(f"  - Locale: http://localhost:{port}")
    print(f"  - Rete Wi-Fi (Smartphone): http://{lan}:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nArresto server...")
        server.server_close()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    run_server(port)

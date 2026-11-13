import json
import math
import os
import re
import secrets
import sqlite3
import time
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit


DATABASE_PATH = Path(os.environ.get("DATABASE_PATH", "/data/watch-together.sqlite3"))
ROOM_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
ROOM_CODE_LENGTH = 10
ROOM_TTL_SECONDS = 24 * 60 * 60
MEMBER_TTL_SECONDS = 12
MAX_REQUEST_BYTES = 16 * 1024
MAX_CHAT_LENGTH = 500
MAX_DURATION_SECONDS = 7 * 24 * 60 * 60
VIDEO_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{11}$")
CLIENT_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
ROOM_CODE_PATTERN = re.compile(r"^[A-Z2-9]{10}$")
MEMBER_STATUSES = {"loading", "buffering", "paused", "playing"}


class ApiError(Exception):
    def __init__(self, status, message, **details):
        super().__init__(message)
        self.status = status
        self.message = message
        self.details = details


@contextmanager
def database():
    DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DATABASE_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 10000")
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def initialize_database():
    with database() as connection:
        connection.execute("PRAGMA journal_mode = WAL")
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS rooms (
                code TEXT PRIMARY KEY,
                video_id TEXT NOT NULL,
                playback_position REAL NOT NULL,
                playback_paused INTEGER NOT NULL,
                playback_updated_at REAL NOT NULL,
                playback_version INTEGER NOT NULL,
                updated_by TEXT,
                updated_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS members (
                room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
                client_id TEXT NOT NULL,
                name TEXT NOT NULL,
                current_time REAL NOT NULL,
                duration REAL,
                buffered_end REAL NOT NULL,
                ready_state INTEGER NOT NULL,
                status TEXT NOT NULL,
                updated_at REAL NOT NULL,
                PRIMARY KEY (room_code, client_id)
            );
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
                client_id TEXT NOT NULL,
                name TEXT NOT NULL,
                text TEXT NOT NULL,
                created_at REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS messages_room_id
                ON messages(room_code, id);
            """
        )


def require_text(value, field, maximum, status=400):
    if not isinstance(value, str):
        raise ApiError(status, f"Поле «{field}» обязательно.")
    value = value.strip()
    if not value or len(value) > maximum:
        raise ApiError(status, f"Поле «{field}» имеет недопустимую длину.")
    return value


def require_client_id(value):
    value = require_text(value, "client_id", 64)
    if not CLIENT_ID_PATTERN.fullmatch(value):
        raise ApiError(400, "Некорректный идентификатор участника.")
    return value


def require_video_id(value):
    value = require_text(value, "video_id", 11)
    if not VIDEO_ID_PATTERN.fullmatch(value):
        raise ApiError(400, "Некорректный идентификатор видео YouTube.")
    return value


def require_number(value, field, maximum=MAX_DURATION_SECONDS):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ApiError(400, f"Поле «{field}» должно быть числом.")
    if not math.isfinite(value) or value < 0 or value > maximum:
        raise ApiError(400, f"Поле «{field}» вне допустимого диапазона.")
    return float(value)


def require_room_code(value):
    code = value.upper().replace("-", "")
    if not ROOM_CODE_PATTERN.fullmatch(code):
        raise ApiError(400, "Некорректный код комнаты.")
    return code


def create_room_code(connection):
    while True:
        code = "".join(secrets.choice(ROOM_ALPHABET) for _ in range(ROOM_CODE_LENGTH))
        if connection.execute("SELECT 1 FROM rooms WHERE code = ?", (code,)).fetchone() is None:
            return code


def update_member(connection, room_code, client_id, name, current_time=0, duration=None,
                  buffered_end=0, ready_state=0, status="loading"):
    now = time.time()
    connection.execute(
        """
        INSERT INTO members (
            room_code, client_id, name, current_time, duration,
            buffered_end, ready_state, status, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(room_code, client_id) DO UPDATE SET
            name = excluded.name,
            current_time = excluded.current_time,
            duration = excluded.duration,
            buffered_end = excluded.buffered_end,
            ready_state = excluded.ready_state,
            status = excluded.status,
            updated_at = excluded.updated_at
        """,
        (
            room_code, client_id, name, current_time, duration,
            buffered_end, ready_state, status, now,
        ),
    )
    connection.execute("UPDATE rooms SET updated_at = ? WHERE code = ?", (now, room_code))


def ensure_room(connection, room_code):
    room = connection.execute(
        "SELECT * FROM rooms WHERE code = ?", (room_code,)
    ).fetchone()
    if room is None:
        raise ApiError(404, "Комната не найдена или срок её действия истёк.")
    if room["updated_at"] < time.time() - ROOM_TTL_SECONDS:
        connection.execute("DELETE FROM rooms WHERE code = ?", (room_code,))
        raise ApiError(404, "Срок действия комнаты истёк.")
    connection.execute(
        "DELETE FROM members WHERE room_code = ? AND updated_at < ?",
        (room_code, time.time() - MEMBER_TTL_SECONDS),
    )
    return room


def room_state(connection, room_code):
    room = ensure_room(connection, room_code)
    now = time.time()
    elapsed = max(0, now - room["playback_updated_at"])
    position = room["playback_position"]
    if not room["playback_paused"]:
        position += elapsed
    playback = {
        "position": position,
        "paused": bool(room["playback_paused"]),
        "updated_at": room["playback_updated_at"],
        "updated_by": room["updated_by"] if "updated_by" in room.keys() else None,
        "version": room["playback_version"],
    }
    members = connection.execute(
        """
        SELECT client_id, name, current_time, duration, buffered_end,
               ready_state, status, updated_at
        FROM members WHERE room_code = ? ORDER BY updated_at DESC
        """,
        (room_code,),
    ).fetchall()
    messages = connection.execute(
        """
        SELECT id, client_id, name, text, created_at
        FROM messages WHERE room_code = ?
        ORDER BY id DESC LIMIT 100
        """,
        (room_code,),
    ).fetchall()
    return {
        "room_code": room_code,
        "video_id": room["video_id"],
        "playback": playback,
        "members": [dict(member) for member in members],
        "messages": [dict(message) for message in reversed(messages)],
        "server_time": now,
    }


def purge_expired_rooms(connection):
    connection.execute(
        "DELETE FROM rooms WHERE updated_at < ?", (time.time() - ROOM_TTL_SECONDS,)
    )


class RequestHandler(BaseHTTPRequestHandler):
    server_version = "WatchTogether/1.0"

    def log_message(self, _format, *args):
        return

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        raw_length = self.headers.get("Content-Length", "0")
        try:
            length = int(raw_length)
        except ValueError as error:
            raise ApiError(400, "Некорректный размер запроса.") from error
        if length < 0 or length > MAX_REQUEST_BYTES:
            raise ApiError(413, "Слишком большой запрос.")
        try:
            payload = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise ApiError(400, "Некорректный JSON.") from error
        if not isinstance(payload, dict):
            raise ApiError(400, "Ожидался JSON-объект.")
        return payload

    def dispatch(self, action):
        try:
            result = action()
            status, payload = result if isinstance(result, tuple) else (200, result)
            self.send_json(status, payload)
        except ApiError as error:
            self.send_json(error.status, {"error": error.message, **error.details})

    def do_GET(self):
        path = urlsplit(self.path).path
        if path in {"/health", "/api/health"}:
            self.send_json(200, {"status": "ok"})
            return
        match = re.fullmatch(r"/api/rooms/([A-Za-z0-9-]+)/state", path)
        if not match:
            self.send_json(404, {"error": "Маршрут не найден."})
            return
        self.dispatch(lambda: self.get_state(match.group(1)))

    def do_POST(self):
        path = urlsplit(self.path).path
        if path == "/api/rooms":
            self.dispatch(self.create_room)
            return
        match = re.fullmatch(r"/api/rooms/([A-Za-z0-9-]+)/(join|presence|playback|chat)", path)
        if not match:
            self.send_json(404, {"error": "Маршрут не найден."})
            return
        room_code = match.group(1)
        action = match.group(2)
        self.dispatch(lambda: self.room_action(room_code, action))

    def create_room(self):
        payload = self.read_json()
        video_id = require_video_id(payload.get("video_id"))
        client_id = require_client_id(payload.get("client_id"))
        name = require_text(payload.get("name"), "name", 32)
        position = require_number(payload.get("position", 0), "position")
        paused = payload.get("paused")
        if not isinstance(paused, bool):
            raise ApiError(400, "Поле «paused» должно быть логическим.")

        with database() as connection:
            purge_expired_rooms(connection)
            code = create_room_code(connection)
            now = time.time()
            connection.execute(
                """
                INSERT INTO rooms (
                    code, video_id, playback_position, playback_paused,
                    playback_updated_at, playback_version, updated_at, updated_by
                ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
                """,
                (code, video_id, position, int(paused), now, now, client_id),
            )
            update_member(connection, code, client_id, name)
            return 201, room_state(connection, code)

    def get_state(self, raw_code):
        code = require_room_code(raw_code)
        with database() as connection:
            return room_state(connection, code)

    def room_action(self, raw_code, action):
        code = require_room_code(raw_code)
        payload = self.read_json()
        client_id = require_client_id(payload.get("client_id"))

        with database() as connection:
            room = ensure_room(connection, code)
            if action == "join":
                video_id = require_video_id(payload.get("video_id"))
                if room["video_id"] != video_id:
                    raise ApiError(409, "Комната создана для другого видео.", video_id=room["video_id"])
                name = require_text(payload.get("name"), "name", 32)
                update_member(connection, code, client_id, name)
                return room_state(connection, code)

            member = connection.execute(
                "SELECT name FROM members WHERE room_code = ? AND client_id = ?",
                (code, client_id),
            ).fetchone()
            if member is None:
                raise ApiError(403, "Сначала войдите в комнату.")

            if action == "presence":
                current_time = require_number(payload.get("current_time", 0), "current_time")
                duration_value = payload.get("duration")
                duration = None if duration_value is None else require_number(duration_value, "duration")
                buffered_end = require_number(payload.get("buffered_end", 0), "buffered_end")
                ready_state = payload.get("ready_state", 0)
                if isinstance(ready_state, bool) or not isinstance(ready_state, int) or not 0 <= ready_state <= 4:
                    raise ApiError(400, "Некорректное состояние загрузки видео.")
                status = payload.get("status", "loading")
                if not isinstance(status, str) or status not in MEMBER_STATUSES:
                    raise ApiError(400, "Некорректный статус участника.")
                update_member(
                    connection, code, client_id, member["name"], current_time,
                    duration, buffered_end, ready_state, status,
                )
                return {"ok": True}

            if action == "playback":
                position = require_number(payload.get("position"), "position")
                paused = payload.get("paused")
                if not isinstance(paused, bool):
                    raise ApiError(400, "Поле «paused» должно быть логическим.")
                now = time.time()
                connection.execute(
                    """
                    UPDATE rooms SET playback_position = ?, playback_paused = ?,
                        playback_updated_at = ?, playback_version = playback_version + 1,
                        updated_at = ?, updated_by = ? WHERE code = ?
                    """,
                    (position, int(paused), now, now, client_id, code),
                )
                return {"ok": True}

            if action == "chat":
                text = require_text(payload.get("text"), "text", MAX_CHAT_LENGTH)
                now = time.time()
                connection.execute(
                    """
                    INSERT INTO messages(room_code, client_id, name, text, created_at)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (code, client_id, member["name"], text, now),
                )
                connection.execute("UPDATE rooms SET updated_at = ? WHERE code = ?", (now, code))
                connection.execute(
                    """
                    DELETE FROM messages WHERE room_code = ? AND id NOT IN (
                        SELECT id FROM messages WHERE room_code = ?
                        ORDER BY id DESC LIMIT 100
                    )
                    """,
                    (code, code),
                )
                return {"ok": True}

        raise ApiError(404, "Маршрут не найден.")


def main():
    initialize_database()
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8787"))
    server = ThreadingHTTPServer((host, port), RequestHandler)
    server.daemon_threads = True
    print(f"Watch Together API listening on {host}:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()

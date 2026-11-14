import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import app


VIDEO_ID = "abcdefghijk"


class WatchTogetherApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp_directory = tempfile.TemporaryDirectory()
        app.DATABASE_PATH = Path(cls.temp_directory.name) / "test.sqlite3"
        app.initialize_database()
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), app.RequestHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=3)
        cls.temp_directory.cleanup()

    def request_json(self, method, path, body=None):
        data = None if body is None else json.dumps(body).encode("utf-8")
        request = urllib.request.Request(
            self.base_url + path,
            data=data,
            method=method,
            headers={"Content-Type": "application/json"} if data is not None else {},
        )
        try:
            response = urllib.request.urlopen(request, timeout=3)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.loads(response.read().decode("utf-8"))

    def create_room(self, client_id="client_owner", **values):
        payload = {
            "video_id": VIDEO_ID,
            "client_id": client_id,
            "name": "Создатель",
            "position": 42,
            "paused": True,
            **values,
        }
        status, response = self.request_json("POST", "/api/rooms", payload)
        self.assertEqual(status, 201)
        return response

    def test_create_and_join_room_shares_video_and_playback(self):
        created = self.create_room()
        self.assertEqual(created["video_id"], VIDEO_ID)
        self.assertEqual(created["playback"]["position"], 42)
        self.assertTrue(created["playback"]["paused"])
        self.assertEqual(len(created["members"]), 1)

        status, joined = self.request_json(
            "POST",
            f"/api/rooms/{created['room_code']}/join",
            {
                "video_id": VIDEO_ID,
                "client_id": "client_guest",
                "name": "Гость",
            },
        )
        self.assertEqual(status, 200)
        self.assertEqual({member["client_id"] for member in joined["members"]},
                         {"client_owner", "client_guest"})

    def test_joining_wrong_video_returns_session_video(self):
        created = self.create_room()
        status, response = self.request_json(
            "POST",
            f"/api/rooms/{created['room_code']}/join",
            {
                "video_id": "lmnopqrstuv",
                "client_id": "client_guest",
                "name": "Гость",
            },
        )
        self.assertEqual(status, 409)
        self.assertEqual(response["video_id"], VIDEO_ID)

    def test_presence_reports_video_duration_and_buffer(self):
        created = self.create_room()
        code = created["room_code"]
        self.request_json(
            "POST",
            f"/api/rooms/{code}/presence",
            {
                "client_id": "client_owner",
                "current_time": 38,
                "duration": 180,
                "buffered_end": 55,
                "ready_state": 3,
                "status": "buffering",
            },
        )
        _, state = self.request_json("GET", f"/api/rooms/{code}/state")
        member = state["members"][0]
        self.assertEqual(member["duration"], 180)
        self.assertEqual(member["buffered_end"], 55)
        self.assertEqual(member["status"], "buffering")

    def test_pause_and_chat_are_shared_with_room(self):
        created = self.create_room()
        code = created["room_code"]
        self.request_json(
            "POST",
            f"/api/rooms/{code}/playback",
            {"client_id": "client_owner", "position": 77, "paused": False},
        )
        self.request_json(
            "POST",
            f"/api/rooms/{code}/chat",
            {"client_id": "client_owner", "text": "Всем привет!"},
        )
        _, state = self.request_json("GET", f"/api/rooms/{code}/state")
        self.assertFalse(state["playback"]["paused"])
        self.assertGreaterEqual(state["playback"]["position"], 77)
        self.assertEqual(state["messages"][0]["text"], "Всем привет!")
        self.assertEqual(state["messages"][0]["name"], "Создатель")

    def test_duck_greeting_is_shared_and_restricted_to_yaro(self):
        created = self.create_room(name="Яро")
        code = created["room_code"]
        status, response = self.request_json(
            "POST",
            f"/api/rooms/{code}/duck",
            {"client_id": "client_owner"},
        )
        self.assertEqual(status, 200)
        self.assertTrue(response["ok"])

        _, state = self.request_json("GET", f"/api/rooms/{code}/state")
        self.assertEqual(len(state["duck_events"]), 1)
        self.assertEqual(state["duck_events"][0]["client_id"], "client_owner")

        self.request_json(
            "POST",
            f"/api/rooms/{code}/join",
            {
                "video_id": VIDEO_ID,
                "client_id": "client_guest",
                "name": "Гость",
            },
        )
        status, response = self.request_json(
            "POST",
            f"/api/rooms/{code}/duck",
            {"client_id": "client_guest"},
        )
        self.assertEqual(status, 403)
        self.assertIn("Яро", response["error"])

        self.request_json(
            "POST",
            f"/api/rooms/{code}/presence",
            {
                "client_id": "client_guest",
                "name": "Яро",
                "current_time": 0,
                "duration": None,
                "buffered_end": 0,
                "ready_state": 0,
                "status": "loading",
            },
        )
        status, response = self.request_json(
            "POST",
            f"/api/rooms/{code}/duck",
            {"client_id": "client_guest"},
        )
        self.assertEqual(status, 200)
        _, state = self.request_json("GET", f"/api/rooms/{code}/state")
        self.assertEqual(len(state["duck_events"]), 2)

    def test_invalid_video_id_is_rejected(self):
        status, response = self.request_json(
            "POST",
            "/api/rooms",
            {
                "video_id": "invalid_id!",
                "client_id": "client_owner",
                "name": "Создатель",
                "position": 0,
                "paused": True,
            },
        )
        self.assertEqual(status, 400)
        self.assertIn("YouTube", response["error"])

    def test_health_endpoint(self):
        for path in ("/health", "/api/health"):
            with self.subTest(path=path):
                status, response = self.request_json("GET", path)
                self.assertEqual(status, 200)
                self.assertEqual(response["status"], "ok")


if __name__ == "__main__":
    unittest.main()

"""Container integration checks against the disposable database created by container-smoke.sh."""
import http.cookiejar
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

BASE = "http://127.0.0.1:18085"
config = dict(line.split("=", 1) for line in Path(sys.argv[1]).read_text().splitlines())


class Client:
    def __init__(self):
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.csrf = None

    def call(self, path, data=None, method=None, expected=200):
        headers = {"Origin": BASE}
        if data is not None:
            headers["Content-Type"] = "application/json"
        if self.csrf:
            headers["X-CSRF-Token"] = self.csrf
        req = urllib.request.Request(BASE + path, data=json.dumps(data).encode() if data is not None else None,
                                     headers=headers, method=method)
        try:
            response = self.opener.open(req, timeout=10)
        except urllib.error.HTTPError as error:
            assert error.code == expected, (path, error.code, error.read().decode())
            return None
        assert response.status == expected, (path, response.status)
        payload = json.load(response)
        if "csrf_token" in payload:
            self.csrf = payload["csrf_token"]
        return payload

    def login(self, username, password=None):
        return self.call("/api/login", {"username": username, "password": password or config[f"{username.upper()}_PASSWORD"]})


public = Client()
with urllib.request.urlopen(BASE + "/competitions/1") as response:
    assert response.status == 200 and b'<html' in response.read().lower()
lukas, oli = Client(), Client()
lukas.login("lukas")
oli.login("oli")
if sys.argv[2] == "before":
    initial = public.call("/api/competitions")
    assert initial["current_id"] == 1
    assert len(lukas.call("/api/admin/users")["users"]) == 2
    oli.call("/api/admin/users", expected=403)
    lukas.call("/api/admin/users", {"username": "solaire", "password": config["OLI_PASSWORD"] + "-sun"}, expected=201)
    run = lukas.call("/api/competitions/1/attempt/start", {})
    assert len(run["encounters"]) == 86
    assert sum(e["points"] for e in run["encounters"]) == 310
    boss = next(e for e in run["encounters"] if e["kind"] == "boss")
    path = f'/api/competitions/1/attempt/encounters/{boss["id"]}'
    lukas.call(path, {"defeated": True}, "PUT")
    lukas.call(path, {"defeated": True}, "PUT")
    assert oli.call("/api/competitions/1/attempt")["attempt"] is None
    lukas.call("/api/competitions/1/attempt/finish", {"outcome": "failed"})
    selected = {"expected_current_id": 1, "participants": ["lukas", "solaire"]}
    oli.call("/api/competitions", selected, expected=403)
    lukas.call("/api/competitions", selected)
    oli.call("/api/competitions/2/attempt", expected=403)
    assert {p["username"] for p in public.call("/api/competitions/2/leaderboard")["players"]} == {"lukas", "solaire"}
    members_path = "/api/admin/competitions/2/participants"
    lukas.call(members_path, {"participants": ["lukas", "oli", "solaire"]}, "PUT")
    assert oli.call("/api/competitions/2/attempt")["attempt"] is None
    lukas.call(members_path, {"participants": ["lukas", "solaire"]}, "PUT")
    lukas.call("/api/admin/users/solaire", {"password": config["LUKAS_PASSWORD"] + "-sun"}, "PATCH")
    lukas.call("/api/admin/users/solaire", {"active": False}, "PATCH")
    lukas.call("/api/admin/users/solaire", {"active": True}, "PATCH")
    solaire = Client()
    solaire.login("solaire", config["LUKAS_PASSWORD"] + "-sun")
    changed = solaire.call("/api/account/password", {
        "current_password": config["LUKAS_PASSWORD"] + "-sun",
        "new_password": config["OLI_PASSWORD"] + "-sun-new",
    })
    assert changed == {"user": None, "csrf_token": None}
    solaire.call("/api/competitions/2/attempt", expected=401)
    assert lukas.call("/api/session")["user"]["username"] == "lukas"
    solaire.login("solaire", config["OLI_PASSWORD"] + "-sun-new")
    practice = solaire.call("/api/practice", {})
    solaire.call(f'/api/practice/{practice["id"]}/encounters/{boss["id"]}', {"defeated": True}, "PUT")
    saved = solaire.call(f'/api/practice/{practice["id"]}/save', {"outcome": "died"})
    assert saved["saved"]["points"] == 5 and saved["draft"]["points"] == 0
    practice = solaire.call(f'/api/practice/{saved["draft"]["id"]}/reset', {})
    mini = next(entry for entry in practice["encounters"] if entry["kind"] == "miniboss")
    solaire.call(f'/api/practice/{practice["id"]}/encounters/{mini["id"]}', {"defeated": True}, "PUT")
    assert public.call("/api/competitions/1/progress")["competition"]["name"] == "Run 1"
    assert len(public.call("/api/players/lukas/runs")["runs"]) == 2
    lukas.call(path, {"defeated": False}, "PUT", expected=409)
else:
    competitions = public.call("/api/competitions")
    assert competitions["current_id"] == 2 and len(competitions["competitions"]) == 2
    old = public.call("/api/competitions/1/leaderboard")
    assert old["competition"]["status"] == "archived"
    player = next(p for p in old["players"] if p["username"] == "lukas")
    assert player["points"] == 5 and player["attempt_status"] == "failed"
    assert lukas.call("/api/competitions/1/attempt")["attempt"]["points"] == 5
    assert lukas.call("/api/competitions/2/attempt")["attempt"] is None
    oli.call("/api/competitions/2/attempt", expected=403)
    assert {p["username"] for p in old["players"]} == {"lukas", "oli"}
    assert {p["username"] for p in public.call("/api/competitions/2/leaderboard")["players"]} == {"lukas", "solaire"}
    assert len(lukas.call("/api/admin/users")["users"]) == 3
    solaire = Client()
    solaire.call("/api/login", {"username": "solaire", "password": config["LUKAS_PASSWORD"] + "-sun"}, expected=401)
    solaire.login("solaire", config["OLI_PASSWORD"] + "-sun-new")
    assert solaire.call("/api/competitions/2/attempt")["attempt"] is None
    solaire.call("/api/competitions/1/attempt", expected=403)
    assert solaire.call("/api/practice")["points"] == 3
    history = solaire.call("/api/practice/history")["attempts"]
    assert len(history) == 1 and history[0]["points"] == 5 and history[0]["outcome"] == "died"
    saved = solaire.call("/api/practice/history/" + history[0]["id"])
    assert sum(entry["defeated"] for entry in saved["encounters"]) == 1
    lukas.call("/api/practice/history/" + history[0]["id"], expected=404)
    solaire.call("/api/practice/history", method="DELETE")
    assert solaire.call("/api/practice")["points"] == 3
    assert len(public.call("/api/players/solaire/runs")["runs"]) == 1
print(f'Container smoke checks passed ({sys.argv[2]} recreation).')

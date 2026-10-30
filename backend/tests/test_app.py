import json
import hashlib
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app import COOKIE_NAME, Settings, create_app, load_catalog, password_hash

PASSWORDS = {"lukas": "test-lukas-password", "oli": "test-oli-password"}
ORIGIN = "http://testserver"


def encounter(identifier="boss", kind="boss", **extra):
    return {
        "id": identifier, "area_id": "asylum", "area_name": "Undead Asylum", "area_order": 1,
        "name": identifier.title(), "description": "A test encounter", "kind": kind,
        "points": 5 if kind == "boss" else 3, **extra,
    }


@pytest.fixture
def setup(tmp_path):
    catalog = tmp_path / "catalog.json"
    catalog.write_text(json.dumps([encounter(), encounter("miniboss", "miniboss")]))
    frontend = tmp_path / "dist"
    frontend.mkdir()
    (frontend / "index.html").write_text("<h1>Soulkeeper</h1>")
    (frontend / "app.js").write_text("console.log('ready')")
    settings = Settings(passwords=PASSWORDS.copy(), data_dir=tmp_path / "data", app_origin=ORIGIN, frontend_dist=frontend)
    return settings, catalog


@pytest.fixture
def app(setup):
    settings, catalog = setup
    application = create_app(settings, catalog)
    with TestClient(application) as client:
        yield application, client


def sign_in(client, username="lukas", password=None):
    response = client.post("/api/login", json={"username": username, "password": password or PASSWORDS[username]}, headers={"Origin": ORIGIN})
    assert response.status_code == 200, response.text
    return {"X-CSRF-Token": response.json()["csrf_token"], "Origin": ORIGIN}


def start(client, headers, competition_id=1):
    return client.post(f"/api/competitions/{competition_id}/attempt/start", headers=headers)


def check(client, headers, encounter_id="boss", defeated=True, competition_id=1):
    return client.put(f"/api/competitions/{competition_id}/attempt/encounters/{encounter_id}", json={"defeated": defeated}, headers=headers)


def finish(client, headers, outcome="failed", competition_id=1):
    return client.post(f"/api/competitions/{competition_id}/attempt/finish", json={"outcome": outcome}, headers=headers)


def create_next(client, headers, expected_current_id=1):
    return client.post("/api/competitions", json={"expected_current_id": expected_current_id, "participants": ["lukas", "oli"]}, headers=headers)


def test_public_leaderboard_starts_tied_without_disclosing_checklists(app):
    _, client = app
    result = client.get("/api/competitions/1/leaderboard")
    assert result.status_code == 200
    assert result.headers["cache-control"] == "no-store"
    body = result.json()
    assert body["competition"]["name"] == "Competition 1"
    assert body["max_points"] == 8
    assert {player["username"] for player in body["players"]} == {"lukas", "oli"}
    assert all(player["rank"] == 1 and player["attempt_status"] == "not_started" and player["points"] == 0 for player in body["players"])
    assert "encounters" not in body
    assert client.get("/api/competitions/1/attempt").status_code == 401
    assert client.get("/api/session").json() == {"user": None, "csrf_token": None}


def test_login_cookie_csrf_and_logout(app):
    application, client = app
    headers = sign_in(client)
    session = client.get("/api/session").json()
    assert session["user"] == {"username": "lukas", "can_manage": True}
    assert session["csrf_token"] == headers["X-CSRF-Token"]
    cookie = client.cookies.get(COOKIE_NAME)
    with application.state.db.connect() as connection:
        saved = connection.execute("SELECT token_hash FROM sessions").fetchone()[0]
        assert saved != cookie
        account = connection.execute("SELECT password_hash FROM users WHERE username='lukas'").fetchone()[0]
        assert PASSWORDS["lukas"].encode() not in account
    assert start(client, {}).status_code == 403
    assert start(client, {"X-CSRF-Token": "wrong"}).status_code == 403
    assert start(client, {**headers, "Origin": "https://evil.example"}).status_code == 403
    assert start(client, headers).status_code == 200
    assert client.post("/api/logout", headers=headers).json() == {"user": None, "csrf_token": None}
    assert client.get("/api/competitions/1/attempt").status_code == 401


def test_login_rejects_wrong_origin_and_throttles_failures(app):
    _, client = app
    assert client.post("/api/login", json={"username": "lukas", "password": PASSWORDS["lukas"]}, headers={"Origin": "https://evil.example"}).status_code == 403
    for _ in range(5):
        assert client.post("/api/login", json={"username": "lukas", "password": "wrong"}).status_code == 401
    blocked = client.post("/api/login", json={"username": "lukas", "password": PASSWORDS["lukas"]})
    assert blocked.status_code == 429
    assert blocked.headers["retry-after"] == "60"


def test_https_cookie_is_secure_http_only_and_strict(setup):
    settings, catalog = setup
    secure = Settings(passwords=PASSWORDS, data_dir=settings.data_dir, app_origin="https://soulkeeper.example", cookie_secure=True)
    with TestClient(create_app(secure, catalog), base_url="https://soulkeeper.example") as client:
        response = client.post("/api/login", json={"username": "oli", "password": PASSWORDS["oli"]})
        header = response.headers["set-cookie"]
        assert "HttpOnly" in header and "Secure" in header and "SameSite=strict" in header
        assert client.get("/api/session").json()["user"]["username"] == "oli"


def test_checks_are_idempotent_reversible_and_owned(app):
    application, client = app
    headers = sign_in(client)
    assert check(client, headers).status_code == 409
    first = start(client, headers).json()
    assert start(client, headers).json()["attempt"]["started_at"] == first["attempt"]["started_at"]
    assert check(client, headers).json()["attempt"]["points"] == 5
    assert check(client, headers).json()["attempt"]["points"] == 5
    both = check(client, headers, "miniboss").json()
    assert both["attempt"]["points"] == 8
    assert both["attempt"]["bosses_defeated"] == both["attempt"]["minibosses_defeated"] == 1
    assert check(client, headers, defeated=False).json()["attempt"]["points"] == 3
    assert check(client, headers, "missing").status_code == 404
    assert client.put("/api/competitions/1/attempt/encounters/boss", json={"defeated": "true"}, headers=headers).status_code == 422
    assert client.put("/api/competitions/1/attempt/encounters/boss", json={"defeated": True, "username": "oli"}, headers=headers).status_code == 422
    other = TestClient(application)
    other_headers = sign_in(other, "oli")
    assert other.get("/api/competitions/1/attempt").json()["attempt"] is None
    assert start(other, other_headers).json()["attempt"]["points"] == 0
    assert check(other, other_headers).json()["attempt"]["points"] == 5
    assert client.get("/api/competitions/1/attempt").json()["attempt"]["points"] == 3
    players = client.get("/api/competitions/1/leaderboard").json()["players"]
    assert [(row["username"], row["rank"], row["points"]) for row in players] == [("oli", 1, 5), ("lukas", 2, 3)]


@pytest.mark.parametrize("outcome", ["failed", "completed"])
def test_finished_attempts_cannot_be_modified_or_restarted(app, outcome):
    _, client = app
    headers = sign_in(client)
    start(client, headers)
    check(client, headers)
    saved = finish(client, headers, outcome).json()
    assert saved["attempt"]["status"] == outcome
    assert saved["attempt"]["ended_at"] is not None
    assert saved["attempt"]["points"] == 5
    assert finish(client, headers, outcome).json() == saved
    assert check(client, headers, defeated=False).status_code == 409
    assert start(client, headers).status_code == 409
    assert finish(client, headers, "completed" if outcome == "failed" else "failed").status_code == 409


def test_manager_creates_fresh_competition_and_freezes_old_attempts(app):
    application, client = app
    headers = sign_in(client)
    start(client, headers)
    old = check(client, headers).json()
    other = TestClient(application)
    other_headers = sign_in(other, "oli")
    start(other, other_headers)
    assert create_next(other, other_headers).status_code == 403
    created = create_next(client, headers)
    assert created.status_code == 200
    assert created.json()["competition"]["name"] == "Competition 2"
    assert created.json()["current_id"] == 2
    assert create_next(client, headers).status_code == 409
    assert client.get("/api/competitions").json()["current_id"] == 2
    archived = client.get("/api/competitions/1/attempt").json()
    assert archived["competition"]["status"] == "archived"
    assert archived["attempt"] == old["attempt"]
    assert check(client, headers).status_code == 409
    assert start(client, headers).status_code == 409
    assert finish(client, headers).status_code == 409
    assert client.get("/api/competitions/2/attempt").json()["attempt"] is None
    assert start(client, headers, 2).json()["attempt"]["points"] == 0
    old_players = client.get("/api/competitions/1/leaderboard").json()["players"]
    assert old_players[0]["points"] == 5 and old_players[0]["attempt_status"] == "active"


def test_restart_preserves_sessions_scores_and_catalog_snapshots(setup):
    settings, catalog = setup
    with TestClient(create_app(settings, catalog)) as client:
        headers = sign_in(client)
        start(client, headers)
        check(client, headers)
        cookie = client.cookies.get(COOKIE_NAME)
    catalog.write_text(json.dumps([encounter(name="Changed name"), encounter("miniboss", "miniboss"), encounter("new-boss")]))
    with TestClient(create_app(settings, catalog)) as restarted:
        restarted.cookies.set(COOKIE_NAME, cookie)
        saved = restarted.get("/api/competitions/1/attempt").json()
        assert saved["attempt"]["points"] == 5
        assert saved["encounters"][0]["name"] == "Boss"
        assert saved["competition"]["max_points"] == 8
        assert create_next(restarted, headers).json()["competition"]["max_points"] == 13
        assert restarted.get("/api/competitions/2/attempt").json()["encounters"][0]["name"] == "Changed name"


def test_bootstrap_environment_does_not_replace_passwords_or_sessions(setup):
    settings, catalog = setup
    application = create_app(settings, catalog)
    with TestClient(application) as client:
        sign_in(client)
        lukas_cookie = client.cookies.get(COOKIE_NAME)
        other = TestClient(application)
        sign_in(other, "oli")
        oli_cookie = other.cookies.get(COOKIE_NAME)
    rotated = Settings(passwords={**PASSWORDS, "lukas": "replacement-test-password"}, data_dir=settings.data_dir, app_origin=ORIGIN)
    with TestClient(create_app(rotated, catalog)) as client:
        client.cookies.set(COOKIE_NAME, oli_cookie)
        assert client.get("/api/session").json()["user"]["username"] == "oli"
        client.cookies.set(COOKIE_NAME, lukas_cookie)
        assert client.get("/api/session").json()["user"]["username"] == "lukas"


def test_expired_sessions_cannot_write(app):
    application, client = app
    headers = sign_in(client)
    with application.state.db.transaction() as connection:
        connection.execute("UPDATE sessions SET expires_at='2000-01-01T00:00:00Z'")
    assert client.get("/api/session").json()["user"] is None
    assert start(client, headers).status_code == 401


def test_competition_creation_race_has_one_winner(app):
    application, client = app
    headers = sign_in(client)
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: create_next(client, headers), range(2)))
    assert sorted(response.status_code for response in responses) == [200, 409]
    with application.state.db.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM competitions").fetchone()[0] == 2
        assert connection.execute("SELECT COUNT(*) FROM competitions WHERE status='current'").fetchone()[0] == 1


def test_check_finish_race_freezes_a_consistent_score(app):
    _, client = app
    headers = sign_in(client)
    start(client, headers)
    with ThreadPoolExecutor(max_workers=2) as pool:
        checked = pool.submit(check, client, headers)
        finished = pool.submit(finish, client, headers)
        checked_response, finished_response = checked.result(), finished.result()
    assert finished_response.status_code == 200
    assert checked_response.status_code in (200, 409)
    result = client.get("/api/competitions/1/attempt").json()["attempt"]
    assert result["status"] == "failed"
    assert result["points"] == (5 if checked_response.status_code == 200 else 0)
    assert check(client, headers, defeated=False).status_code == 409


def test_archive_check_race_preserves_prior_score_or_rejects_stale_write(app):
    _, client = app
    headers = sign_in(client)
    start(client, headers)
    with ThreadPoolExecutor(max_workers=2) as pool:
        checked = pool.submit(check, client, headers)
        archived = pool.submit(create_next, client, headers)
        checked_response, archived_response = checked.result(), archived.result()
    assert archived_response.status_code == 200
    assert checked_response.status_code in (200, 409)
    old = client.get("/api/competitions/1/attempt").json()
    assert old["competition"]["status"] == "archived"
    assert old["attempt"]["points"] == (5 if checked_response.status_code == 200 else 0)
    assert client.get("/api/competitions/2/attempt").json()["attempt"] is None


def test_static_frontend_and_health(app):
    _, client = app
    assert client.get("/healthz").json() == {"status": "ok"}
    assert "Soulkeeper" in client.get("/competitions/1").text
    assert client.get("/app.js").text == "console.log('ready')"
    assert client.get("/api/no-such-route").status_code == 404
    assert client.get("/api/competitions/999/leaderboard").status_code == 404


@pytest.mark.parametrize("passwords", [{}, {"lukas": "", "oli": "other"}, {"lukas": "same-password", "oli": "same-password"}])
def test_missing_or_identical_passwords_fail_first_setup(passwords, setup):
    settings, catalog = setup
    with pytest.raises(ValueError):
        with TestClient(create_app(Settings(passwords=passwords, data_dir=settings.data_dir), catalog)):
            pass


def test_catalog_validation_rejects_duplicate_ids_and_wrong_points(tmp_path):
    path = tmp_path / "bad.json"
    path.write_text(json.dumps([encounter(), encounter()]))
    with pytest.raises(ValueError, match="unique"):
        load_catalog(path)
    path.write_text(json.dumps([encounter(points=99)]))
    with pytest.raises(ValueError, match="5 points"):
        load_catalog(path)


def add_player(client, headers, username="charlie", password="charlie-test-password"):
    return client.post("/api/admin/users", json={"username": username, "password": password}, headers=headers)


def participants(client, headers, names, competition_id=1):
    return client.put(f"/api/admin/competitions/{competition_id}/participants", json={"participants": names}, headers=headers)


def test_admin_endpoints_require_lukas_and_csrf(app):
    application, client = app
    assert client.get("/api/admin/users").status_code == 401
    assert client.get("/api/admin/competitions/1/participants").status_code == 401
    oli = TestClient(application)
    oli_headers = sign_in(oli, "oli")
    assert oli.get("/api/admin/users").status_code == 403
    assert oli.get("/api/admin/competitions/1/participants").status_code == 403
    assert add_player(oli, oli_headers).status_code == 403
    assert participants(oli, oli_headers, ["oli"]).status_code == 403
    assert oli.patch("/api/admin/users/lukas", json={"password": "different-test-password"}, headers=oli_headers).status_code == 403
    headers = sign_in(client)
    assert add_player(client, {}).status_code == 403
    assert participants(client, {}, ["lukas"]).status_code == 403
    assert client.patch("/api/admin/users/oli", json={"active": False}).status_code == 403
    created = add_player(client, headers)
    assert created.status_code == 201
    assert created.json() == {"user": {"username": "charlie", "active": True, "can_manage": False}}
    assert add_player(client, headers).status_code == 409
    assert client.get("/api/admin/users").json()["users"] == [
        {"username": "charlie", "active": True, "can_manage": False},
        {"username": "lukas", "active": True, "can_manage": True},
        {"username": "oli", "active": True, "can_manage": False},
    ]


@pytest.mark.parametrize("username", ["UPPER", "ab", "with space", "with.dot", "a" * 33])
def test_new_player_username_validation(app, username):
    _, client = app
    headers = sign_in(client)
    assert add_player(client, headers, username).status_code == 422


@pytest.mark.parametrize("payload", [{}, {"password": ""}, {"password": "short"}, {"password": "x" * 1025}, {"password": None}, {"active": None}, {"active": "false"}, {"username": "renamed"}])
def test_player_updates_reject_invalid_or_empty_changes(app, payload):
    _, client = app
    headers = sign_in(client)
    assert client.patch("/api/admin/users/oli", json=payload, headers=headers).status_code == 422


def test_membership_controls_checklist_access_without_adding_every_new_user(app):
    application, client = app
    headers = sign_in(client)
    assert add_player(client, headers).status_code == 201
    charlie = TestClient(application)
    charlie_headers = sign_in(charlie, "charlie", "charlie-test-password")
    assert charlie.get("/api/competitions/1/attempt").status_code == 403
    assert start(charlie, charlie_headers).status_code == 403
    assert check(charlie, charlie_headers).status_code == 403
    assert finish(charlie, charlie_headers).status_code == 403
    assert [p["username"] for p in charlie.get("/api/competitions/1/leaderboard").json()["players"]] == ["lukas", "oli"]
    assert participants(client, headers, ["oli", "charlie"]).json() == {"participants": ["charlie", "oli"]}
    assert client.get("/api/competitions/1/attempt").status_code == 403
    assert start(charlie, charlie_headers).status_code == 200
    assert check(charlie, charlie_headers).json()["attempt"]["points"] == 5
    rejected = participants(client, headers, ["oli", "lukas"])
    assert rejected.status_code == 409
    assert client.get("/api/admin/competitions/1/participants").json() == {"participants": ["charlie", "oli"]}


@pytest.mark.parametrize("names", [[], ["lukas", "lukas"], ["missing"], ["UPPER"]])
def test_participant_validation_cannot_archive_current_competition(app, names):
    _, client = app
    headers = sign_in(client)
    assert participants(client, headers, names).status_code == 422
    response = client.post("/api/competitions", json={"expected_current_id": 1, "participants": names}, headers=headers)
    assert response.status_code == 422
    assert client.get("/api/competitions").json()["current_id"] == 1


def test_deactivation_revokes_access_but_preserves_score_and_membership(app):
    application, client = app
    headers = sign_in(client)
    oli = TestClient(application)
    oli_headers = sign_in(oli, "oli")
    start(oli, oli_headers)
    check(oli, oli_headers)
    assert client.patch("/api/admin/users/lukas", json={"active": False}, headers=headers).status_code == 422
    assert client.patch("/api/admin/users/oli", json={"active": False}, headers=headers).status_code == 200
    assert oli.get("/api/session").json()["user"] is None
    assert check(oli, oli_headers).status_code == 401
    assert oli.post("/api/login", json={"username": "oli", "password": PASSWORDS["oli"]}).status_code == 401
    row = next(p for p in client.get("/api/competitions/1/leaderboard").json()["players"] if p["username"] == "oli")
    assert row["points"] == 5 and row["attempt_status"] == "active"
    assert participants(client, headers, ["lukas", "oli"]).status_code == 200
    assert create_next(client, headers).status_code == 422
    assert participants(client, headers, ["lukas"]).status_code == 409
    assert client.patch("/api/admin/users/oli", json={"active": True}, headers=headers).status_code == 200
    assert oli.get("/api/session").json()["user"] is None
    sign_in(oli, "oli")
    assert oli.get("/api/competitions/1/attempt").json()["attempt"]["points"] == 5


def test_unstarted_inactive_member_can_remain_but_cannot_be_readded(app):
    _, client = app
    headers = sign_in(client)
    client.patch("/api/admin/users/oli", json={"active": False}, headers=headers)
    assert participants(client, headers, ["lukas", "oli"]).status_code == 200
    assert participants(client, headers, ["lukas"]).status_code == 200
    assert participants(client, headers, ["lukas", "oli"]).status_code == 422


def test_admin_password_reset_revokes_sessions_and_survives_restart(setup):
    settings, catalog = setup
    application = create_app(settings, catalog)
    with TestClient(application) as client:
        headers = sign_in(client)
        oli = TestClient(application)
        oli_headers = sign_in(oli, "oli")
        start(oli, oli_headers)
        check(oli, oli_headers)
        result = client.patch("/api/admin/users/oli", json={"password": "updated-oli-test-password"}, headers=headers)
        assert result.status_code == 200
        assert oli.get("/api/session").json()["user"] is None
        assert oli.post("/api/login", json={"username": "oli", "password": PASSWORDS["oli"]}).status_code == 401
        sign_in(oli, "oli", "updated-oli-test-password")
        assert oli.get("/api/competitions/1/attempt").json()["attempt"]["points"] == 5
        client.patch("/api/admin/users/oli", json={"active": False}, headers=headers)
        assert client.patch("/api/admin/users/lukas", json={"password": "updated-lukas-test-password"}, headers=headers).status_code == 200
        assert client.get("/api/session").json()["user"] is None
        assert client.get("/api/admin/users").status_code == 401
    with TestClient(create_app(Settings(data_dir=settings.data_dir, app_origin=ORIGIN), catalog)) as restarted:
        new_headers = sign_in(restarted, "lukas", "updated-lukas-test-password")
        users = restarted.get("/api/admin/users").json()["users"]
        assert next(user for user in users if user["username"] == "oli")["active"] is False
        restarted.patch("/api/admin/users/oli", json={"active": True}, headers=new_headers)
        sign_in(restarted, "oli", "updated-oli-test-password")
        assert restarted.get("/api/competitions/1/attempt").json()["attempt"]["points"] == 5


def test_new_competition_has_selected_members_and_archive_is_immutable(app):
    application, client = app
    headers = sign_in(client)
    add_player(client, headers)
    response = client.post("/api/competitions", json={"expected_current_id": 1, "participants": ["charlie"], "name": "  New challenge  "}, headers=headers)
    assert response.status_code == 200
    assert response.json()["competition"]["name"] == "New challenge"
    assert client.get("/api/admin/competitions/2/participants").json() == {"participants": ["charlie"]}
    assert [p["username"] for p in client.get("/api/competitions/2/leaderboard").json()["players"]] == ["charlie"]
    assert participants(client, headers, ["charlie"], 1).status_code == 409
    assert client.get("/api/admin/competitions/1/participants").json() == {"participants": ["lukas", "oli"]}
    assert client.get("/api/competitions/2/attempt").status_code == 403
    assert start(client, headers, 2).status_code == 403
    charlie = TestClient(application)
    charlie_headers = sign_in(charlie, "charlie", "charlie-test-password")
    assert start(charlie, charlie_headers, 2).status_code == 200
    assert charlie.get("/api/competitions/1/attempt").status_code == 403


def test_member_removal_races_attempt_start_without_losing_started_player(app):
    application, client = app
    headers = sign_in(client)
    oli = TestClient(application)
    oli_headers = sign_in(oli, "oli")
    with ThreadPoolExecutor(max_workers=2) as pool:
        started = pool.submit(start, oli, oli_headers)
        removed = pool.submit(participants, client, headers, ["lukas"])
        start_response, remove_response = started.result(), removed.result()
    assert sorted([start_response.status_code, remove_response.status_code]) in ([200, 409], [200, 403])
    members = client.get("/api/admin/competitions/1/participants").json()["participants"]
    assert ("oli" in members) == (start_response.status_code == 200)


@pytest.mark.parametrize("change", ["password", "deactivate_reactivate"])
def test_login_in_progress_cannot_create_session_after_credentials_change(app, monkeypatch, change):
    application, client = app
    headers = sign_in(client)
    hashing = threading.Event()
    resume = threading.Event()
    original_hash = password_hash

    def delayed_hash(password, salt):
        if password == PASSWORDS["oli"]:
            hashing.set()
            assert resume.wait(5)
        return original_hash(password, salt)

    monkeypatch.setattr("backend.app.password_hash", delayed_hash)
    oli = TestClient(application)
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(oli.post, "/api/login", json={"username": "oli", "password": PASSWORDS["oli"]})
        assert hashing.wait(5)
        if change == "password":
            assert client.patch("/api/admin/users/oli", json={"password": "updated-oli-test-password"}, headers=headers).status_code == 200
        else:
            assert client.patch("/api/admin/users/oli", json={"active": False}, headers=headers).status_code == 200
            assert client.patch("/api/admin/users/oli", json={"active": True}, headers=headers).status_code == 200
        resume.set()
        assert pending.result().status_code == 401
    with application.state.db.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM sessions WHERE username='oli'").fetchone()[0] == 0


@pytest.mark.parametrize("interrupt_migration", [False, True])
def test_v1_migration_preserves_realistic_history_passwords_and_sessions(setup, monkeypatch, interrupt_migration):
    settings, catalog = setup
    settings.data_dir.mkdir()
    database_path = settings.data_dir / "soulkeeper.db"
    connection = sqlite3.connect(database_path)
    connection.executescript("""
        PRAGMA foreign_keys=ON;
        CREATE TABLE users(username TEXT PRIMARY KEY CHECK(username IN ('lukas','oli')), password_salt BLOB NOT NULL, password_hash BLOB NOT NULL);
        CREATE TABLE sessions(token_hash TEXT PRIMARY KEY, username TEXT NOT NULL REFERENCES users(username), csrf_token TEXT NOT NULL, expires_at TEXT NOT NULL);
        CREATE TABLE competitions(id INTEGER PRIMARY KEY AUTOINCREMENT, number INTEGER NOT NULL UNIQUE, name TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('current','archived')), created_at TEXT NOT NULL, archived_at TEXT);
        CREATE UNIQUE INDEX one_current_competition ON competitions(status) WHERE status='current';
        CREATE TABLE encounters(competition_id INTEGER NOT NULL REFERENCES competitions(id), id TEXT NOT NULL, data TEXT NOT NULL, kind TEXT NOT NULL, points INTEGER NOT NULL, sort_order INTEGER NOT NULL, PRIMARY KEY(competition_id,id));
        CREATE TABLE attempts(competition_id INTEGER NOT NULL REFERENCES competitions(id), username TEXT NOT NULL REFERENCES users(username), status TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, PRIMARY KEY(competition_id,username));
        CREATE TABLE kills(competition_id INTEGER NOT NULL, username TEXT NOT NULL, encounter_id TEXT NOT NULL, defeated_at TEXT NOT NULL, PRIMARY KEY(competition_id,username,encounter_id), FOREIGN KEY(competition_id,username) REFERENCES attempts(competition_id,username), FOREIGN KEY(competition_id,encounter_id) REFERENCES encounters(competition_id,id));
        PRAGMA user_version=1;
    """)
    for username in ["lukas", "oli"]:
        salt = username.encode().ljust(16, b"_")
        connection.execute("INSERT INTO users VALUES(?,?,?)", (username, salt, password_hash(PASSWORDS[username], salt)))
    legacy_token = "legacy-lukas-session"
    connection.execute("INSERT INTO sessions VALUES(?,?,?,?)", (hashlib.sha256(legacy_token.encode()).hexdigest(), "lukas", "legacy-csrf", "2099-01-01T00:00:00Z"))
    for identifier, status in [(1, "archived"), (2, "current")]:
        connection.execute("INSERT INTO competitions VALUES(?,?,?,?,?,?)", (identifier, identifier, f"Competition {identifier}", status, "2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z" if identifier == 1 else None))
        for index, item in enumerate(json.loads(catalog.read_text())):
            connection.execute("INSERT INTO encounters VALUES(?,?,?,?,?,?)", (identifier, item["id"], json.dumps(item), item["kind"], item["points"], index))
    connection.execute("INSERT INTO attempts VALUES(1,'oli','failed','2026-10-01T00:00:00Z','2026-10-01T01:00:00Z')")
    connection.execute("INSERT INTO attempts VALUES(2,'lukas','active','2026-10-02T00:00:00Z',NULL)")
    connection.execute("INSERT INTO kills VALUES(1,'oli','boss','2026-10-01T00:30:00Z')")
    connection.execute("INSERT INTO kills VALUES(2,'lukas','miniboss','2026-10-02T00:30:00Z')")
    connection.commit()
    tables = ["users", "sessions", "competitions", "encounters", "attempts", "kills"]
    before = {table: connection.execute(f"SELECT * FROM {table} ORDER BY rowid").fetchall() for table in tables}
    connection.close()
    migrated_settings = Settings(passwords={"lukas": "changed-env-lukas", "oli": "changed-env-oli"}, data_dir=settings.data_dir, app_origin=ORIGIN)
    if interrupt_migration:
        original_connect = sqlite3.connect

        class InterruptedConnection(sqlite3.Connection):
            def execute(self, sql, *args, **kwargs):
                result = super().execute(sql, *args, **kwargs)
                if sql == "DROP TABLE users":
                    raise RuntimeError("Simulated interrupted migration")
                return result

        with monkeypatch.context() as patch:
            patch.setattr("backend.app.sqlite3.connect", lambda *args, **kwargs: original_connect(*args, factory=InterruptedConnection, **kwargs))
            with pytest.raises(RuntimeError, match="Simulated"):
                with TestClient(create_app(migrated_settings, catalog)):
                    pass
        with original_connect(database_path) as restored:
            assert restored.execute("PRAGMA user_version").fetchone()[0] == 1
            assert {table: restored.execute(f"SELECT * FROM {table} ORDER BY rowid").fetchall() for table in tables} == before
    application = create_app(migrated_settings, catalog)
    with TestClient(application) as client:
        with application.state.db.connect() as migrated:
            assert migrated.execute("PRAGMA user_version").fetchone()[0] == 2
            assert migrated.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
            assert migrated.execute("PRAGMA foreign_key_check").fetchall() == []
            for table in tables:
                rows = [tuple(row) for row in migrated.execute(f"SELECT * FROM {table} ORDER BY rowid")]
                assert ([row[:3] for row in rows] if table == "users" else rows) == before[table]
            assert len(migrated.execute("SELECT * FROM competition_members").fetchall()) == 4
        client.cookies.set(COOKIE_NAME, legacy_token)
        assert client.get("/api/session").json()["user"]["username"] == "lukas"
        assert client.get("/api/competitions/2/attempt").json()["attempt"]["points"] == 3
        old_board = client.get("/api/competitions/1/leaderboard").json()
        assert next(player for player in old_board["players"] if player["username"] == "oli")["points"] == 5
        assert client.get("/api/admin/competitions/1/participants").json() == {"participants": ["lukas", "oli"]}
        assert add_player(client, {"X-CSRF-Token": "legacy-csrf"}).status_code == 201
    with TestClient(create_app(Settings(data_dir=settings.data_dir, app_origin=ORIGIN), catalog)) as restarted:
        restarted.cookies.set(COOKIE_NAME, legacy_token)
        assert restarted.get("/api/session").json()["user"]["username"] == "lukas"
        assert restarted.get("/api/competitions/2/attempt").json()["attempt"]["points"] == 3

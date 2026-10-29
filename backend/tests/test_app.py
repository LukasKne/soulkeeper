import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app import COOKIE_NAME, Settings, create_app, load_catalog

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


def sign_in(client, username="lukas"):
    response = client.post("/api/login", json={"username": username, "password": PASSWORDS[username]}, headers={"Origin": ORIGIN})
    assert response.status_code == 200, response.text
    return {"X-CSRF-Token": response.json()["csrf_token"], "Origin": ORIGIN}


def start(client, headers, competition_id=1):
    return client.post(f"/api/competitions/{competition_id}/attempt/start", headers=headers)


def check(client, headers, encounter_id="boss", defeated=True, competition_id=1):
    return client.put(f"/api/competitions/{competition_id}/attempt/encounters/{encounter_id}", json={"defeated": defeated}, headers=headers)


def finish(client, headers, outcome="failed", competition_id=1):
    return client.post(f"/api/competitions/{competition_id}/attempt/finish", json={"outcome": outcome}, headers=headers)


def create_next(client, headers, expected_current_id=1):
    return client.post("/api/competitions", json={"expected_current_id": expected_current_id}, headers=headers)


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


def test_password_rotation_invalidates_only_affected_account(setup):
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
        assert client.get("/api/session").json()["user"] is None


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


@pytest.mark.parametrize("passwords", [{}, {"lukas": "", "oli": "other"}, {"lukas": "same", "oli": "same"}])
def test_missing_or_identical_passwords_fail_configuration(passwords):
    with pytest.raises(ValueError):
        Settings(passwords=passwords)


def test_catalog_validation_rejects_duplicate_ids_and_wrong_points(tmp_path):
    path = tmp_path / "bad.json"
    path.write_text(json.dumps([encounter(), encounter()]))
    with pytest.raises(ValueError, match="unique"):
        load_catalog(path)
    path.write_text(json.dumps([encounter(points=99)]))
    with pytest.raises(ValueError, match="5 points"):
        load_catalog(path)

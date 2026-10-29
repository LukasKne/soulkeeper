"""Single-instance Soulkeeper API and static frontend server."""

import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import threading
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager, contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import urlsplit

from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt

USERS = ("lukas", "oli")
COOKIE_NAME = "soulkeeper_session"
SESSION_SECONDS = 7 * 24 * 60 * 60
PASSWORD_WORK = {"n": 16384, "r": 8, "p": 1, "dklen": 32}


@dataclass(frozen=True)
class Settings:
    passwords: dict[str, str] = field(repr=False)
    data_dir: Path = Path("data")
    frontend_dist: Path = Path("frontend/dist")
    app_origin: str = "http://localhost:8000"
    cookie_secure: bool = False

    def __post_init__(self):
        if set(self.passwords) != set(USERS) or not all(self.passwords.values()):
            raise ValueError("LUKAS_PASSWORD and OLI_PASSWORD must both be set")
        if self.passwords["lukas"] == self.passwords["oli"]:
            raise ValueError("LUKAS_PASSWORD and OLI_PASSWORD must be different")
        origin = urlsplit(self.app_origin)
        if (
            origin.scheme not in ("http", "https")
            or not origin.netloc
            or origin.path not in ("", "/")
            or origin.query
            or origin.fragment
            or origin.username
        ):
            raise ValueError("APP_ORIGIN must be an HTTP(S) origin without a path")

    @classmethod
    def from_env(cls):
        return cls(
            passwords={name: os.environ.get(f"{name.upper()}_PASSWORD", "") for name in USERS},
            data_dir=Path(os.environ.get("DATA_DIR", "data")),
            frontend_dist=Path(os.environ.get("FRONTEND_DIST", "frontend/dist")),
            app_origin=os.environ.get("APP_ORIGIN", "http://localhost:8000").rstrip("/"),
            cookie_secure=os.environ.get("COOKIE_SECURE", "false").lower() == "true",
        )


def now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def password_hash(password: str, salt: bytes) -> bytes:
    return hashlib.scrypt(password.encode(), salt=salt, **PASSWORD_WORK)


def load_catalog(path: Path) -> list[dict]:
    with path.open(encoding="utf-8") as source:
        catalog = json.load(source)
    if not isinstance(catalog, list) or not catalog:
        raise ValueError("The encounter catalog must be a nonempty list")
    required = {"id", "area_id", "area_name", "area_order", "name", "description", "kind", "points"}
    seen = set()
    for item in catalog:
        if not isinstance(item, dict) or not required.issubset(item):
            raise ValueError("An encounter is missing required catalog fields")
        if item["id"] in seen or not isinstance(item["id"], str) or not item["id"]:
            raise ValueError("Encounter IDs must be unique nonempty strings")
        if item["kind"] not in ("boss", "miniboss"):
            raise ValueError("Encounter kinds must be boss or miniboss")
        if item["points"] != (5 if item["kind"] == "boss" else 3):
            raise ValueError("Bosses award 5 points and minibosses award 3")
        if any(not isinstance(item[key], str) for key in ("area_id", "area_name", "name", "description")):
            raise ValueError("Encounter labels must be strings")
        if type(item["area_order"]) is not int:
            raise ValueError("Area order must be an integer")
        seen.add(item["id"])
    return catalog


class Database:
    def __init__(self, settings: Settings, catalog: list[dict]):
        settings.data_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.path = settings.data_dir / "soulkeeper.db"
        self.catalog = catalog
        with self.connect() as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            version = connection.execute("PRAGMA user_version").fetchone()[0]
            if version not in (0, 1):
                raise RuntimeError("This database requires a newer version of Soulkeeper")
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS users (
                    username TEXT PRIMARY KEY CHECK(username IN ('lukas', 'oli')),
                    password_salt BLOB NOT NULL,
                    password_hash BLOB NOT NULL
                );
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY,
                    username TEXT NOT NULL REFERENCES users(username),
                    csrf_token TEXT NOT NULL,
                    expires_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS competitions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    number INTEGER NOT NULL UNIQUE,
                    name TEXT NOT NULL,
                    status TEXT NOT NULL CHECK(status IN ('current', 'archived')),
                    created_at TEXT NOT NULL,
                    archived_at TEXT
                );
                CREATE UNIQUE INDEX IF NOT EXISTS one_current_competition
                    ON competitions(status) WHERE status = 'current';
                CREATE TABLE IF NOT EXISTS encounters (
                    competition_id INTEGER NOT NULL REFERENCES competitions(id),
                    id TEXT NOT NULL,
                    data TEXT NOT NULL,
                    kind TEXT NOT NULL CHECK(kind IN ('boss', 'miniboss')),
                    points INTEGER NOT NULL,
                    sort_order INTEGER NOT NULL,
                    PRIMARY KEY (competition_id, id)
                );
                CREATE TABLE IF NOT EXISTS attempts (
                    competition_id INTEGER NOT NULL REFERENCES competitions(id),
                    username TEXT NOT NULL REFERENCES users(username),
                    status TEXT NOT NULL CHECK(status IN ('active', 'failed', 'completed')),
                    started_at TEXT NOT NULL,
                    ended_at TEXT,
                    PRIMARY KEY (competition_id, username)
                );
                CREATE TABLE IF NOT EXISTS kills (
                    competition_id INTEGER NOT NULL,
                    username TEXT NOT NULL,
                    encounter_id TEXT NOT NULL,
                    defeated_at TEXT NOT NULL,
                    PRIMARY KEY (competition_id, username, encounter_id),
                    FOREIGN KEY (competition_id, username)
                        REFERENCES attempts(competition_id, username),
                    FOREIGN KEY (competition_id, encounter_id)
                        REFERENCES encounters(competition_id, id)
                );
                PRAGMA user_version=1;
                """
            )
        self.path.chmod(0o600)
        with self.transaction() as connection:
            for username in USERS:
                existing = connection.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
                if existing and hmac.compare_digest(
                    existing["password_hash"], password_hash(settings.passwords[username], existing["password_salt"])
                ):
                    continue
                salt = secrets.token_bytes(16)
                connection.execute(
                    "INSERT INTO users VALUES (?, ?, ?) ON CONFLICT(username) DO UPDATE SET "
                    "password_salt=excluded.password_salt, password_hash=excluded.password_hash",
                    (username, salt, password_hash(settings.passwords[username], salt)),
                )
                connection.execute("DELETE FROM sessions WHERE username=?", (username,))
            if not connection.execute("SELECT 1 FROM competitions LIMIT 1").fetchone():
                self.create_competition(connection, 1, now())

    @contextmanager
    def connect(self):
        connection = sqlite3.connect(self.path, timeout=5, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA synchronous=FULL")
        try:
            yield connection
        finally:
            connection.close()

    @contextmanager
    def transaction(self):
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                yield connection
                connection.commit()
            except BaseException:
                connection.rollback()
                raise

    def create_competition(self, connection, number: int, timestamp: str) -> int:
        competition_id = connection.execute(
            "INSERT INTO competitions(number, name, status, created_at) VALUES (?, ?, 'current', ?)",
            (number, f"Competition {number}", timestamp),
        ).lastrowid
        connection.executemany(
            "INSERT INTO encounters(competition_id, id, data, kind, points, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
            [
                (competition_id, item["id"], json.dumps(item), item["kind"], item["points"], index)
                for index, item in enumerate(sorted(self.catalog, key=lambda item: item["area_order"]))
            ],
        )
        return competition_id


def competition(connection, competition_id: int) -> dict:
    row = connection.execute("SELECT * FROM competitions WHERE id=?", (competition_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "Competition not found")
    maximum = connection.execute(
        "SELECT COALESCE(SUM(points), 0) FROM encounters WHERE competition_id=?", (competition_id,)
    ).fetchone()[0]
    return {**dict(row), "max_points": maximum}


def totals(connection, competition_id: int, username: str) -> dict:
    row = connection.execute(
        "SELECT COALESCE(SUM(e.points), 0) AS points, "
        "COALESCE(SUM(e.kind='boss'), 0) AS bosses_defeated, "
        "COALESCE(SUM(e.kind='miniboss'), 0) AS minibosses_defeated "
        "FROM kills k JOIN encounters e ON e.competition_id=k.competition_id AND e.id=k.encounter_id "
        "WHERE k.competition_id=? AND k.username=?",
        (competition_id, username),
    ).fetchone()
    return dict(row)


def attempt_view(connection, competition_id: int, username: str) -> dict:
    current_competition = competition(connection, competition_id)
    attempt = connection.execute(
        "SELECT status, started_at, ended_at FROM attempts WHERE competition_id=? AND username=?",
        (competition_id, username),
    ).fetchone()
    defeated = {
        row[0]
        for row in connection.execute(
            "SELECT encounter_id FROM kills WHERE competition_id=? AND username=?", (competition_id, username)
        )
    }
    encounters = [
        {**json.loads(row["data"]), "defeated": row["id"] in defeated}
        for row in connection.execute(
            "SELECT id, data FROM encounters WHERE competition_id=? ORDER BY sort_order", (competition_id,)
        )
    ]
    return {
        "competition": current_competition,
        "attempt": {**dict(attempt), **totals(connection, competition_id, username)} if attempt else None,
        "encounters": encounters,
    }


def ensure_current(connection, competition_id: int):
    if competition(connection, competition_id)["status"] != "current":
        raise HTTPException(409, "This competition is archived and cannot be changed")


def ensure_active(connection, competition_id: int, username: str):
    ensure_current(connection, competition_id)
    row = connection.execute(
        "SELECT * FROM attempts WHERE competition_id=? AND username=?", (competition_id, username)
    ).fetchone()
    if row is None:
        raise HTTPException(409, "Start your attempt before checking encounters")
    if row["status"] != "active":
        raise HTTPException(409, "This attempt has ended and cannot be changed")
    return row


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Login(Input):
    username: str = Field(max_length=32)
    password: str = Field(max_length=1024)


class Kill(Input):
    defeated: StrictBool


class Finish(Input):
    outcome: Literal["failed", "completed"]


class NewCompetition(Input):
    expected_current_id: StrictInt


def create_app(settings: Settings | None = None, catalog_path: Path | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(application: FastAPI):
        application.state.settings = settings or Settings.from_env()
        application.state.db = Database(
            application.state.settings, load_catalog(catalog_path or Path(__file__).with_name("catalog.json"))
        )
        application.state.login_failures = defaultdict(deque)
        application.state.login_lock = threading.Lock()
        yield

    application = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    @application.exception_handler(RequestValidationError)
    async def invalid_request(request: Request, error: RequestValidationError):
        messages = [
            f"{'.'.join(str(part) for part in item['loc'])}: {item['msg']}"
            for item in error.errors()
        ]
        return JSONResponse(status_code=422, content={"detail": "Invalid request: " + "; ".join(messages)})

    @application.middleware("http")
    async def response_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "same-origin"
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    def check_origin(request: Request):
        supplied = request.headers.get("origin")
        if supplied and supplied.rstrip("/") != request.app.state.settings.app_origin.rstrip("/"):
            raise HTTPException(403, "Request origin is not allowed")

    def session(request: Request):
        token = request.cookies.get(COOKIE_NAME)
        if not token:
            return None
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        with request.app.state.db.connect() as connection:
            row = connection.execute(
                "SELECT * FROM sessions WHERE token_hash=? AND expires_at>?", (token_hash, now())
            ).fetchone()
        return dict(row) if row else None

    def require_session(request: Request):
        authenticated = session(request)
        if authenticated is None:
            raise HTTPException(401, "Please sign in")
        return authenticated

    def require_csrf(
        request: Request,
        authenticated: Annotated[dict, Depends(require_session)],
        csrf_token: Annotated[str | None, Header(alias="X-CSRF-Token")] = None,
    ):
        check_origin(request)
        if not csrf_token or not hmac.compare_digest(csrf_token, authenticated["csrf_token"]):
            raise HTTPException(403, "Invalid CSRF token")
        return authenticated

    def session_view(authenticated):
        return {
            "user": {
                "username": authenticated["username"],
                "can_manage": authenticated["username"] == "lukas",
            } if authenticated else None,
            "csrf_token": authenticated["csrf_token"] if authenticated else None,
        }

    @application.get("/healthz")
    def health(request: Request):
        with request.app.state.db.connect() as connection:
            connection.execute("SELECT 1").fetchone()
        return {"status": "ok"}

    @application.get("/api/session")
    def get_session(request: Request):
        return session_view(session(request))

    @application.post("/api/login")
    def login(payload: Login, request: Request, response: Response):
        check_origin(request)
        address = request.client.host if request.client else "unknown"
        timestamp = time.monotonic()
        with request.app.state.login_lock:
            failures = request.app.state.login_failures[address]
            while failures and timestamp - failures[0] >= 60:
                failures.popleft()
            if len(failures) >= 5:
                raise HTTPException(429, "Too many failed sign-in attempts. Try again in a minute", headers={"Retry-After": "60"})
            # Reserve the slot before password hashing so concurrent requests
            # cannot all pass the failure limit before any of them completes.
            failures.append(timestamp)
        with request.app.state.db.connect() as connection:
            account = connection.execute("SELECT * FROM users WHERE username=?", (payload.username,)).fetchone()
        salt = account["password_salt"] if account else bytes(16)
        candidate = password_hash(payload.password, salt)
        if account is None or not hmac.compare_digest(account["password_hash"], candidate):
            raise HTTPException(401, "Incorrect username or password")
        with request.app.state.login_lock:
            request.app.state.login_failures[address].remove(timestamp)
        raw_token, csrf_token = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
        expires_at = (datetime.now(UTC) + timedelta(seconds=SESSION_SECONDS)).isoformat().replace("+00:00", "Z")
        with request.app.state.db.transaction() as connection:
            connection.execute("DELETE FROM sessions WHERE expires_at<=?", (now(),))
            existing_token = request.cookies.get(COOKIE_NAME)
            if existing_token:
                connection.execute("DELETE FROM sessions WHERE token_hash=?", (hashlib.sha256(existing_token.encode()).hexdigest(),))
            connection.execute("INSERT INTO sessions VALUES (?, ?, ?, ?)", (token_hash, payload.username, csrf_token, expires_at))
        response.set_cookie(
            COOKIE_NAME, raw_token, max_age=SESSION_SECONDS, httponly=True,
            secure=request.app.state.settings.cookie_secure, samesite="strict", path="/",
        )
        return session_view({"username": payload.username, "csrf_token": csrf_token})

    @application.post("/api/logout")
    def logout(request: Request, response: Response, authenticated: Annotated[dict, Depends(require_csrf)]):
        with request.app.state.db.transaction() as connection:
            connection.execute("DELETE FROM sessions WHERE token_hash=?", (authenticated["token_hash"],))
        response.delete_cookie(COOKIE_NAME, path="/", secure=request.app.state.settings.cookie_secure, httponly=True, samesite="strict")
        return session_view(None)

    @application.get("/api/competitions")
    def list_competitions(request: Request):
        with request.app.state.db.connect() as connection:
            connection.execute("BEGIN")
            rows = connection.execute("SELECT id, status FROM competitions ORDER BY number DESC").fetchall()
            return {
                "competitions": [competition(connection, row["id"]) for row in rows],
                "current_id": next(row["id"] for row in rows if row["status"] == "current"),
            }

    @application.get("/api/competitions/{competition_id}/leaderboard")
    def leaderboard(competition_id: int, request: Request):
        with request.app.state.db.connect() as connection:
            connection.execute("BEGIN")
            selected = competition(connection, competition_id)
            players = []
            for username in USERS:
                attempt = connection.execute(
                    "SELECT status FROM attempts WHERE competition_id=? AND username=?", (competition_id, username)
                ).fetchone()
                players.append({
                    "username": username, "attempt_status": attempt["status"] if attempt else "not_started",
                    **totals(connection, competition_id, username),
                })
            players.sort(key=lambda player: (-player["points"], USERS.index(player["username"])))
            last_points, rank = None, 0
            for index, player in enumerate(players, 1):
                if player["points"] != last_points:
                    rank = index
                player["rank"] = rank
                last_points = player["points"]
            return {"competition": selected, "players": players, "max_points": selected["max_points"]}

    @application.get("/api/competitions/{competition_id}/attempt")
    def get_attempt(competition_id: int, request: Request, authenticated: Annotated[dict, Depends(require_session)]):
        with request.app.state.db.connect() as connection:
            connection.execute("BEGIN")
            return attempt_view(connection, competition_id, authenticated["username"])

    @application.post("/api/competitions/{competition_id}/attempt/start")
    def start_attempt(competition_id: int, request: Request, authenticated: Annotated[dict, Depends(require_csrf)]):
        with request.app.state.db.transaction() as connection:
            ensure_current(connection, competition_id)
            existing = connection.execute(
                "SELECT status FROM attempts WHERE competition_id=? AND username=?", (competition_id, authenticated["username"])
            ).fetchone()
            if existing and existing["status"] != "active":
                raise HTTPException(409, "You have already used your attempt in this competition")
            if existing is None:
                connection.execute("INSERT INTO attempts VALUES (?, ?, 'active', ?, NULL)", (competition_id, authenticated["username"], now()))
            return attempt_view(connection, competition_id, authenticated["username"])

    @application.put("/api/competitions/{competition_id}/attempt/encounters/{encounter_id}")
    def set_encounter(
        competition_id: int, encounter_id: str, payload: Kill, request: Request,
        authenticated: Annotated[dict, Depends(require_csrf)],
    ):
        with request.app.state.db.transaction() as connection:
            ensure_active(connection, competition_id, authenticated["username"])
            if not connection.execute("SELECT 1 FROM encounters WHERE competition_id=? AND id=?", (competition_id, encounter_id)).fetchone():
                raise HTTPException(404, "Encounter not found")
            if payload.defeated:
                connection.execute(
                    "INSERT OR IGNORE INTO kills VALUES (?, ?, ?, ?)",
                    (competition_id, authenticated["username"], encounter_id, now()),
                )
            else:
                connection.execute("DELETE FROM kills WHERE competition_id=? AND username=? AND encounter_id=?", (competition_id, authenticated["username"], encounter_id))
            return attempt_view(connection, competition_id, authenticated["username"])

    @application.post("/api/competitions/{competition_id}/attempt/finish")
    def finish_attempt(
        competition_id: int, payload: Finish, request: Request,
        authenticated: Annotated[dict, Depends(require_csrf)],
    ):
        with request.app.state.db.transaction() as connection:
            ensure_current(connection, competition_id)
            existing = connection.execute("SELECT status FROM attempts WHERE competition_id=? AND username=?", (competition_id, authenticated["username"])).fetchone()
            if existing and existing["status"] == payload.outcome:
                return attempt_view(connection, competition_id, authenticated["username"])
            ensure_active(connection, competition_id, authenticated["username"])
            connection.execute("UPDATE attempts SET status=?, ended_at=? WHERE competition_id=? AND username=?", (payload.outcome, now(), competition_id, authenticated["username"]))
            return attempt_view(connection, competition_id, authenticated["username"])

    @application.post("/api/competitions")
    def new_competition(payload: NewCompetition, request: Request, authenticated: Annotated[dict, Depends(require_csrf)]):
        if authenticated["username"] != "lukas":
            raise HTTPException(403, "Only lukas can create a competition")
        with request.app.state.db.transaction() as connection:
            current = connection.execute("SELECT * FROM competitions WHERE status='current'").fetchone()
            if current["id"] != payload.expected_current_id:
                raise HTTPException(409, "The current competition changed. Refresh before creating another")
            timestamp = now()
            connection.execute("UPDATE competitions SET status='archived', archived_at=? WHERE id=?", (timestamp, current["id"]))
            new_id = request.app.state.db.create_competition(connection, current["number"] + 1, timestamp)
            return {"competition": competition(connection, new_id), "current_id": new_id}

    @application.get("/{path:path}")
    def frontend(path: str, request: Request):
        if path.startswith("api/") or path == "api":
            raise HTTPException(404, "Not found")
        directory = request.app.state.settings.frontend_dist.resolve()
        candidate = (directory / path).resolve()
        if candidate.is_relative_to(directory) and candidate.is_file():
            return FileResponse(candidate)
        index = directory / "index.html"
        if index.is_file():
            return FileResponse(index, headers={"Cache-Control": "no-cache"})
        raise HTTPException(404, "Frontend has not been built")

    return application


app = create_app()

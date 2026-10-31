import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from backend.app import COOKIE_NAME, Settings, create_app
from backend.tests.test_app import app, setup, sign_in, start, check, create_next, encounter, PASSWORDS, ORIGIN


def open_draft(client, headers):
    response = client.post('/api/practice', headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def mark(client, headers, draft, identifier='boss', defeated=True):
    return client.put(f'/api/practice/{draft}/encounters/{identifier}', json={'defeated': defeated}, headers=headers)


def save(client, headers, draft, outcome='died'):
    return client.post(f'/api/practice/{draft}/save', json={'outcome': outcome}, headers=headers)


def test_public_profiles_and_progress_expose_official_snapshots_without_edit_access(app):
    application, client = app
    headers = sign_in(client)
    start(client, headers); check(client, headers)
    oli = TestClient(application); oli_headers = sign_in(oli, 'oli')
    start(oli, oli_headers); check(oli, oli_headers, 'miniboss')
    public = TestClient(application)
    response = public.get('/api/competitions/1/progress')
    assert response.status_code == 200
    assert response.headers['cache-control'] == 'no-store'
    result = response.json()
    players = {p['username']: p for p in result['players']}
    assert players['lukas']['points'] == 5 and players['lukas']['defeated_ids'] == ['boss']
    assert players['oli']['points'] == 3 and players['oli']['defeated_ids'] == ['miniboss']
    assert len(result['encounters']) == 2 and 'password' not in response.text and 'csrf' not in response.text
    assert public.get('/api/competitions/1/attempt').status_code == 401
    assert public.put('/api/competitions/1/attempt/encounters/boss', json={'defeated': False}).status_code == 401
    client.post('/api/competitions', json={'expected_current_id': 1, 'participants': ['lukas']}, headers=headers)
    archived = public.get('/api/competitions/1/progress').json()
    assert archived['competition']['status'] == 'archived' and archived['players'] == result['players']
    history = public.get('/api/players/oli/runs').json()
    assert len(history['runs']) == 1 and history['runs'][0]['points'] == 3
    client.patch('/api/admin/users/oli', json={'active': False}, headers=headers)
    assert public.get('/api/players/oli/runs').json() == history
    assert public.get('/api/players/missing/runs').status_code == 404
    assert public.get('/api/competitions/999/progress').status_code == 404


def test_practice_requires_authentication_csrf_and_valid_input(app):
    _, client = app
    assert client.get('/api/practice').status_code == 401
    assert client.post('/api/practice').status_code == 401
    assert client.get('/api/practice/history').status_code == 401
    assert client.delete('/api/practice/history').status_code == 401
    headers = sign_in(client, 'oli')
    assert client.get('/api/practice').status_code == 404
    assert client.post('/api/practice').status_code == 403
    assert client.post('/api/practice', headers={**headers, 'Origin': 'https://evil.example'}).status_code == 403
    draft = open_draft(client, headers)
    assert open_draft(client, headers)['id'] == draft['id']
    assert client.get('/api/competitions/1/attempt').json()['attempt'] is None
    assert client.put(f"/api/practice/{draft['id']}/encounters/boss", json={'defeated': 'true'}, headers=headers).status_code == 422
    assert client.put(f"/api/practice/{draft['id']}/encounters/boss", json={'defeated': True, 'username': 'lukas'}, headers=headers).status_code == 422
    assert mark(client, headers, draft['id'], 'missing').status_code == 404
    assert save(client, headers, draft['id'], 'failed').status_code == 422
    for method, path, body in [('PUT', f"/api/practice/{draft['id']}/encounters/boss", {'defeated': True}), ('POST', f"/api/practice/{draft['id']}/save", {'outcome': 'died'}), ('POST', f"/api/practice/{draft['id']}/reset", None), ('DELETE', '/api/practice/history', None)]:
        assert client.request(method, path, json=body).status_code == 403


@pytest.mark.parametrize('outcome', ['died', 'ended'])
def test_practice_save_starts_fresh_and_keeps_only_saved_history(app, outcome):
    _, client = app
    headers = sign_in(client)
    start(client, headers); check(client, headers)
    official = client.get('/api/competitions/1/attempt').json()
    draft = open_draft(client, headers)
    assert mark(client, headers, draft['id']).json()['points'] == 5
    assert mark(client, headers, draft['id']).json()['points'] == 5
    assert mark(client, headers, draft['id'], 'miniboss').json()['points'] == 8
    assert mark(client, headers, draft['id'], defeated=False).json()['points'] == 3
    assert client.get('/api/practice/history').json() == {'attempts': []}
    response = save(client, headers, draft['id'], outcome)
    assert response.status_code == 200
    result = response.json()
    assert result['saved']['outcome'] == outcome and result['saved']['points'] == 3
    assert result['draft']['id'] != draft['id'] and result['draft']['points'] == 0
    assert not any(entry['defeated'] for entry in result['draft']['encounters'])
    saved = client.get('/api/practice/history/' + result['saved']['id']).json()
    assert saved['encounters'][1]['defeated'] and saved['max_points'] == 8
    assert save(client, headers, draft['id'], outcome).status_code == 409
    assert mark(client, headers, draft['id']).status_code == 409
    assert client.post(f"/api/practice/{draft['id']}/reset", headers=headers).status_code == 409
    assert len(client.get('/api/practice/history').json()['attempts']) == 1
    assert client.get('/api/competitions/1/attempt').json() == official


def test_practice_reset_discards_draft_and_history_deletion_is_owned(app):
    application, client = app
    headers = sign_in(client)
    draft = open_draft(client, headers)
    mark(client, headers, draft['id'])
    reset = client.post(f"/api/practice/{draft['id']}/reset", headers=headers).json()
    assert reset['id'] != draft['id'] and reset['points'] == 0
    assert client.get('/api/practice/history').json() == {'attempts': []}
    first = save(client, headers, reset['id']).json()
    second = save(client, headers, first['draft']['id'], 'ended').json()
    current = second['draft']; mark(client, headers, current['id'], 'miniboss')
    other = TestClient(application); other_headers = sign_in(other, 'oli')
    own = open_draft(other, other_headers)
    other_saved = save(other, other_headers, own['id']).json()['saved']
    assert mark(other, other_headers, current['id']).status_code == 409
    assert other.get('/api/practice/history/' + first['saved']['id']).status_code == 404
    assert other.delete('/api/practice/history/' + first['saved']['id'], headers=other_headers).status_code == 404
    assert client.delete('/api/practice/history/' + first['saved']['id']).status_code == 403
    assert client.delete('/api/practice/history/' + first['saved']['id'], headers=headers).json() == {'deleted': 1}
    assert client.get('/api/practice/history/' + first['saved']['id']).status_code == 404
    assert client.delete('/api/practice/history', headers=headers).json() == {'deleted': 1}
    assert client.delete('/api/practice/history', headers=headers).json() == {'deleted': 0}
    assert client.get('/api/practice').json()['points'] == 3
    assert other.get('/api/practice/history').json()['attempts'] == [other_saved]


def test_practice_survives_restart_with_its_own_catalog_snapshots(setup):
    settings, catalog = setup
    with TestClient(create_app(settings, catalog)) as client:
        headers = sign_in(client, 'oli')
        draft = open_draft(client, headers)
        mark(client, headers, draft['id'])
        saved = save(client, headers, draft['id']).json()
        mark(client, headers, saved['draft']['id'], 'miniboss')
        cookie = client.cookies.get(COOKIE_NAME)
    catalog.write_text(json.dumps([encounter(name='Renamed boss'), encounter('new-boss')]))
    with TestClient(create_app(Settings(data_dir=settings.data_dir, app_origin=ORIGIN), catalog)) as restarted:
        restarted.cookies.set(COOKIE_NAME, cookie)
        draft = restarted.get('/api/practice').json()
        assert draft['id'] == saved['draft']['id'] and draft['points'] == 3 and draft['max_points'] == 8
        historical = restarted.get('/api/practice/history/' + saved['saved']['id']).json()
        assert historical['points'] == 5 and historical['encounters'][0]['name'] == 'Boss'
        reset = restarted.post(f"/api/practice/{draft['id']}/reset", headers=headers).json()
        assert reset['max_points'] == 10 and reset['encounters'][0]['name'] == 'Renamed boss'
        assert restarted.get('/api/competitions/1/progress').json()['encounters'][0]['name'] == 'Boss'


def test_concurrent_saves_only_create_one_history_record(app):
    _, client = app
    headers = sign_in(client)
    draft = open_draft(client, headers)
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: save(client, headers, draft['id']), range(2)))
    assert sorted(response.status_code for response in responses) == [200, 409]
    assert len(client.get('/api/practice/history').json()['attempts']) == 1
    assert client.get('/api/practice').json()['id'] != draft['id']


def test_concurrent_open_returns_the_same_personal_draft(app):
    _, client = app
    headers = sign_in(client)
    with ThreadPoolExecutor(max_workers=2) as pool:
        drafts = list(pool.map(lambda _: open_draft(client, headers), range(2)))
    assert drafts[0]['id'] == drafts[1]['id']
    assert client.get('/api/practice/history').json() == {'attempts': []}


@pytest.mark.parametrize('action', ['save', 'reset'])
def test_check_racing_practice_save_or_reset_cannot_write_into_new_draft(app, action):
    _, client = app
    headers = sign_in(client)
    draft = open_draft(client, headers)
    with ThreadPoolExecutor(max_workers=2) as pool:
        checked = pool.submit(mark, client, headers, draft['id'])
        changed = pool.submit(save, client, headers, draft['id']) if action == 'save' else pool.submit(client.post, f"/api/practice/{draft['id']}/reset", headers=headers)
        checked_response, changed_response = checked.result(), changed.result()
    assert changed_response.status_code == 200 and checked_response.status_code in (200, 409)
    assert client.get('/api/practice').json()['points'] == 0
    history = client.get('/api/practice/history').json()['attempts']
    if action == 'save': assert history[0]['points'] == (5 if checked_response.status_code == 200 else 0)
    else: assert not history


@pytest.mark.parametrize('interrupt', [False, True])
def test_v2_migration_is_atomic_and_only_renames_default_names(setup, monkeypatch, interrupt):
    settings, catalog = setup
    with TestClient(create_app(settings, catalog)) as client:
        headers = sign_in(client)
        start(client, headers); check(client, headers)
        client.post('/api/competitions', json={'expected_current_id': 1, 'participants': ['lukas'], 'name': 'Our custom name'}, headers=headers)
    path = settings.data_dir / 'soulkeeper.db'
    with sqlite3.connect(path) as connection:
        connection.executescript("DROP TABLE practice_history; DROP TABLE practice_drafts; PRAGMA user_version=2; UPDATE competitions SET name='Competition 1' WHERE id=1;")
        before = {table: connection.execute(f'SELECT * FROM {table} ORDER BY rowid').fetchall() for table in ['users', 'sessions', 'encounters', 'attempts', 'kills', 'competition_members']}
    if interrupt:
        original = sqlite3.connect
        class Interrupted(sqlite3.Connection):
            def execute(self, sql, *args, **kwargs):
                result = super().execute(sql, *args, **kwargs)
                if sql.startswith("UPDATE competitions SET name='Run '"): raise RuntimeError('Interrupted run migration')
                return result
        with monkeypatch.context() as patch:
            patch.setattr('backend.app.sqlite3.connect', lambda *args, **kwargs: original(*args, factory=Interrupted, **kwargs))
            with pytest.raises(RuntimeError, match='Interrupted'):
                with TestClient(create_app(settings, catalog)): pass
        with original(path) as connection:
            assert connection.execute('PRAGMA user_version').fetchone()[0] == 2
            assert connection.execute('SELECT name FROM competitions WHERE id=1').fetchone()[0] == 'Competition 1'
            assert not connection.execute("SELECT 1 FROM sqlite_master WHERE name='practice_drafts'").fetchone()
    application = create_app(settings, catalog)
    with TestClient(application):
        with application.state.db.connect() as connection:
            assert connection.execute('PRAGMA user_version').fetchone()[0] == 3
            assert [r[0] for r in connection.execute('SELECT name FROM competitions ORDER BY id')] == ['Run 1', 'Our custom name']
            for table, rows in before.items(): assert [tuple(r) for r in connection.execute(f'SELECT * FROM {table} ORDER BY rowid')] == rows
            assert connection.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
            assert not connection.execute('PRAGMA foreign_key_check').fetchall()

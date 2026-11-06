import asyncio
import pytest
import httpx
from app.pits import SheetConfig, sheet_id, parse_rows, import_sheet

def test_wide_event_roster_blank_rows_and_sunday():
    text = '\nMatches,Mentor,418 Pit Lead,418 Pit,Mentor,436 Pit Lead,436 Pit,Mentor,9999 Pit Lead,9999 Pit,Strategy,Scouting\n0 - 6,,Akhil,Miles,Sierra,Brandt,Leo,Krish,,El Cid,Collin,Katherine\n,,,,,,,,,,,\nSunday,,,,,,,,,,,\nTime,Mentor,418 Pit Lead,418 Pit,Mentor,436 Pit Lead,436 Pit,Mentor,9999 Pit Lead,9999 Pit,Strategy,Scouting\n29 - 32,,Rider,"Sam / Ian / Zara / Max / Tai",Sierra,Mona,Evander,Brian,,Henry,Jeremiah,Lewis\n'
    rows = parse_rows(text, SheetConfig(url='').rotation_columns, 'rotations')
    assert len(rows) == 4
    assert rows[0]['lead'] == 'Akhil'
    assert rows[0]['slot1'] == 'Miles'
    assert rows[0]['slot2'] == ''  # Mentor is not a pit crew slot.
    assert rows[1]['lead'] == 'Brandt'
    assert rows[2]['day'] == 'Sunday'
    assert rows[2]['time'] == '29 - 32'
    assert rows[2]['slot5'] == 'Tai'
    assert rows[3]['slot1'] == 'Evander'

def test_wide_roster_explicit_slots_and_overflow():
    mapping = SheetConfig(url='').rotation_columns
    rows = parse_rows('Matches,418 Pit Lead,418 Pit 1,418 Pit 5\n0 - 6,Akhil,Miles,Tai', mapping, 'rotations')
    assert rows[0]['slot1'] == 'Miles'
    assert rows[0]['slot5'] == 'Tai'
    with pytest.raises(ValueError, match='more than five'):
        parse_rows('Matches,418 Pit Lead,418 Pit\n0 - 6,Akhil,"a,b,c,d,e,f"', mapping, 'rotations')

def test_sheet_link_is_constrained_to_google():
    assert sheet_id('https://docs.google.com/spreadsheets/d/event-123/edit#gid=0') == 'event-123'
    for url in ['http://localhost/a', 'https://docs.google.com.evil.test/spreadsheets/d/x']:
        with pytest.raises(ValueError): sheet_id(url)

def test_custom_headers_quotes_and_driver():
    mapping = {**SheetConfig(url='').rotation_columns, 'team': 'Robot', 'time': 'Shift', 'slot1': 'Driver', 'slot2': 'Focus / handoff'}
    rows = parse_rows('\ufeffRobot,Shift,Driver,Focus / handoff\n436,08:00–09:00,Alex,"Battery, radio"\n418,09:00–10:00,,\n999,10:00,,\n', mapping, 'rotations')
    assert len(rows) == 2
    assert rows[0]['slot1'] == 'Alex'
    assert rows[0]['slot2'] == 'Battery, radio'
    assert rows[1]['team'] == 418

def test_missing_headers_and_values_are_rejected():
    config = SheetConfig(url='')
    with pytest.raises(ValueError, match='missing column'):
        parse_rows('Team,Match\n418,Q1', config.match_columns, 'matches')
    with pytest.raises(ValueError, match='row 2'):
        parse_rows('Team,Time window\n418,', config.rotation_columns, 'rotations')
    with pytest.raises(ValueError, match='not readable'):
        parse_rows('<!doctype html><html>Sign in</html>', config.rotation_columns, 'rotations')

def test_import_fetches_both_tabs(monkeypatch):
    real_client = httpx.AsyncClient
    def handle(request):
        assert request.url.host == 'docs.google.com'
        assert request.url.params['headers'] in ('0', '1')
        csv = 'Team,Time window,1\n436,08:00,Alex' if request.url.params['sheet'] == 'Pit rotations' else 'Team,Match,Queue by,On field\n418,Q12,09:35,09:50'
        return httpx.Response(200, text=csv)
    monkeypatch.setattr(httpx, 'AsyncClient', lambda **kwargs: real_client(transport=httpx.MockTransport(handle), **kwargs))
    board = asyncio.run(import_sheet(SheetConfig(url='https://docs.google.com/spreadsheets/d/event/edit', matches_tab='Match schedule')))
    assert board['rotations'][0]['slot1'] == 'Alex'
    assert board['matches'][0]['queue'] == '09:35'
    assert board['updated_at']

def test_publish_preserves_previous_snapshot_on_failure(monkeypatch):
    import json
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.routers import pits
    values = {'pits_board': json.dumps({'rotations': [], 'matches': [], 'updated_at': 'old'})}
    monkeypatch.setattr(pits.repo, 'setting', lambda key: values.get(key, ''))
    monkeypatch.setattr(pits.repo, 'set_setting', lambda key, value: values.__setitem__(key, value))
    app = FastAPI()
    app.include_router(pits.router)
    app.dependency_overrides[pits.require_admin] = lambda: object()
    app.dependency_overrides[pits.current_scouter] = lambda: object()
    client = TestClient(app)
    async def failed(config):
        raise ValueError('Missing match header')
    monkeypatch.setattr(pits, 'import_sheet', failed)
    assert client.post('/api/admin/pits-sheet', json={'url': 'https://docs.google.com/spreadsheets/d/event'}).status_code == 400
    assert client.get('/api/pits').json()['updated_at'] == 'old'
    assert 'pits_sheet' not in values
    async def succeeded(config):
        return {'rotations': [], 'matches': [], 'updated_at': 'new'}
    monkeypatch.setattr(pits, 'import_sheet', succeeded)
    assert client.post('/api/admin/pits-sheet', json={'url': 'https://docs.google.com/spreadsheets/d/new'}).status_code == 200
    assert client.get('/api/pits').json()['updated_at'] == 'new'
    assert client.get('/api/admin/pits-sheet').json()['url'].endswith('/new')
    app.dependency_overrides.clear()
    assert client.post('/api/admin/pits-sheet', json={'url': 'https://docs.google.com/spreadsheets/d/new'}).status_code == 401

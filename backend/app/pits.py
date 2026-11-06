"""Event operations import. Also runnable: python -m app.pits SHEET_URL."""
from __future__ import annotations
import argparse
import asyncio
import csv
import io
import json
import re
from datetime import datetime, timezone
from urllib.parse import urlparse
import httpx
from pydantic import BaseModel, Field

ROTATION_FIELDS = ['team', 'time', 'lead', 'slot1', 'slot2', 'slot3', 'slot4', 'slot5']
MATCH_FIELDS = ['team', 'match', 'queue', 'field', 'station', 'partners']

class SheetConfig(BaseModel):
    url: str = Field(max_length=2048)
    rotations_tab: str = Field(default='Pit rotations', min_length=1, max_length=100)
    matches_tab: str = Field(default='', max_length=100)
    rotation_columns: dict[str, str] = Field(default_factory=lambda: dict(zip(ROTATION_FIELDS, ['Team', 'Time window', 'LEAD', '1', '2', '3', '4', '5'])))
    match_columns: dict[str, str] = Field(default_factory=lambda: dict(zip(MATCH_FIELDS, ['Team', 'Match', 'Queue by', 'On field', 'Station', 'Partners'])))

def sheet_id(url: str) -> str:
    parsed = urlparse(url.strip())
    found = re.match(r'^/spreadsheets/d/([A-Za-z0-9_-]+)(?:/|$)', parsed.path)
    if parsed.scheme != 'https' or parsed.hostname != 'docs.google.com' or not found:
        raise ValueError('Enter a Google Sheets link (https://docs.google.com/spreadsheets/d/...).')
    return found[1]

def parse_rows(text: str, mapping: dict[str, str], kind: str) -> list[dict]:
    if '<html' in text[:500].lower() or '<!doctype' in text[:500].lower():
        raise ValueError('Sheet is not readable. Enable anyone-with-link viewer access.')
    if kind == 'rotations':
        wide = parse_rotation_grid(text)
        if wide is not None:
            return wide
    reader = csv.DictReader(io.StringIO(text.lstrip('\ufeff')))
    headers = {h.strip().casefold(): h for h in (reader.fieldnames or [])}
    required = ['team', 'time'] if kind == 'rotations' else ['team', 'match', 'queue', 'field']
    for key in required:
        if mapping.get(key, '').strip().casefold() not in headers:
            raise ValueError(f'{kind}: missing column "{mapping.get(key, key)}". Check column mappings.')
    rows = []
    for number, source in enumerate(reader, 2):
        if number > 5002:
            raise ValueError('Sheet has more than 5,000 rows.')
        if not any(str(v or '').strip() for v in source.values()):
            continue
        row = {key: str(source.get(headers.get(label.strip().casefold(), ''), '') or '').strip()[:500] for key, label in mapping.items()}
        if row.get('team') not in ('418', '436'):
            continue
        if any(not row.get(key) for key in required):
            raise ValueError(f'{kind}: row {number} is missing a required value.')
        row['team'] = int(row['team'])
        rows.append(row)
    return rows

def parse_rotation_grid(text: str) -> list[dict] | None:
    """Read the team's wide roster without losing duplicate or empty headers."""
    records = list(csv.reader(io.StringIO(text.lstrip('\ufeff'))))
    if len(records) > 5002:
        raise ValueError('Sheet has more than 5,000 rows.')
    header = None
    day = ''
    result = []
    for cells in records:
        cells = [value.strip() for value in cells]
        if not any(cells):
            continue
        normalized = [re.sub(r'\s+', ' ', value).casefold() for value in cells]
        if '418 pit lead' in normalized or '436 pit lead' in normalized:
            header = normalized
            continue
        if re.fullmatch(r'(monday|tuesday|wednesday|thursday|friday|saturday|sunday)(\b.*)?', cells[0], re.I):
            day = cells[0]
            continue
        if header is None:
            continue
        # Blank spacer rows and repeated Matches/Time headers are not shifts.
        window = cells[0]
        if not window or window.casefold() in ('time', 'matches'):
            continue
        def value(label):
            index = header.index(label) if label in header else -1
            return cells[index] if 0 <= index < len(cells) else ''
        for team in (418, 436):
            lead = value(f'{team} pit lead')
            crew = [name.strip() for name in re.split(r'[,;/\n]+', value(f'{team} pit')) if name.strip()]
            # Optional explicit columns allow one name per cell as well.
            slots = [value(f'{team} pit {n}') for n in range(1, 6)]
            if not any(slots):
                if len(crew) > 5:
                    raise ValueError(f'{team}, {window}: more than five pit members. Use at most five names.')
                slots = crew + [''] * (5 - len(crew))
            if lead or any(slots):
                result.append({'team': team, 'time': window, 'day': day, 'lead': lead,
                               **{f'slot{n}': name for n, name in enumerate(slots, 1)}})
    return result if header is not None else None

async def import_sheet(config: SheetConfig) -> dict:
    ident = sheet_id(config.url)
    async with httpx.AsyncClient(timeout=20, follow_redirects=False) as client:
        async def read(tab, mapping, kind):
            response = await client.get(f'https://docs.google.com/spreadsheets/d/{ident}/gviz/tq', params={'tqx': 'out:csv', 'sheet': tab, 'headers': '0' if kind == 'rotations' else '1'})
            if response.status_code != 200:
                raise ValueError(f'Cannot read "{tab}". Check the tab name and anyone-with-link viewer access.')
            if len(response.content) > 2_000_000:
                raise ValueError('Sheet is too large (maximum 2 MB per tab).')
            return parse_rows(response.text, mapping, kind)
        async def match_rows():
            return await read(config.matches_tab, config.match_columns, 'matches') if config.matches_tab.strip() else []
        rotations, matches = await asyncio.gather(read(config.rotations_tab, config.rotation_columns, 'rotations'), match_rows())
    return {'rotations': rotations, 'matches': matches, 'updated_at': datetime.now(timezone.utc).isoformat()}

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('url')
    parser.add_argument('--rotations-tab', default='Pit rotations')
    parser.add_argument('--matches-tab', default='')
    args = parser.parse_args()
    print(json.dumps(asyncio.run(import_sheet(SheetConfig(**vars(args)))), indent=2))

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

ROTATION_FIELDS = ['team', 'time', 'lead', 'mechanical', 'electrical', 'runner', 'driver', 'handoff']
MATCH_FIELDS = ['team', 'match', 'queue', 'field', 'station', 'partners']

class SheetConfig(BaseModel):
    url: str = Field(max_length=2048)
    rotations_tab: str = Field(default='Pit rotations', min_length=1, max_length=100)
    matches_tab: str = Field(default='Match schedule', min_length=1, max_length=100)
    rotation_columns: dict[str, str] = Field(default_factory=lambda: dict(zip(ROTATION_FIELDS, ['Team', 'Time window', 'Pit lead', 'Mechanical', 'Electrical', 'Runner', 'Driver', 'Focus / handoff'])))
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

async def import_sheet(config: SheetConfig) -> dict:
    ident = sheet_id(config.url)
    async with httpx.AsyncClient(timeout=20, follow_redirects=False) as client:
        async def read(tab, mapping, kind):
            response = await client.get(f'https://docs.google.com/spreadsheets/d/{ident}/gviz/tq', params={'tqx': 'out:csv', 'sheet': tab, 'headers': '1'})
            if response.status_code != 200:
                raise ValueError(f'Cannot read "{tab}". Check the tab name and anyone-with-link viewer access.')
            if len(response.content) > 2_000_000:
                raise ValueError('Sheet is too large (maximum 2 MB per tab).')
            return parse_rows(response.text, mapping, kind)
        rotations, matches = await asyncio.gather(read(config.rotations_tab, config.rotation_columns, 'rotations'), read(config.matches_tab, config.match_columns, 'matches'))
    return {'rotations': rotations, 'matches': matches, 'updated_at': datetime.now(timezone.utc).isoformat()}

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('url')
    parser.add_argument('--rotations-tab', default='Pit rotations')
    parser.add_argument('--matches-tab', default='Match schedule')
    args = parser.parse_args()
    print(json.dumps(asyncio.run(import_sheet(SheetConfig(**vars(args)))), indent=2))

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import Optional
from pathlib import Path
import sqlite3, io
import base64
import json
import mimetypes
import os
import sys
import tempfile
import threading
import time
import urllib.parse
import uuid
import webbrowser
from datetime import date, datetime, timezone
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas as pdfcanvas
from reportlab.lib.colors import HexColor

BASE = Path(__file__).resolve().parent
DB = Path.home() / 'basketball.db' if sys.platform == 'android' else BASE / 'basketball.db'
app = FastAPI(title='Basketball Stat Tracker')
SHARE_FILES = {}

SCHEMA = '''
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS seasons(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    start_date TEXT,
    end_date TEXT,
    is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS players(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    jersey_number INTEGER,
    position TEXT,
    height TEXT,
    weight INTEGER,
    graduation_year INTEGER,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS opponents(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS locations(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS users(
    id INTEGER PRIMARY KEY CHECK(id = 1),
    display_name TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    photo_data TEXT NOT NULL DEFAULT '',
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS games(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    season_id INTEGER NOT NULL,
    opponent TEXT NOT NULL,
    game_date TEXT NOT NULL,
    location TEXT,
    team_level TEXT,
    status TEXT NOT NULL DEFAULT 'live',
    team_score INTEGER NOT NULL DEFAULT 0,
    opponent_score INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(season_id) REFERENCES seasons(id)
);

CREATE TABLE IF NOT EXISTS game_players(
    game_id INTEGER NOT NULL,
    player_id INTEGER NOT NULL,
    PRIMARY KEY(game_id, player_id),
    FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE,
    FOREIGN KEY(player_id) REFERENCES players(id)
);

CREATE TABLE IF NOT EXISTS shots(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER NOT NULL,
    player_id INTEGER NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    made INTEGER NOT NULL,
    is_three INTEGER NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE,
    FOREIGN KEY(player_id) REFERENCES players(id)
);

CREATE TABLE IF NOT EXISTS stat_events(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER NOT NULL,
    player_id INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    value INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE,
    FOREIGN KEY(player_id) REFERENCES players(id)
);

CREATE TABLE IF NOT EXISTS game_periods(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER NOT NULL,
    period_type TEXT NOT NULL CHECK(period_type IN ('quarter','half')),
    period_number INTEGER NOT NULL,
    elapsed_seconds REAL NOT NULL DEFAULT 0,
    is_running INTEGER NOT NULL DEFAULT 0,
    started_at TEXT,
    UNIQUE(game_id, period_type, period_number),
    FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS minute_entries(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER NOT NULL,
    period_id INTEGER NOT NULL,
    player_id INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE,
    FOREIGN KEY(period_id) REFERENCES game_periods(id) ON DELETE CASCADE,
    FOREIGN KEY(player_id) REFERENCES players(id)
);
'''


def conn():
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    c.execute('PRAGMA foreign_keys=ON')
    return c


def init_db():
    with conn() as c:
        c.executescript(SCHEMA)

        if not c.execute('SELECT 1 FROM seasons LIMIT 1').fetchone():
            y = date.today().year
            c.execute(
                'INSERT INTO seasons(name,start_date,end_date,is_active) VALUES(?,?,?,1)',
                (f'{y}-{y+1}', f'{y}-08-01', f'{y+1}-07-31')
            )

        # Backfill opponents/locations from any existing games
        for r in c.execute('SELECT DISTINCT opponent FROM games WHERE opponent IS NOT NULL').fetchall():
            c.execute('INSERT OR IGNORE INTO opponents(name) VALUES(?)', (r['opponent'],))

        for r in c.execute("SELECT DISTINCT location FROM games WHERE location IS NOT NULL AND location != ''").fetchall():
            c.execute('INSERT OR IGNORE INTO locations(name) VALUES(?)', (r['location'],))


init_db()


class UserIn(BaseModel):
    display_name: str = ''
    email: str = ''
    phone: str = ''
    photo_data: str = ''


class SeasonIn(BaseModel):
    name: str
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    is_active: bool = True


class PlayerIn(BaseModel):
    first_name: str
    last_name: str
    jersey_number: Optional[int] = None
    position: Optional[str] = None
    height: Optional[str] = None
    weight: Optional[int] = None
    graduation_year: Optional[int] = None
    is_active: bool = True


class NameIn(BaseModel):
    name: str


class GameIn(BaseModel):
    season_id: int
    opponent: str
    game_date: str
    location: Optional[str] = None
    team_level: Optional[str] = None
    player_ids: list[int] = []


class GameUpdate(BaseModel):
    status: Optional[str] = None
    team_score: Optional[int] = None
    opponent_score: Optional[int] = None


class GameEditIn(BaseModel):
    season_id: int
    opponent: str
    game_date: str
    location: Optional[str] = None
    team_level: Optional[str] = None
    status: str = 'live'
    team_score: int = 0
    opponent_score: int = 0
    player_ids: list[int] = []


class GameDuplicateIn(BaseModel):
    game_date: Optional[str] = None


class GamePlayerIn(BaseModel):
    player_id: int


class ShotIn(BaseModel):
    game_id: int
    player_id: int
    x: float
    y: float
    made: bool
    is_three: bool


class EventIn(BaseModel):
    game_id: int
    player_id: int
    event_type: str
    value: int = 1


class MinutesPeriodIn(BaseModel):
    period_type: str
    period_number: int
    action: str


class MinutesPlayerIn(BaseModel):
    player_id: int


def rows(q, p=()):
    with conn() as c:
        return [dict(x) for x in c.execute(q, p).fetchall()]


def row(q, p=()):
    with conn() as c:
        x = c.execute(q, p).fetchone()
        return dict(x) if x else None


def utc_now():
    return datetime.now(timezone.utc)


def parse_utc(value):
    return datetime.fromisoformat(value).astimezone(timezone.utc)


def period_elapsed(period, now=None):
    elapsed = float(period['elapsed_seconds'])
    if period['is_running'] and period['started_at']:
        current = now or utc_now()
        elapsed += max(0, (current - parse_utc(period['started_at'])).total_seconds())
    return elapsed


def close_period(c, period, now):
    if not period or not period['is_running']:
        return period
    elapsed = period_elapsed(period, now)
    c.execute(
        'UPDATE game_periods SET elapsed_seconds=?,is_running=0,started_at=NULL WHERE id=?',
        (elapsed, period['id'])
    )
    c.execute(
        'UPDATE minute_entries SET ended_at=? WHERE period_id=? AND ended_at IS NULL',
        (now.isoformat(), period['id'])
    )
    return dict(c.execute('SELECT * FROM game_periods WHERE id=?', (period['id'],)).fetchone())


def minutes_payload(gid, period_type, period_number):
    game = row('SELECT id FROM games WHERE id=?', (gid,))
    if not game:
        raise HTTPException(404, 'Game not found')

    period = row(
        'SELECT * FROM game_periods WHERE game_id=? AND period_type=? AND period_number=?',
        (gid, period_type, period_number)
    )
    periods = rows(
        'SELECT * FROM game_periods WHERE game_id=? ORDER BY period_type,period_number',
        (gid,)
    )
    now = utc_now()
    players = rows(
        'SELECT p.id,p.first_name,p.last_name,p.jersey_number FROM players p '
        'JOIN game_players gp ON gp.player_id=p.id WHERE gp.game_id=? ORDER BY p.jersey_number',
        (gid,)
    )
    for player in players:
        entries = rows(
            'SELECT started_at,ended_at FROM minute_entries WHERE game_id=? AND period_id=? AND player_id=?',
            (gid, period['id'] if period else -1, player['id'])
        )
        player['seconds'] = sum(
            max(0, ((parse_utc(entry['ended_at']) if entry['ended_at'] else now) - parse_utc(entry['started_at'])).total_seconds())
            for entry in entries
        )
        player['on_court'] = bool(entries and entries[-1]['ended_at'] is None)

    return {
        'period_type': period_type,
        'period_number': period_number,
        'period': {
            'elapsed_seconds': period_elapsed(period, now) if period else 0,
            'is_running': bool(period and period['is_running'])
        },
        'periods': periods,
        'players': players
    }


def player_minutes_totals(game_ids):
    if not game_ids:
        return {}

    placeholders = ','.join('?' * len(game_ids))
    entries = rows(
        f'SELECT player_id,started_at,ended_at FROM minute_entries '
        f'WHERE game_id IN ({placeholders})',
        game_ids
    )
    now = utc_now()
    totals = {}
    for entry in entries:
        ended_at = parse_utc(entry['ended_at']) if entry['ended_at'] else now
        seconds = max(0, (ended_at - parse_utc(entry['started_at'])).total_seconds())
        totals[entry['player_id']] = totals.get(entry['player_id'], 0) + seconds
    return totals


def format_report_minutes(seconds):
    total_seconds = max(0, int(seconds))
    return f'{total_seconds // 60}:{total_seconds % 60:02d}'


def event_totals(player_id, game_id=None):
    q = 'SELECT event_type,COALESCE(SUM(value),0) total FROM stat_events WHERE player_id=?'
    p = [player_id]
    if game_id is not None:
        q += ' AND game_id=?'
        p.append(game_id)
    q += ' GROUP BY event_type'
    return {r['event_type']: r['total'] for r in rows(q, p)}


def calculate_player(player_id, game_id=None):
    q = 'SELECT * FROM shots WHERE player_id=?'
    p = [player_id]
    if game_id is not None:
        q += ' AND game_id=?'
        p.append(game_id)
    ss = rows(q, p)
    ev = event_totals(player_id, game_id)

    fgm = sum(x['made'] for x in ss)
    fga = len(ss)
    tpm = sum(x['made'] and x['is_three'] for x in ss)
    tpa = sum(x['is_three'] for x in ss)
    ftm = ev.get('ft_made', 0)
    fta = ftm + ev.get('ft_missed', 0)

    return {
        'pts': 2 * (fgm - tpm) + 3 * tpm + ftm,
        'fgm': fgm, 'fga': fga,
        'fg_pct': round(100 * fgm / fga, 1) if fga else 0,
        'tpm': tpm, 'tpa': tpa,
        'tp_pct': round(100 * tpm / tpa, 1) if tpa else 0,
        'ftm': ftm, 'fta': fta,
        'ft_pct': round(100 * ftm / fta, 1) if fta else 0,
        'ast': ev.get('assist', 0),
        'to': ev.get('turnover', 0),
        'stl': ev.get('steal', 0),
        'oreb': ev.get('oreb', 0),
        'dreb': ev.get('dreb', 0),
        'blk': ev.get('block', 0)
    }


# ---------------- Seasons ----------------

@app.get('/api/seasons')
def seasons():
    return rows('SELECT * FROM seasons ORDER BY start_date DESC,id DESC')


@app.post('/api/seasons')
def add_season(x: SeasonIn):
    try:
        with conn() as c:
            cur = c.execute(
                'INSERT INTO seasons(name,start_date,end_date,is_active) VALUES(?,?,?,?)',
                (x.name, x.start_date, x.end_date, int(x.is_active))
            )
            sid = cur.lastrowid
    except sqlite3.IntegrityError:
        raise HTTPException(400, 'Season name already exists')
    return row('SELECT * FROM seasons WHERE id=?', (sid,))


@app.put('/api/seasons/{sid}')
def edit_season(sid: int, x: SeasonIn):
    if not row('SELECT id FROM seasons WHERE id=?', (sid,)):
        raise HTTPException(404, 'Season not found')
    try:
        with conn() as c:
            c.execute(
                'UPDATE seasons SET name=?,start_date=?,end_date=?,is_active=? WHERE id=?',
                (x.name, x.start_date, x.end_date, int(x.is_active), sid)
            )
    except sqlite3.IntegrityError:
        raise HTTPException(400, 'Season name already exists')
    return row('SELECT * FROM seasons WHERE id=?', (sid,))


@app.delete('/api/seasons/{sid}')
def delete_season(sid: int):
    if not row('SELECT id FROM seasons WHERE id=?', (sid,)):
        raise HTTPException(404, 'Season not found')
    try:
        with conn() as c:
            c.execute('DELETE FROM seasons WHERE id=?', (sid,))
    except sqlite3.IntegrityError:
        raise HTTPException(409, 'Season has games and cannot be deleted')
    return {'ok': True}


# ---------------- User profile ----------------

@app.get('/api/user')
def user_profile():
    profile = row('SELECT * FROM users WHERE id=1')
    return profile or {
        'id': 1,
        'display_name': '',
        'email': '',
        'phone': '',
        'photo_data': ''
    }


@app.put('/api/user')
def update_user_profile(user: UserIn):
    with conn() as c:
        c.execute(
            '''
            INSERT INTO users(id,display_name,email,phone,photo_data,updated_at)
            VALUES(1,?,?,?,?,CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET
                display_name=excluded.display_name,
                email=excluded.email,
                phone=excluded.phone,
                photo_data=excluded.photo_data,
                updated_at=CURRENT_TIMESTAMP
            ''',
            (user.display_name.strip(), user.email.strip(), user.phone.strip(), user.photo_data)
        )
    return row('SELECT * FROM users WHERE id=1')


# ---------------- Players ----------------

@app.get('/api/players')
def players():
    return rows('SELECT * FROM players ORDER BY is_active DESC,last_name,first_name')


@app.post('/api/players')
def add_player(x: PlayerIn):
    with conn() as c:
        cur = c.execute(
            'INSERT INTO players(first_name,last_name,jersey_number,position,height,weight,graduation_year,is_active) VALUES(?,?,?,?,?,?,?,?)',
            (x.first_name, x.last_name, x.jersey_number, x.position, x.height, x.weight, x.graduation_year, int(x.is_active))
        )
        pid = cur.lastrowid
    return row('SELECT * FROM players WHERE id=?', (pid,))


@app.put('/api/players/{pid}')
def edit_player(pid: int, x: PlayerIn):
    if not row('SELECT id FROM players WHERE id=?', (pid,)):
        raise HTTPException(404, 'Player not found')
    with conn() as c:
        c.execute(
            'UPDATE players SET first_name=?,last_name=?,jersey_number=?,position=?,height=?,weight=?,graduation_year=?,is_active=? WHERE id=?',
            (x.first_name, x.last_name, x.jersey_number, x.position, x.height, x.weight, x.graduation_year, int(x.is_active), pid)
        )
    return row('SELECT * FROM players WHERE id=?', (pid,))


@app.delete('/api/players/{pid}')
def delete_player(pid: int):
    if not row('SELECT id FROM players WHERE id=?', (pid,)):
        raise HTTPException(404, 'Player not found')
    try:
        with conn() as c:
            c.execute('DELETE FROM players WHERE id=?', (pid,))
    except sqlite3.IntegrityError:
        raise HTTPException(409, 'Player has game history; mark inactive instead')
    return {'ok': True}


# ---------------- Opponents ----------------

@app.get('/api/opponents')
def list_opponents():
    return rows('''
        SELECT o.id, o.name,
            (SELECT COUNT(*) FROM games g WHERE g.opponent = o.name) AS game_count
        FROM opponents o
        ORDER BY o.name
    ''')


@app.post('/api/opponents')
def add_opponent(x: NameIn):
    name = x.name.strip()
    if not name:
        raise HTTPException(400, 'Opponent name is required')
    try:
        with conn() as c:
            c.execute('INSERT INTO opponents(name) VALUES(?)', (name,))
    except sqlite3.IntegrityError:
        pass
    return row('SELECT * FROM opponents WHERE name=?', (name,))


@app.put('/api/opponents/{oid}')
def edit_opponent(oid: int, x: NameIn):
    name = x.name.strip()
    if not name:
        raise HTTPException(400, 'Opponent name is required')

    existing = row('SELECT * FROM opponents WHERE id=?', (oid,))
    if not existing:
        raise HTTPException(404, 'Opponent not found')

    try:
        with conn() as c:
            c.execute('UPDATE opponents SET name=? WHERE id=?', (name, oid))
            # Keep historical games in sync with the renamed opponent
            c.execute('UPDATE games SET opponent=? WHERE opponent=?', (name, existing['name']))
    except sqlite3.IntegrityError:
        raise HTTPException(400, 'An opponent with that name already exists')

    return row('SELECT * FROM opponents WHERE id=?', (oid,))


@app.delete('/api/opponents/{oid}')
def delete_opponent(oid: int):
    if not row('SELECT id FROM opponents WHERE id=?', (oid,)):
        raise HTTPException(404, 'Opponent not found')
    with conn() as c:
        c.execute('DELETE FROM opponents WHERE id=?', (oid,))
    return {'ok': True}


# ---------------- Locations ----------------

@app.get('/api/locations')
def list_locations():
    return rows('''
        SELECT l.id, l.name,
            (SELECT COUNT(*) FROM games g WHERE g.location = l.name) AS game_count
        FROM locations l
        ORDER BY l.name
    ''')


@app.post('/api/locations')
def add_location(x: NameIn):
    name = x.name.strip()
    if not name:
        raise HTTPException(400, 'Location name is required')
    try:
        with conn() as c:
            c.execute('INSERT INTO locations(name) VALUES(?)', (name,))
    except sqlite3.IntegrityError:
        pass
    return row('SELECT * FROM locations WHERE name=?', (name,))


@app.put('/api/locations/{lid}')
def edit_location(lid: int, x: NameIn):
    name = x.name.strip()
    if not name:
        raise HTTPException(400, 'Location name is required')

    existing = row('SELECT * FROM locations WHERE id=?', (lid,))
    if not existing:
        raise HTTPException(404, 'Location not found')

    try:
        with conn() as c:
            c.execute('UPDATE locations SET name=? WHERE id=?', (name, lid))
            c.execute('UPDATE games SET location=? WHERE location=?', (name, existing['name']))
    except sqlite3.IntegrityError:
        raise HTTPException(400, 'A location with that name already exists')

    return row('SELECT * FROM locations WHERE id=?', (lid,))


@app.delete('/api/locations/{lid}')
def delete_location(lid: int):
    if not row('SELECT id FROM locations WHERE id=?', (lid,)):
        raise HTTPException(404, 'Location not found')
    with conn() as c:
        c.execute('DELETE FROM locations WHERE id=?', (lid,))
    return {'ok': True}


# ---------------- Games ----------------

@app.get('/api/games')
def games():
    return rows('SELECT g.*,s.name season_name FROM games g JOIN seasons s ON s.id=g.season_id ORDER BY game_date DESC,g.id DESC')


@app.post('/api/games')
def add_game(x: GameIn):
    with conn() as c:
        c.execute('INSERT OR IGNORE INTO opponents(name) VALUES(?)', (x.opponent.strip(),))
        if x.location:
            c.execute('INSERT OR IGNORE INTO locations(name) VALUES(?)', (x.location.strip(),))

        cur = c.execute(
            'INSERT INTO games(season_id,opponent,game_date,location,team_level) VALUES(?,?,?,?,?)',
            (x.season_id, x.opponent, x.game_date, x.location, x.team_level)
        )
        gid = cur.lastrowid
        c.executemany(
            'INSERT OR IGNORE INTO game_players(game_id,player_id) VALUES(?,?)',
            [(gid, p) for p in x.player_ids]
        )
    return row('SELECT * FROM games WHERE id=?', (gid,))


@app.put('/api/games/{gid}')
def update_game(gid: int, x: GameUpdate):
    old = row('SELECT * FROM games WHERE id=?', (gid,))
    if not old:
        raise HTTPException(404, 'Game not found')
    with conn() as c:
        c.execute(
            'UPDATE games SET status=?,team_score=?,opponent_score=? WHERE id=?',
            (
                x.status or old['status'],
                x.team_score if x.team_score is not None else old['team_score'],
                x.opponent_score if x.opponent_score is not None else old['opponent_score'],
                gid
            )
        )
    return row('SELECT * FROM games WHERE id=?', (gid,))


@app.put('/api/games/{gid}/details')
def edit_game_details(gid: int, data: GameEditIn):
    existing = row('SELECT id FROM games WHERE id=?', (gid,))
    if not existing:
        raise HTTPException(404, 'Game not found')

    with conn() as c:
        c.execute('INSERT OR IGNORE INTO opponents(name) VALUES(?)', (data.opponent.strip(),))
        if data.location:
            c.execute('INSERT OR IGNORE INTO locations(name) VALUES(?)', (data.location.strip(),))

        c.execute(
            '''
            UPDATE games
            SET season_id=?, opponent=?, game_date=?, location=?,
                team_level=?, status=?, team_score=?, opponent_score=?
            WHERE id=?
            ''',
            (
                data.season_id, data.opponent, data.game_date, data.location,
                data.team_level, data.status, data.team_score,
                data.opponent_score, gid
            )
        )

        c.execute('DELETE FROM game_players WHERE game_id=?', (gid,))
        c.executemany(
            'INSERT OR IGNORE INTO game_players(game_id,player_id) VALUES(?,?)',
            [(gid, pid) for pid in data.player_ids]
        )

    return row(
        'SELECT g.*, s.name AS season_name FROM games g JOIN seasons s ON s.id=g.season_id WHERE g.id=?',
        (gid,)
    )


@app.post('/api/games/{gid}/duplicate')
def duplicate_game(gid: int, data: GameDuplicateIn):
    original = row('SELECT * FROM games WHERE id=?', (gid,))
    if not original:
        raise HTTPException(404, 'Game not found')

    duplicate_date = data.game_date if data.game_date else original['game_date']

    with conn() as c:
        cur = c.execute(
            '''
            INSERT INTO games(season_id,opponent,game_date,location,team_level,status,team_score,opponent_score)
            VALUES(?,?,?,?,?, 'live', 0, 0)
            ''',
            (original['season_id'], original['opponent'], duplicate_date, original['location'], original['team_level'])
        )
        new_gid = cur.lastrowid

        players_ = c.execute('SELECT player_id FROM game_players WHERE game_id=?', (gid,)).fetchall()
        c.executemany(
            'INSERT INTO game_players(game_id,player_id) VALUES(?,?)',
            [(new_gid, p['player_id']) for p in players_]
        )

    return row(
        'SELECT g.*, s.name AS season_name FROM games g JOIN seasons s ON s.id=g.season_id WHERE g.id=?',
        (new_gid,)
    )


@app.delete('/api/games/{gid}')
def delete_game(gid: int):
    existing = row('SELECT id FROM games WHERE id=?', (gid,))
    if not existing:
        raise HTTPException(404, 'Game not found')

    with conn() as c:
        c.execute('DELETE FROM shots WHERE game_id=?', (gid,))
        c.execute('DELETE FROM stat_events WHERE game_id=?', (gid,))
        c.execute('DELETE FROM game_players WHERE game_id=?', (gid,))
        c.execute('DELETE FROM games WHERE id=?', (gid,))

    return {'ok': True, 'deleted_game_id': gid}


@app.get('/api/games/{gid}')
def game(gid: int):
    g = row('SELECT g.*,s.name season_name FROM games g JOIN seasons s ON s.id=g.season_id WHERE g.id=?', (gid,))
    if not g:
        raise HTTPException(404, 'Game not found')
    ps = rows('SELECT p.* FROM players p JOIN game_players gp ON gp.player_id=p.id WHERE gp.game_id=? ORDER BY p.jersey_number', (gid,))
    for p in ps:
        p['stats'] = calculate_player(p['id'], gid)
    g['players'] = ps
    g['shots'] = rows('SELECT * FROM shots WHERE game_id=? ORDER BY id', (gid,))
    return g


@app.post('/api/games/{gid}/players')
def add_game_player(gid: int, data: GamePlayerIn):
    if not row('SELECT id FROM games WHERE id=?', (gid,)):
        raise HTTPException(404, 'Game not found')
    if not row('SELECT id FROM players WHERE id=?', (data.player_id,)):
        raise HTTPException(404, 'Player not found')

    with conn() as c:
        c.execute(
            'INSERT OR IGNORE INTO game_players(game_id,player_id) VALUES(?,?)',
            (gid, data.player_id)
        )

    return {'ok': True, 'game_id': gid, 'player_id': data.player_id}


# ---------------- Minutes ----------------

@app.get('/api/games/{gid}/minutes')
def get_minutes(gid: int, period_type: str = 'quarter', period_number: int = 1):
    return minutes_payload(gid, period_type, period_number)


@app.post('/api/games/{gid}/minutes/period')
def update_minutes_period(gid: int, data: MinutesPeriodIn):
    if data.period_type not in {'quarter', 'half'}:
        raise HTTPException(400, 'Period type must be quarter or half')
    max_period = 4 if data.period_type == 'quarter' else 2
    if data.period_number < 1 or data.period_number > max_period:
        raise HTTPException(400, 'Invalid period number')
    if data.action not in {'start', 'pause', 'reset'}:
        raise HTTPException(400, 'Invalid period action')
    if not row('SELECT id FROM games WHERE id=?', (gid,)):
        raise HTTPException(404, 'Game not found')

    now = utc_now()
    with conn() as c:
        period = c.execute(
            'SELECT * FROM game_periods WHERE game_id=? AND period_type=? AND period_number=?',
            (gid, data.period_type, data.period_number)
        ).fetchone()

        if data.action == 'reset':
            if period:
                close_period(c, period, now)
                c.execute('DELETE FROM minute_entries WHERE period_id=?', (period['id'],))
                c.execute(
                    'UPDATE game_periods SET elapsed_seconds=0,is_running=0,started_at=NULL WHERE id=?',
                    (period['id'],)
                )
        else:
            if not period:
                cursor = c.execute(
                    'INSERT INTO game_periods(game_id,period_type,period_number) VALUES(?,?,?)',
                    (gid, data.period_type, data.period_number)
                )
                period = c.execute('SELECT * FROM game_periods WHERE id=?', (cursor.lastrowid,)).fetchone()

            if data.action == 'start' and not period['is_running']:
                for active in c.execute('SELECT * FROM game_periods WHERE game_id=? AND is_running=1', (gid,)).fetchall():
                    close_period(c, active, now)
                c.execute(
                    'UPDATE game_periods SET is_running=1,started_at=? WHERE id=?',
                    (now.isoformat(), period['id'])
                )
            elif data.action == 'pause':
                close_period(c, period, now)

    return minutes_payload(gid, data.period_type, data.period_number)


@app.post('/api/games/{gid}/minutes/player')
def toggle_minutes_player(gid: int, data: MinutesPlayerIn, period_type: str = 'quarter', period_number: int = 1):
    period = row(
        'SELECT * FROM game_periods WHERE game_id=? AND period_type=? AND period_number=?',
        (gid, period_type, period_number)
    )
    if not period or not period['is_running']:
        raise HTTPException(400, 'Start the current period before changing players')
    if not row('SELECT 1 FROM game_players WHERE game_id=? AND player_id=?', (gid, data.player_id)):
        raise HTTPException(400, 'Player is not assigned to this game')

    now = utc_now()
    with conn() as c:
        active = c.execute(
            'SELECT id FROM minute_entries WHERE period_id=? AND player_id=? AND ended_at IS NULL ORDER BY id DESC LIMIT 1',
            (period['id'], data.player_id)
        ).fetchone()
        if active:
            c.execute('UPDATE minute_entries SET ended_at=? WHERE id=?', (now.isoformat(), active['id']))
        else:
            c.execute(
                'INSERT INTO minute_entries(game_id,period_id,player_id,started_at) VALUES(?,?,?,?)',
                (gid, period['id'], data.player_id, now.isoformat())
            )

    return minutes_payload(gid, period_type, period_number)


# ---------------- Shots & Events ----------------

@app.post('/api/shots')
def add_shot(x: ShotIn):
    with conn() as c:
        cur = c.execute(
            'INSERT INTO shots(game_id,player_id,x,y,made,is_three) VALUES(?,?,?,?,?,?)',
            (x.game_id, x.player_id, x.x, x.y, int(x.made), int(x.is_three))
        )
        sid = cur.lastrowid
    return row('SELECT * FROM shots WHERE id=?', (sid,))


@app.delete('/api/shots/{sid}')
def delete_shot(sid: int):
    with conn() as c:
        c.execute('DELETE FROM shots WHERE id=?', (sid,))
    return {'ok': True}


@app.delete('/api/games/{gid}/shots')
def clear_shots(gid: int, player_id: int):
    with conn() as c:
        c.execute('DELETE FROM shots WHERE game_id=? AND player_id=?', (gid, player_id))
    return {'ok': True}


@app.post('/api/events')
def add_event(x: EventIn):
    allowed = {'ft_made', 'ft_missed', 'assist', 'steal', 'oreb', 'dreb', 'turnover', 'block'}
    if x.event_type not in allowed:
        raise HTTPException(400, 'Invalid event type')
    with conn() as c:
        cur = c.execute(
            'INSERT INTO stat_events(game_id,player_id,event_type,value) VALUES(?,?,?,?)',
            (x.game_id, x.player_id, x.event_type, x.value)
        )
        eid = cur.lastrowid
    return row('SELECT * FROM stat_events WHERE id=?', (eid,))


@app.delete('/api/events/latest')
def remove_latest_event(game_id: int, player_id: int):
    with conn() as c:
        r = c.execute(
            'SELECT id FROM stat_events WHERE game_id=? AND player_id=? ORDER BY id DESC LIMIT 1',
            (game_id, player_id)
        ).fetchone()
        if r:
            c.execute('DELETE FROM stat_events WHERE id=?', (r['id'],))
    return {'ok': True}


# ---------------- Player Stats ----------------

@app.get('/api/players/{pid}/stats')
def player_stats(pid: int, season_id: Optional[int] = None):
    p = row('SELECT * FROM players WHERE id=?', (pid,))
    if not p:
        raise HTTPException(404, 'Player not found')

    game_ids = None
    if season_id is not None:
        game_ids = [x['id'] for x in rows('SELECT id FROM games WHERE season_id=?', (season_id,))]

    shots = rows(
        'SELECT s.*,g.game_date,g.opponent,g.season_id FROM shots s JOIN games g ON g.id=s.game_id WHERE s.player_id=? ORDER BY s.id',
        (pid,)
    )
    if game_ids is not None:
        shots = [s for s in shots if s['game_id'] in game_ids]

    overall = calculate_player(pid)

    if season_id is not None:
        ss = shots
        fgm = sum(s['made'] for s in ss)
        fga = len(ss)
        tpm = sum(s['made'] and s['is_three'] for s in ss)
        tpa = sum(s['is_three'] for s in ss)

        gids = [x['id'] for x in rows(
            '''
            SELECT DISTINCT g.id FROM games g
            LEFT JOIN stat_events e ON e.game_id=g.id
            WHERE g.season_id=? AND (e.player_id=? OR EXISTS(
                SELECT 1 FROM shots s WHERE s.game_id=g.id AND s.player_id=?
            ))
            ''',
            (season_id, pid, pid)
        )]

        ev = {}
        if gids:
            placeholders = ','.join('?' * len(gids))
            er = rows(
                f'SELECT event_type,SUM(value) total FROM stat_events WHERE player_id=? AND game_id IN ({placeholders}) GROUP BY event_type',
                [pid, *gids]
            )
            ev = {x['event_type']: x['total'] for x in er}

        ftm = ev.get('ft_made', 0)
        fta = ftm + ev.get('ft_missed', 0)

        overall = {
            'pts': 2 * (fgm - tpm) + 3 * tpm + ftm,
            'fgm': fgm, 'fga': fga,
            'fg_pct': round(100 * fgm / fga, 1) if fga else 0,
            'tpm': tpm, 'tpa': tpa,
            'tp_pct': round(100 * tpm / tpa, 1) if tpa else 0,
            'ftm': ftm, 'fta': fta,
            'ft_pct': round(100 * ftm / fta, 1) if fta else 0,
            'ast': ev.get('assist', 0),
            'to': ev.get('turnover', 0),
            'stl': ev.get('steal', 0),
            'oreb': ev.get('oreb', 0),
            'dreb': ev.get('dreb', 0),
            'blk': ev.get('block', 0)
        }

    game_log = []
    q = '''
        SELECT DISTINCT g.id,g.game_date,g.opponent FROM games g
        LEFT JOIN shots s ON s.game_id=g.id
        LEFT JOIN stat_events e ON e.game_id=g.id
        WHERE (s.player_id=? OR e.player_id=?)
    '''
    pr = [pid, pid]
    if season_id is not None:
        q += ' AND g.season_id=?'
        pr.append(season_id)
    q += ' ORDER BY g.game_date DESC'

    for g in rows(q, pr):
        g['stats'] = calculate_player(pid, g['id'])
        game_log.append(g)

    return {
        'player': p,
        'summary': overall,
        'games_played': len(game_log),
        'game_log': game_log,
        'shots': shots
    }


# ---------------- PDF Reports ----------------

@app.get('/api/games/{gid}/report.pdf')
def report(gid: int):
    g = game(gid)
    minutes = player_minutes_totals([gid])
    buf = io.BytesIO()
    c = pdfcanvas.Canvas(buf, pagesize=letter)
    w, h = letter

    c.setFillColor(HexColor('#f59e0b'))
    c.rect(0, h - 72, w, 72, fill=1, stroke=0)
    c.setFillColorRGB(0, 0, 0)
    c.setFont('Helvetica-Bold', 20)
    c.drawString(36, h - 45, 'Basketball Game Report')

    c.setFont('Helvetica-Bold', 15)
    c.drawString(36, h - 105, f"vs {g['opponent']}")

    c.setFont('Helvetica', 10)
    c.drawString(36, h - 122, f"{g['game_date']}  |  {g.get('location') or 'Location not set'}  |  Season {g['season_name']}")
    c.drawString(36, h - 138, f"Score: {g['team_score']} - {g['opponent_score']}   Status: {g['status']}")

    y = h - 180
    c.setFont('Helvetica-Bold', 9)
    heads = ['Player', 'MIN', 'PTS', 'FG', '3PT', 'FT', 'AST', 'REB', 'STL', 'BLK', 'TO']
    xs = [36, 150, 185, 220, 260, 300, 340, 375, 415, 455, 495]
    for x, t in zip(xs, heads):
        c.drawString(x, y, t)
    y -= 14
    c.line(36, y + 8, 558, y + 8)

    for p in g['players']:
        st = p['stats']
        vals = [
            f"#{p.get('jersey_number') or ''} {p['first_name']} {p['last_name']}",
            format_report_minutes(minutes.get(p['id'], 0)), st['pts'],
            f"{st['fgm']}/{st['fga']}", f"{st['tpm']}/{st['tpa']}", f"{st['ftm']}/{st['fta']}",
            st['ast'], st['oreb'] + st['dreb'], st['stl'], st['blk'], st['to']
        ]
        c.setFont('Helvetica', 8)
        for x, t in zip(xs, vals):
            c.drawString(x, y, str(t))
        y -= 15
        if y < 72:
            c.showPage()
            y = h - 50

    c.setFont('Helvetica-Oblique', 8)
    c.drawString(36, 32, 'Generated by Basketball Stat Tracker')
    c.save()
    buf.seek(0)

    return StreamingResponse(
        buf, media_type='application/pdf',
        headers={'Content-Disposition': f'attachment; filename="game-{gid}-report.pdf"'}
    )


@app.get('/api/seasons/{sid}/report.pdf')
def season_report(sid: int):
    season = row('SELECT * FROM seasons WHERE id=?', (sid,))
    if not season:
        raise HTTPException(404, 'Season not found')

    season_games = rows('SELECT * FROM games WHERE season_id=? ORDER BY game_date', (sid,))

    wins = sum(1 for g in season_games if g['status'] == 'final' and g['team_score'] > g['opponent_score'])
    losses = sum(1 for g in season_games if g['status'] == 'final' and g['team_score'] < g['opponent_score'])

    game_ids = [g['id'] for g in season_games]
    minutes = player_minutes_totals(game_ids)

    buf = io.BytesIO()
    c = pdfcanvas.Canvas(buf, pagesize=letter)
    w, h = letter

    def draw_header(title_line):
        c.setFillColor(HexColor('#f59e0b'))
        c.rect(0, h - 72, w, 72, fill=1, stroke=0)
        c.setFillColorRGB(0, 0, 0)
        c.setFont('Helvetica-Bold', 20)
        c.drawString(36, h - 45, 'Season Summary Report')
        c.setFont('Helvetica-Bold', 12)
        c.drawString(36, h - 62, title_line)

    draw_header(season['name'])

    c.setFont('Helvetica', 10)
    c.drawString(36, h - 122, f"{season.get('start_date') or ''} to {season.get('end_date') or ''}")
    c.drawString(36, h - 138, f"Record: {wins}-{losses}   Games played: {len(season_games)}")

    y = h - 168
    c.setFont('Helvetica-Bold', 11)
    c.drawString(36, y, 'Game Results')
    y -= 16

    c.setFont('Helvetica-Bold', 9)
    game_heads = ['Date', 'Opponent', 'Location', 'Score', 'Result']
    game_xs = [36, 120, 260, 380, 460]
    for x, t in zip(game_xs, game_heads):
        c.drawString(x, y, t)
    y -= 12
    c.line(36, y + 8, 540, y + 8)
    c.setFont('Helvetica', 8)

    if not season_games:
        y -= 15
        c.drawString(36, y, 'No games recorded for this season.')
        y -= 10
    else:
        for g in season_games:
            if g['status'] == 'final':
                if g['team_score'] > g['opponent_score']:
                    result = 'W'
                elif g['team_score'] < g['opponent_score']:
                    result = 'L'
                else:
                    result = 'T'
            else:
                result = g['status'].capitalize()

            score = f"{g['team_score']} - {g['opponent_score']}"
            row_vals = [g['game_date'], g['opponent'], g.get('location') or '', score, result]

            for x, t in zip(game_xs, row_vals):
                c.drawString(x, y, str(t))
            y -= 14

            if y < 72:
                c.showPage()
                draw_header(season['name'])
                y = h - 100
                c.setFont('Helvetica', 8)

    y -= 20
    if y < 120:
        c.showPage()
        draw_header(season['name'])
        y = h - 100

    c.setFont('Helvetica-Bold', 11)
    c.drawString(36, y, 'Player Season Totals')
    y -= 18

    c.setFont('Helvetica-Bold', 9)
    heads = ['Player', 'GP', 'MIN', 'PTS', 'FG', '3PT', 'FT', 'AST', 'REB', 'STL', 'BLK', 'TO']
    xs = [36, 145, 175, 215, 250, 290, 330, 370, 405, 445, 480, 515]
    for x, t in zip(xs, heads):
        c.drawString(x, y, t)
    y -= 14
    c.line(36, y + 8, 558, y + 8)
    c.setFont('Helvetica', 8)

    for player in players():
        if not game_ids:
            continue

        placeholders = ','.join('?' * len(game_ids))
        played = rows(
            f'''
            SELECT DISTINCT g.id FROM games g
            LEFT JOIN shots s ON s.game_id=g.id
            LEFT JOIN stat_events e ON e.game_id=g.id
            LEFT JOIN minute_entries m ON m.game_id=g.id
            WHERE g.id IN ({placeholders}) AND (s.player_id=? OR e.player_id=? OR m.player_id=?)
            ''',
            [*game_ids, player['id'], player['id'], player['id']]
        )

        if not played:
            continue

        totals = {'pts': 0, 'fgm': 0, 'fga': 0, 'tpm': 0, 'tpa': 0, 'ftm': 0, 'fta': 0,
                  'ast': 0, 'reb': 0, 'stl': 0, 'blk': 0, 'to': 0}

        for g in played:
            st = calculate_player(player['id'], g['id'])
            totals['pts'] += st['pts']
            totals['fgm'] += st['fgm']
            totals['fga'] += st['fga']
            totals['tpm'] += st['tpm']
            totals['tpa'] += st['tpa']
            totals['ftm'] += st['ftm']
            totals['fta'] += st['fta']
            totals['ast'] += st['ast']
            totals['reb'] += st['oreb'] + st['dreb']
            totals['stl'] += st['stl']
            totals['blk'] += st['blk']
            totals['to'] += st['to']

        vals = [
            f"#{player.get('jersey_number') or ''} {player['first_name']} {player['last_name']}",
            len(played), format_report_minutes(minutes.get(player['id'], 0)), totals['pts'],
            f"{totals['fgm']}/{totals['fga']}",
            f"{totals['tpm']}/{totals['tpa']}", f"{totals['ftm']}/{totals['fta']}",
            totals['ast'], totals['reb'], totals['stl'], totals['blk'], totals['to']
        ]

        for x, t in zip(xs, vals):
            c.drawString(x, y, str(t))
        y -= 15

        if y < 72:
            c.showPage()
            draw_header(season['name'])
            y = h - 100
            c.setFont('Helvetica', 8)

    c.setFont('Helvetica-Oblique', 8)
    c.drawString(36, 32, 'Generated by Basketball Stat Tracker')
    c.save()
    buf.seek(0)

    filename = f"season-{sid}-summary.pdf"
    return StreamingResponse(
        buf, media_type='application/pdf',
        headers={'Content-Disposition': f'attachment; filename="{filename}"'}
    )


app.mount('/static', StaticFiles(directory=BASE / 'static'), name='static')


@app.get('/')
def home():
    return FileResponse(BASE / 'static' / 'index.html')


@app.get('/api/backup')
def backup_database():
    temporary_file = tempfile.NamedTemporaryFile(
        prefix='basketball-backup-', suffix='.db', delete=False
    )
    temporary_file.close()

    source = conn()
    destination = sqlite3.connect(temporary_file.name)
    try:
        source.backup(destination)
        destination.close()
        source.close()
        with open(temporary_file.name, 'rb') as backup_file:
            backup = backup_file.read()
    except Exception:
        destination.close()
        source.close()
        os.unlink(temporary_file.name)
        raise
    finally:
        if os.path.exists(temporary_file.name):
            os.unlink(temporary_file.name)

    return Response(
        content=backup,
        media_type='application/x-sqlite3',
        headers={'Content-Disposition': 'attachment; filename="basketball-backup.db"'}
    )


@app.post('/api/restore')
async def restore_database(request: Request):
    temporary_file = tempfile.NamedTemporaryFile(
        prefix='basketball-restore-', suffix='.db', dir=DB.parent, delete=False
    )
    temporary_file.close()

    try:
        with open(temporary_file.name, 'wb') as restore_file:
            restore_file.write(await request.body())

        restored_database = sqlite3.connect(temporary_file.name)
        try:
            integrity = restored_database.execute('PRAGMA integrity_check').fetchone()[0]
            tables = {
                result[0]
                for result in restored_database.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                )
            }
        finally:
            restored_database.close()

        required_tables = {
            'seasons', 'players', 'games', 'game_players', 'shots', 'stat_events',
            'game_periods', 'minute_entries'
        }
        if integrity != 'ok' or not required_tables <= tables:
            return JSONResponse(
                status_code=400,
                content={'detail': 'The selected file is not a valid Basketball Stat Tracker backup'}
            )

        os.replace(temporary_file.name, DB)
    except (OSError, sqlite3.DatabaseError) as error:
        return JSONResponse(
            status_code=400,
            content={'detail': f'Could not restore database: {error}'}
        )
    finally:
        if os.path.exists(temporary_file.name):
            os.unlink(temporary_file.name)

    return {'ok': True}


@app.post('/api/share-image')
async def share_image(request: Request):
    payload = await request.json()
    image_data = payload.get('data', '')
    filename = Path(payload.get('filename', 'shot-chart.png')).name
    if ',' not in image_data:
        raise HTTPException(400, 'Invalid image data')

    try:
        image_bytes = base64.b64decode(image_data.split(',', 1)[1])
    except (ValueError, TypeError):
        raise HTTPException(400, 'Invalid image data')

    token = uuid.uuid4().hex
    image_path = Path.home() / f'.basketball-share-{token}-{filename}'
    image_path.write_bytes(image_bytes)
    SHARE_FILES[token] = (image_path, 'image/png')
    return {'url': f'/api/share-image/open?token={token}'}


@app.post('/api/share-file')
async def share_file(request: Request):
    payload = await request.json()
    encoded_data = payload.get('data', '')
    filename = Path(payload.get('filename', 'shared-file')).name
    content_type = payload.get('content_type', 'application/octet-stream')
    action = payload.get('action', 'share')
    if ',' not in encoded_data:
        raise HTTPException(400, 'Invalid file data')

    try:
        file_bytes = base64.b64decode(encoded_data.split(',', 1)[1])
    except (ValueError, TypeError):
        raise HTTPException(400, 'Invalid file data')

    token = uuid.uuid4().hex
    file_path = Path.home() / f'.basketball-share-{token}-{filename}'
    file_path.write_bytes(file_bytes)
    SHARE_FILES[token] = (file_path, content_type)
    return {'url': f'/api/share-image/open?token={token}&action={action}'}


@app.get('/api/share-image/open')
def open_share_image():
    return Response(status_code=204)


@app.get('/api/profile-photo/pick')
def open_profile_photo_picker():
    return Response(status_code=204)


def main():
    import toga
    import uvicorn

    class BasketballStatTracker(toga.App):
        def startup(self):
            config = uvicorn.Config(
                app,
                host='127.0.0.1',
                port=0,
                log_level='warning'
            )
            self.server = uvicorn.Server(config)
            self.server_thread = threading.Thread(
                target=self.server.run,
                name='basketball-api',
                daemon=True
            )
            self.server_thread.start()

            while not self.server.started:
                if not self.server_thread.is_alive():
                    raise RuntimeError('The local API server could not start')
                time.sleep(0.01)

            self.main_window = toga.MainWindow(self.formal_name)
            if sys.platform == 'android':
                # Toga's MainWindow deliberately leaves the native support
                # action bar visible (teal, from the app theme); the framework
                # getActionBar() returns null under AppCompat, so it must be
                # hidden through Toga's own hook. The web UI already renders
                # its own top bar, hamburger menu and bottom navigation, so
                # the native bar is redundant.
                try:
                    self.main_window._impl.show_actionbar(False)
                except Exception:
                    try:
                        support_bar = self._impl.native.getSupportActionBar()
                        if support_bar is not None:
                            support_bar.hide()
                    except Exception:
                        pass

                # Match the system bars to the app's light theme.
                from android.graphics import Color
                from android.view import View
                window = self._impl.native.getWindow()
                window.setStatusBarColor(Color.parseColor('#2468ef'))
                window.setNavigationBarColor(Color.parseColor('#ffffff'))
                try:
                    window.getDecorView().setSystemUiVisibility(
                        View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
                    )
                except Exception:
                    pass
            self.main_window.content = toga.WebView(
                url=f'http://127.0.0.1:{self.server.servers[0].sockets[0].getsockname()[1]}/?native_shell=android'
            )
            self.main_window.content.on_navigation_starting = self.handle_navigation

            self.main_window.show()

        def handle_navigation(self, widget, url):
            parsed_url = urllib.parse.urlparse(url)

            if parsed_url.path == '/api/profile-photo/pick':
                self.pick_profile_photo()
                return False

            if parsed_url.path == '/api/open-github':
                webbrowser.open('https://github.com/alrobe3/Basketball-Individual-Stat-Keeper')
                return False

            if parsed_url.path != '/api/share-image/open':
                return True

            try:
                token = urllib.parse.parse_qs(parsed_url.query).get('token', [None])[0]
                action = urllib.parse.parse_qs(parsed_url.query).get('action', ['share'])[0]
                share_file = SHARE_FILES.pop(token, None)
                if share_file is None:
                    raise RuntimeError('The share image expired; try again')
                image_path, content_type = share_file

                from android.content import Intent
                from androidx.core.content import FileProvider
                from java.io import File

                context = self._impl.native.getApplicationContext()
                shared_dir = File(context.getCacheDir(), 'shared')
                shared_dir.mkdirs()
                shared_file = File(shared_dir, image_path.name)
                image_path.replace(Path(str(shared_file.getAbsolutePath())))
                image_uri = FileProvider.getUriForFile(
                    context,
                    f'{context.getPackageName()}.fileprovider',
                    shared_file
                )

                intent = Intent(Intent.ACTION_VIEW if action == 'view' else Intent.ACTION_SEND)
                intent.setType(content_type)
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                intent.setDataAndType(image_uri, content_type)
                if action != 'view':
                    intent.putExtra(Intent.EXTRA_STREAM, image_uri)
                chooser_title = 'Preview PDF' if action == 'view' else 'Share Shot Chart'
                chooser = Intent.createChooser(intent, chooser_title)
                self._impl.native.startActivity(chooser)
            except Exception as error:
                message = json.dumps(f'Share failed: {error}')
                self.main_window.content.evaluate_javascript(f'toast({message})')
            return False

        def pick_profile_photo(self):
            """Launch Android's native image picker.

            The embedded Android WebView doesn't implement onShowFileChooser,
            so the HTML <input type="file"> picker used by the web build can't
            open here. Instead, the profile page navigates to a sentinel URL
            that we intercept in handle_navigation, and we open a native
            picker via an Android Intent.
            """
            try:
                from android.content import Intent

                intent = Intent(Intent.ACTION_GET_CONTENT)
                intent.setType('image/*')
                intent.addCategory(Intent.CATEGORY_OPENABLE)
                self._impl.start_activity(intent, on_complete=self.profile_photo_picked)
            except Exception as error:
                message = json.dumps(f'Could not open photo picker: {error}')
                self.main_window.content.evaluate_javascript(f'toast({message})')

        def profile_photo_picked(self, result_code, data):
            try:
                from android.app import Activity

                if result_code != Activity.RESULT_OK or data is None:
                    return

                image_uri = data.getData()
                if image_uri is None:
                    return

                from java.io import ByteArrayOutputStream

                context = self._impl.native.getApplicationContext()
                resolver = context.getContentResolver()
                mime_type = (
                    resolver.getType(image_uri)
                    or mimetypes.guess_type(str(image_uri))[0]
                    or 'image/jpeg'
                )

                input_stream = resolver.openInputStream(image_uri)
                output_stream = ByteArrayOutputStream()
                chunk = bytearray(8192)
                bytes_read = input_stream.read(chunk)
                while bytes_read != -1:
                    output_stream.write(chunk, 0, bytes_read)
                    bytes_read = input_stream.read(chunk)
                input_stream.close()

                encoded = base64.b64encode(bytes(output_stream.toByteArray())).decode('ascii')
                data_url = f'data:{mime_type};base64,{encoded}'
                message = json.dumps(data_url)
                self.main_window.content.evaluate_javascript(
                    f'setProfilePhotoFromNative({message})'
                )
            except Exception as error:
                message = json.dumps(f'Could not load the selected photo: {error}')
                self.main_window.content.evaluate_javascript(f'toast({message})')

        def on_exit(self):
            if getattr(self, 'server', None):
                self.server.should_exit = True
            if getattr(self, 'server_thread', None):
                self.server_thread.join(timeout=2)
            return True

    BasketballStatTracker(
        'Basketball Stat Tracker',
        'com.basketballstattracker.app'
    ).main_loop()


if __name__ == '__main__':
    main()

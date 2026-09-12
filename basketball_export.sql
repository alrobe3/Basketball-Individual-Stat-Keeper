BEGIN TRANSACTION;
CREATE TABLE game_players(
    game_id INTEGER NOT NULL,
    player_id INTEGER NOT NULL,
    PRIMARY KEY(game_id, player_id),
    FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE,
    FOREIGN KEY(player_id) REFERENCES players(id)
);
INSERT INTO "game_players" VALUES(1,1);
CREATE TABLE games(
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
INSERT INTO "games" VALUES(1,1,'Eastside High Shool','2026-09-04','Away','Varsity','final',0,0,'2026-09-04 19:51:07');
CREATE TABLE locations(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
);
INSERT INTO "locations" VALUES(1,'Home');
INSERT INTO "locations" VALUES(2,'Away');
CREATE TABLE opponents(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
);
INSERT INTO "opponents" VALUES(1,'Greenville Highschool');
INSERT INTO "opponents" VALUES(2,'Eastside High Shool');
CREATE TABLE players(
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
INSERT INTO "players" VALUES(1,'Sarah','Roberts',2,'G','5''4"',125,2029,1,'2026-09-04 19:51:38');
CREATE TABLE seasons(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    start_date TEXT,
    end_date TEXT,
    is_active INTEGER NOT NULL DEFAULT 1
);
INSERT INTO "seasons" VALUES(1,'2026-2027','2026-08-01','2027-07-31',1);
CREATE TABLE shots(
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
INSERT INTO "shots" VALUES(7,1,1,7.171717171717171268e-01,5.407642114096385955e-01,1,1,'2026-09-04 19:57:59');
INSERT INTO "shots" VALUES(8,1,1,6.363636363636363535e-01,1.750075958157906176e-01,1,0,'2026-09-04 19:58:02');
INSERT INTO "shots" VALUES(9,1,1,2.693602693602693555e-01,5.287266519090815242e-01,0,1,'2026-09-04 19:58:05');
CREATE TABLE stat_events(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER NOT NULL,
    player_id INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    value INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE,
    FOREIGN KEY(player_id) REFERENCES players(id)
);
INSERT INTO "stat_events" VALUES(1,1,1,'oreb',1,'2026-09-04 19:56:35');
INSERT INTO "stat_events" VALUES(2,1,1,'block',1,'2026-09-04 19:56:36');
INSERT INTO "stat_events" VALUES(3,1,1,'turnover',1,'2026-09-04 19:56:53');
INSERT INTO "stat_events" VALUES(4,1,1,'assist',1,'2026-09-04 19:56:54');
INSERT INTO "stat_events" VALUES(5,1,1,'assist',1,'2026-09-04 19:56:55');
INSERT INTO "stat_events" VALUES(6,1,1,'dreb',1,'2026-09-04 19:56:55');
INSERT INTO "stat_events" VALUES(7,1,1,'block',1,'2026-09-04 19:56:56');
INSERT INTO "stat_events" VALUES(8,1,1,'ft_made',1,'2026-09-04 19:58:24');
INSERT INTO "stat_events" VALUES(9,1,1,'ft_made',1,'2026-09-04 19:58:31');
INSERT INTO "stat_events" VALUES(10,1,1,'ft_made',1,'2026-09-04 19:58:32');
INSERT INTO "stat_events" VALUES(11,1,1,'ft_missed',1,'2026-09-04 19:58:33');
DELETE FROM "sqlite_sequence";
INSERT INTO "sqlite_sequence" VALUES('seasons',1);
INSERT INTO "sqlite_sequence" VALUES('locations',4);
INSERT INTO "sqlite_sequence" VALUES('opponents',4);
INSERT INTO "sqlite_sequence" VALUES('games',1);
INSERT INTO "sqlite_sequence" VALUES('players',1);
INSERT INTO "sqlite_sequence" VALUES('shots',11);
INSERT INTO "sqlite_sequence" VALUES('stat_events',11);
COMMIT;

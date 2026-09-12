# Basketball Stat Tracker

Toga desktop app with a FastAPI/SQLite backend and embedded WebView covering season management,
player management, opponents/locations reference data, game management
(active/previous/edit/duplicate/delete/export), live game tracking with a
shot chart, player statistics with shot maps and heat maps, and PDF game and
season reports.

## Run

```bash
python -m venv .venv

# Windows
.venv\Scripts\activate

# macOS/Linux
source .venv/bin/activate

pip install -r requirements.txt
python app.py
```

The Toga desktop window opens automatically. The SQLite database
(`basketball.db`) is created automatically on first run in the project folder.

The FastAPI server runs on a local ephemeral port inside the Toga process, so
there is no separate browser server to start. To run only the API during
development, use `uvicorn app:app --reload` and open the browser URL yourself.

## Android packaging

Install Briefcase in the project environment, then create and build the
Android project:

```bash
python -m pip install -r requirements.txt
briefcase create android
briefcase build android
briefcase run android
```

The Android build uses Toga's native Android WebView. The local FastAPI server
runs inside the app, and the database is stored in Android's writable app data
directory. An Android SDK, Java, and either an emulator or USB-debuggable
device are required for `briefcase build` and `briefcase run`.

For desktop development, `python app.py` still opens the same tracker in a
Toga window. On Windows, install the WebView2 runtime if it is not already
present.

## Screens

- **Live** — select/create a game, select a player, tap the court to record
  shots, and log free throws, assists, steals, rebounds, turnovers, and
  blocks in real time.
- **Players** — add, edit, activate/deactivate players.
- **Seasons** — add, edit, activate/deactivate seasons. The active season
  banner shows which season is currently selected as active.
- **Opponents/Locations** — manage the reusable list of opponent teams and
  venues used by the New Game and Edit Game dropdowns. Renaming an
  opponent/location here also updates the name on every past game that used it.
- **Games** — Game Management screen with Active Games / Previous Games /
  All Games filters, plus Open, Edit, Duplicate, Delete, and Export PDF
  actions per game.
- **Stats** — player season totals, shooting splits, game log, shot map,
  and heat map, filterable by season.
- **Reports** — per-game PDF reports, filterable by season, plus a full
  Season Summary PDF (team record, every game's result, and every player's
  season totals).

## Notes

- A shot is automatically classified as a 2-pointer or 3-pointer based on
  its court coordinates; use the **Pending: Auto/Override** toggle before
  saving if the automatic classification is wrong for a corner/edge shot.
- Deleting a game also deletes its shots and recorded stat events.
- Deleting an opponent or location from the reference list does **not**
  change the opponent/location text stored on past games — it only removes
  it from the dropdown's saved list going forward.
- This build was verified with a Python syntax check, a JavaScript syntax
  check, an HTML tag-balance check, a cross-check that every DOM ID used in
  `app.js` exists in `index.html`, a cross-check that every `onclick`/
  `onchange` handler in `index.html` has a matching function in `app.js`,
  and a standalone SQLite logic test of the scoring/stat calculations,
  opponent rename cascade, game duplication, and game deletion cascade.

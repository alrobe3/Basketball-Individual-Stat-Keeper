const S = {
    players: [],
    seasons: [],
    games: [],
    opponents: [],
    locations: [],
    user: { display_name: '', email: '', phone: '', photo_data: '' },
    game: null,
    playerId: null,
    pending: null,
    override: null,
    selectedShotId: null,
    addingPlayerToNewGame: false,
    opponentSelectAfterSave: null,
    locationSelectAfterSave: null,
    shotPressTimer: null,
    lastTap: null,
    poll: null,
    gameManagementFilter: 'active',
    pdfPreview: null,
    minutes: {
        running: false,
        elapsed: 0,
        lastTick: null,
        timer: null,
        players: {},
        periodType: 'quarter',
        periodNumber: 1
    }
};

const ADD_NEW_VALUE = '__add_new__';

// Set on the initial WebView URL by the Toga Android app (app.py) so the
// UI can tell it's running inside the packaged app rather than a browser.
const NATIVE_APP = new URLSearchParams(window.location.search).get('native_shell') === 'android';

const $ = id => document.getElementById(id);

async function api(url, opt = {}) {
    sync('Syncing…');

    const r = await fetch(url, {
        headers: { 'Content-Type': 'application/json' },
        ...opt
    });

    if (!r.ok) {
        let d;
        try { d = await r.json(); } catch { }
        sync('Error');
        throw new Error(d?.detail || 'Request failed');
    }

    sync('Saved');
    return r.status === 204 ? null : r.json();
}

function sync(t) {
    $('syncStatus').textContent = t;
}

function toast(t) {
    $('toast').textContent = t;
    $('toast').style.display = 'block';
    setTimeout(() => $('toast').style.display = 'none', 2200);
}

function openModal(id) {
    $(id).classList.add('open');
}

// The app is packaged as a bare Android WebView (see app.py), which does not
// implement window.confirm/prompt dialogs. These modal-based helpers replace
// them so confirmation and text-entry flows work both in the browser and the
// packaged app.
let _confirmResolver = null;

function showConfirm(message, { okText = 'Confirm', danger = true } = {}) {
    return new Promise(resolve => {
        _confirmResolver = resolve;
        $('confirmModalMessage').textContent = message;
        $('confirmModalOk').textContent = okText;
        $('confirmModalOk').className = danger ? 'btn danger' : 'btn primary';
        openModal('confirmModal');
    });
}

function resolveConfirmModal(result) {
    closeModal('confirmModal');
    const resolve = _confirmResolver;
    _confirmResolver = null;
    if (resolve) resolve(result);
}

let _promptResolver = null;

function showPrompt(message, defaultValue = '') {
    return new Promise(resolve => {
        _promptResolver = resolve;
        $('promptModalMessage').textContent = message;
        $('promptModalInput').value = defaultValue ?? '';
        openModal('promptModal');
        setTimeout(() => $('promptModalInput').focus(), 50);
    });
}

function resolvePromptModal(confirmed) {
    const value = confirmed ? $('promptModalInput').value : null;
    closeModal('promptModal');
    const resolve = _promptResolver;
    _promptResolver = null;
    if (resolve) resolve(value);
}

async function backupDatabase() {
    try {
        sync('Preparing backup…');
        const response = await fetch('/api/backup');
        if (!response.ok) {
            throw new Error('Backup failed');
        }

        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'basketball-backup.db';
        link.click();
        URL.revokeObjectURL(url);
        closeModal('settingsModal');
        sync('Saved');
        toast('Database backup downloaded');
    } catch (error) {
        sync('Error');
        toast(error.message);
    }
}

function selectDatabaseBackup() {
    $('databaseBackupFile').click();
}

async function restoreDatabase(file) {
    if (!file) {
        return;
    }
    if (!await showConfirm('Restore this backup? Current data will be replaced.')) {
        return;
    }

    try {
        sync('Restoring…');
        const response = await fetch('/api/restore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-sqlite3' },
            body: file
        });
        if (!response.ok) {
            const detail = await response.json().catch(() => ({}));
            throw new Error(detail.detail || 'Restore failed');
        }

        sync('Restored');
        toast('Database restored');
        setTimeout(() => window.location.reload(), 600);
    } catch (error) {
        sync('Error');
        toast(error.message);
    } finally {
        $('databaseBackupFile').value = '';
    }
}

function closeModal(id) {
    $(id).classList.remove('open');
    if (id === 'shotDeleteModal' || id === 'shotResultModal') {
        const card = $(id).querySelector('.modal-card');
        card.classList.remove('shot-delete-card', 'arrow-top', 'arrow-bottom');
        card.style.position = '';
        card.style.left = '';
        card.style.top = '';
        card.style.transform = '';
        card.style.removeProperty('--arrow-left');
    }
    if (id === 'opponentModal') {
        S.opponentSelectAfterSave = null;
    }
    if (id === 'locationModal') {
        S.locationSelectAfterSave = null;
    }
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function numOrNull(v) {
    return v === '' ? null : +v;
}

function switchToScreen(screenName) {
    const activeNavButton = document.querySelector(`.home-nav button[data-screen="${screenName}"]`);
    if (activeNavButton) {
        document.querySelectorAll('.home-nav button').forEach(b => b.classList.remove('active'));
        activeNavButton.classList.add('active');
    }

    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const screen = $(screenName);
    if (screen) {
        screen.classList.add('active');
    }

    if (screenName === 'stats') {
        loadPlayerStats();
    }
    if (screenName === 'gameManagement') {
        renderGameManagement();
    }
    if (screenName === 'reference') {
        renderReferenceScreen();
    }
}

function minutesUrl(gameId = S.game?.id) {
    return `/api/games/${gameId}/minutes?period_type=${S.minutes.periodType}&period_number=${S.minutes.periodNumber}`;
}

document.querySelectorAll('.home-nav button').forEach(button => {
    button.onclick = () => {
        switchToScreen(button.dataset.screen);
    };
});

async function init() {
    if ('serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map(registration => registration.unregister()));
        if (window.caches) {
            const cacheNames = await window.caches.keys();
            await Promise.all(cacheNames.map(cacheName => window.caches.delete(cacheName)));
        }
    }

    [S.players, S.seasons, S.games, S.user] = await Promise.all([
        api('/api/players'),
        api('/api/seasons'),
        api('/api/games'),
        api('/api/user')
    ]);

    [S.opponents, S.locations] = await Promise.all([
        api('/api/opponents'),
        api('/api/locations')
    ]);

    renderAll();
    setupCourt();
    setupShotTypeLabel();
    drawCourt();
    renderHome();
    renderProfile();

    $('minutesPeriodType')?.addEventListener('change', async event => {
        S.minutes.periodType = event.target.value;
        S.minutes.periodNumber = 1;
        updateMinutesPeriodOptions();
        await loadMinutes();
    });

    $('minutesPeriodNumber')?.addEventListener('change', async event => {
        S.minutes.periodNumber = +event.target.value;
        await loadMinutes();
    });

    $('opponent')?.addEventListener('change', async () => {
        await handleAddNewChoice($('opponent'), '/api/opponents', 'opponents', 'opponent');
    });

    $('location')?.addEventListener('change', async () => {
        await handleAddNewChoice($('location'), '/api/locations', 'locations', 'location');
    });

    $('editGameOpponent')?.addEventListener('change', async () => {
        await handleAddNewChoice($('editGameOpponent'), '/api/opponents', 'opponents', 'opponent');
    });

    $('editGameLocation')?.addEventListener('change', async () => {
        await handleAddNewChoice($('editGameLocation'), '/api/locations', 'locations', 'location');
    });

    $('newGamePlayerChoice')?.addEventListener('change', () => {
        const playerChoice = $('newGamePlayerChoice');
        if (playerChoice.value === ADD_NEW_VALUE) {
            openNewPlayerFromGame();
        }
        else if (playerChoice.value) {
            const checkbox = document.querySelector(`.gp[value="${playerChoice.value}"]`);
            if (checkbox) {
                checkbox.checked = true;
            }
        }
        playerChoice.value = '';
    });

    S.poll = setInterval(() => {
        if (document.visibilityState === 'visible' && S.game) {
            loadGame(S.game.id, true);
        }
    }, 5000);
}

function setupShotTypeLabel() {
    const shotTypeButton = $('shotType');
    const abbreviations = {
        'Pending: Auto': 'PA',
        'Pending: 3PT': 'P3',
        'Pending: 2PT': 'P2'
    };
    const updateLabel = () => {
        const fullLabel = shotTypeButton.textContent.trim();
        const match = Object.entries(abbreviations).find(([full]) => fullLabel.includes(full));
        if (match && shotTypeButton.textContent.trim() !== match[1]) {
            shotTypeButton.textContent = match[1];
        }
    };
    new MutationObserver(updateLabel).observe(shotTypeButton, {
        childList: true,
        characterData: true,
        subtree: true
    });
    updateLabel();
}

function renderAll() {
    renderPlayers();
    renderSeasons();
    renderGames();
    populateReportSeasonFilter();
    renderReports();
    renderGameManagement();
    renderReferenceScreen();
    renderHome();
    renderProfile();

    const active = S.players.filter(p => p.is_active);

    $('statsPlayer').innerHTML = active.map(p => `
        <option value="${p.id}">
            #${p.jersey_number ?? ''} ${escapeHtml(p.first_name)} ${escapeHtml(p.last_name)}
        </option>
    `).join('');

    $('statsSeason').innerHTML =
        '<option value="">All Seasons</option>' +
        S.seasons.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');

    $('gameSeason').innerHTML = S.seasons
        .filter(s => s.is_active)
        .map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
}

function renderHome() {
    const name = S.user.display_name || 'Coach';
    const activeGames = S.games.filter(game => game.status !== 'final' && game.status !== 'cancelled');
    const profilePhoto = S.user.photo_data
        ? `<img src="${S.user.photo_data}" alt="Profile photo">`
        : '<span>🏀</span>';

    $('homeGreeting').textContent = `Hello, ${name}`;
    $('homeProfilePhoto').innerHTML = profilePhoto;
    $('homeActiveGames').innerHTML = activeGames.length
        ? activeGames.map(game => `
            <button class="home-resume-item" onclick="openManagedGame(${game.id})">
                <span class="home-resume-icon">${game.status === 'live' ? '▶' : '◷'}</span>
                <span class="home-resume-copy">
                    <strong>vs ${escapeHtml(game.opponent)}</strong>
                    <small>${escapeHtml(game.game_date)} · ${escapeHtml(game.season_name)}</small>
                </span>
                <span class="home-resume-arrow">›</span>
            </button>
        `).join('')
        : '<div class="home-empty">No active games yet. Start a new game to begin tracking.</div>';
}

function renderProfile() {
    if (!$('profileName')) return;
    $('profileName').value = S.user.display_name || '';
    $('profileEmail').value = S.user.email || '';
    $('profilePhone').value = S.user.phone || '';
    $('profilePhotoPreview').innerHTML = S.user.photo_data
        ? `<img src="${S.user.photo_data}" alt="Profile photo">`
        : '<span>🏀</span>';
}

function handleProfilePhoto(input) {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
        S.user.photo_data = reader.result;
        renderProfile();
    };
    reader.readAsDataURL(file);
}

// The embedded Android WebView doesn't support the standard HTML file
// picker (no onShowFileChooser implementation), so <input type="file">
// silently does nothing there even though it works in a normal browser.
// When running inside the packaged Android app, hand off to the native
// picker via a navigation the app intercepts (see handle_navigation in
// app.py); otherwise let the label open the file input as usual.
function triggerProfilePhotoPicker(event) {
    if (!NATIVE_APP) return true;
    event.preventDefault();
    window.location.href = '/api/profile-photo/pick';
    return false;
}

function setProfilePhotoFromNative(dataUrl) {
    S.user.photo_data = dataUrl;
    renderProfile();
}

async function saveProfile() {
    try {
        S.user = await api('/api/user', {
            method: 'PUT',
            body: JSON.stringify({
                display_name: $('profileName').value,
                email: $('profileEmail').value,
                phone: $('profilePhone').value,
                photo_data: S.user.photo_data || ''
            })
        });
        renderHome();
        renderProfile();
        toast('Profile saved');
    } catch (error) {
        toast(error.message);
    }
}

/* ---------------- Players ---------------- */

function renderPlayers() {
    $('playersTable').innerHTML = S.players.map(p => `
        <tr>
            <td>${p.jersey_number ?? ''}</td>
            <td>${escapeHtml(p.first_name)} ${escapeHtml(p.last_name)}</td>
            <td>${escapeHtml(p.position ?? '')}</td>
            <td>${p.graduation_year ?? ''}</td>
            <td>${p.is_active ? 'Active' : 'Inactive'}</td>
            <td><button class="btn secondary" onclick="openPlayerModal(${p.id})">Edit</button></td>
        </tr>
    `).join('') || '<tr><td colspan="6">No players</td></tr>';
}

function openPlayerModal(id, fromNewGame = false) {
    S.addingPlayerToNewGame = fromNewGame;
    const p = S.players.find(x => x.id === id);

    $('playerModalTitle').textContent = p ? 'Edit Player' : 'Add Player';
    $('playerId').value = p?.id || '';
    $('firstName').value = p?.first_name || '';
    $('lastName').value = p?.last_name || '';
    $('jersey').value = p?.jersey_number ?? '';
    $('position').value = p?.position || '';
    $('height').value = p?.height || '';
    $('weight').value = p?.weight ?? '';
    $('gradYear').value = p?.graduation_year ?? '';
    $('playerActive').value = p?.is_active ? '1' : '0';
    $('deletePlayerBtn').style.display = p ? 'inline-block' : 'none';

    $('playerModal').classList.add('open');
}

async function savePlayer() {
    const id = $('playerId').value;
    const addToGame = !id && S.game && !S.addingPlayerToNewGame;
    const addToNewGame = !id && S.addingPlayerToNewGame;

    const d = {
        first_name: $('firstName').value,
        last_name: $('lastName').value,
        jersey_number: numOrNull($('jersey').value),
        position: $('position').value || null,
        height: $('height').value || null,
        weight: numOrNull($('weight').value),
        graduation_year: numOrNull($('gradYear').value),
        is_active: $('playerActive').value === '1'
    };

    try {
        const savedPlayerResponse = await api(id ? `/api/players/${id}` : '/api/players', {
            method: id ? 'PUT' : 'POST',
            body: JSON.stringify(d)
        });

        S.players = await api('/api/players');
        const savedPlayer = savedPlayerResponse;

        if (addToGame && savedPlayer) {
            await api(`/api/games/${S.game.id}/players`, {
                method: 'POST',
                body: JSON.stringify({ player_id: savedPlayer.id })
            });
        }

        closeModal('playerModal');
        renderAll();
        if (addToNewGame && savedPlayer) {
            const selectedIds = [...document.querySelectorAll('.gp:checked')]
                .map(input => +input.value);
            selectedIds.push(savedPlayer.id);
            renderGamePlayers(selectedIds);
            S.addingPlayerToNewGame = false;
        }
        if (addToGame && savedPlayer) {
            await loadGame(S.game.id, true);
            $('livePlayer').value = savedPlayer.id;
            S.playerId = savedPlayer.id;
            renderLive();
        }
        toast('Player saved');
    }
    catch (e) {
        toast(e.message);
    }
}

async function deletePlayer() {
    if (!await showConfirm('Delete this player? This action cannot be undone.')) {
        return;
    }

    try {
        await api(`/api/players/${$('playerId').value}`, { method: 'DELETE' });
        S.players = await api('/api/players');
        closeModal('playerModal');
        renderAll();
        toast('Player deleted');
    }
    catch (e) {
        toast(e.message);
    }
}

/* ---------------- Seasons ---------------- */

function renderSeasons() {
    $('seasonsTable').innerHTML = S.seasons.map(s => `
        <tr>
            <td>${escapeHtml(s.name)}</td>
            <td>${s.start_date ?? ''}</td>
            <td>${s.end_date ?? ''}</td>
            <td>${s.is_active ? 'Active' : 'Inactive'}</td>
            <td><button class="btn secondary" onclick="openSeasonModal(${s.id})">Edit</button></td>
        </tr>
    `).join('');

    const activeSeason = S.seasons.find(s => s.is_active);
    $('activeSeasonBanner').textContent = activeSeason
        ? `Current active season: ${activeSeason.name}`
        : 'No active season selected';
}

function openSeasonModal(id) {
    const s = S.seasons.find(x => x.id === id);

    $('seasonModalTitle').textContent = s ? 'Edit Season' : 'Add Season';
    $('seasonId').value = s?.id || '';
    $('seasonName').value = s?.name || '';
    $('seasonStart').value = s?.start_date || '';
    $('seasonEnd').value = s?.end_date || '';
    $('seasonActive').value = s?.is_active ? '1' : '0';
    $('deleteSeasonBtn').style.display = s ? 'inline-block' : 'none';

    $('seasonModal').classList.add('open');
}

async function saveSeason() {
    const id = $('seasonId').value;

    const d = {
        name: $('seasonName').value,
        start_date: $('seasonStart').value || null,
        end_date: $('seasonEnd').value || null,
        is_active: $('seasonActive').value === '1'
    };

    try {
        await api(id ? `/api/seasons/${id}` : '/api/seasons', {
            method: id ? 'PUT' : 'POST',
            body: JSON.stringify(d)
        });

        S.seasons = await api('/api/seasons');
        closeModal('seasonModal');
        renderAll();
        toast('Season saved');
    }
    catch (e) {
        toast(e.message);
    }
}

async function deleteSeason() {
    if (!await showConfirm('Delete this season? This action cannot be undone.')) {
        return;
    }

    try {
        await api(`/api/seasons/${$('seasonId').value}`, { method: 'DELETE' });
        S.seasons = await api('/api/seasons');
        closeModal('seasonModal');
        renderAll();
        toast('Season deleted');
    }
    catch (e) {
        toast(e.message);
    }
}

/* ---------------- Opponents & Locations (reference data) ---------------- */

function renderReferenceScreen() {
    const opponentsList = $('opponentsList');
    const locationsList = $('locationsList');

    if (opponentsList) {
        opponentsList.innerHTML = S.opponents.length
            ? S.opponents.map(o => `
                <div class="ref-row">
                    <div>
                        <div class="ref-row-name">${escapeHtml(o.name)}</div>
                        <div class="ref-row-count">${o.game_count ?? 0} game(s)</div>
                    </div>
                    <div class="ref-row-actions">
                        <button class="btn secondary" onclick="openOpponentModal(${o.id})">Edit</button>
                    </div>
                </div>
            `).join('')
            : '<div class="empty">No opponents saved yet.</div>';
    }

    if (locationsList) {
        locationsList.innerHTML = S.locations.length
            ? S.locations.map(l => `
                <div class="ref-row">
                    <div>
                        <div class="ref-row-name">${escapeHtml(l.name)}</div>
                        <div class="ref-row-count">${l.game_count ?? 0} game(s)</div>
                    </div>
                    <div class="ref-row-actions">
                        <button class="btn secondary" onclick="openLocationModal(${l.id})">Edit</button>
                    </div>
                </div>
            `).join('')
            : '<div class="empty">No locations saved yet.</div>';
    }
}

function openOpponentModal(id) {
    const o = S.opponents.find(x => x.id === id);

    $('opponentModalTitle').textContent = o ? 'Edit Opponent' : 'Add Opponent';
    $('opponentId').value = o?.id || '';
    $('opponentName').value = o?.name || '';
    $('deleteOpponentBtn').style.display = o ? 'inline-block' : 'none';

    $('opponentModal').classList.add('open');
}

async function saveOpponent() {
    const id = $('opponentId').value;
    const name = $('opponentName').value.trim();
    const selectAfterSave = S.opponentSelectAfterSave;

    if (!name) {
        toast('Opponent name is required');
        return;
    }

    try {
        const savedOpponent = await api(id ? `/api/opponents/${id}` : '/api/opponents', {
            method: id ? 'PUT' : 'POST',
            body: JSON.stringify({ name })
        });

        S.opponents = await api('/api/opponents');
        S.games = await api('/api/games');

        closeModal('opponentModal');
        renderAll();
        S.opponentSelectAfterSave = null;
        if (selectAfterSave) {
            populateNameDropdown(selectAfterSave, S.opponents, savedOpponent.name, 'Add new opponent');
        }
        toast('Opponent saved');
    }
    catch (e) {
        toast(e.message);
    }
}

async function deleteOpponent() {
    const id = $('opponentId').value;

    if (!await showConfirm('Delete this opponent from the saved list? Existing games will keep their opponent name.')) {
        return;
    }

    try {
        await api(`/api/opponents/${id}`, { method: 'DELETE' });
        S.opponents = await api('/api/opponents');
        closeModal('opponentModal');
        renderReferenceScreen();
        toast('Opponent deleted');
    }
    catch (e) {
        toast(e.message);
    }
}

function openLocationModal(id) {
    const l = S.locations.find(x => x.id === id);

    $('locationModalTitle').textContent = l ? 'Edit Location' : 'Add Location';
    $('locationId').value = l?.id || '';
    $('locationName').value = l?.name || '';
    $('deleteLocationBtn').style.display = l ? 'inline-block' : 'none';

    $('locationModal').classList.add('open');
}

async function saveLocation() {
    const id = $('locationId').value;
    const name = $('locationName').value.trim();
    const selectAfterSave = S.locationSelectAfterSave;

    if (!name) {
        toast('Location name is required');
        return;
    }

    try {
        await api(id ? `/api/locations/${id}` : '/api/locations', {
            method: id ? 'PUT' : 'POST',
            body: JSON.stringify({ name })
        });

        S.locations = await api('/api/locations');
        S.games = await api('/api/games');

        closeModal('locationModal');
        renderAll();
        if (selectAfterSave) {
            populateNameDropdown(selectAfterSave, S.locations, name, 'Add new location');
        }
        toast('Location saved');
    }
    catch (e) {
        toast(e.message);
    }
}

async function deleteLocation() {
    const id = $('locationId').value;

    if (!await showConfirm('Delete this location from the saved list? Existing games will keep their location name.')) {
        return;
    }

    try {
        await api(`/api/locations/${id}`, { method: 'DELETE' });
        S.locations = await api('/api/locations');
        closeModal('locationModal');
        renderReferenceScreen();
        toast('Location deleted');
    }
    catch (e) {
        toast(e.message);
    }
}

function populateNameDropdown(selectEl, list, selectedName, addLabel) {
    if (!selectEl) {
        return;
    }

    selectEl.innerHTML =
        list.map(item => `
            <option value="${escapeHtml(item.name)}">${escapeHtml(item.name)}</option>
        `).join('') +
        `<option value="${ADD_NEW_VALUE}">➕ ${addLabel}</option>`;

    if (selectedName && list.some(i => i.name === selectedName)) {
        selectEl.value = selectedName;
    }
    else if (selectedName) {
        const opt = document.createElement('option');
        opt.value = selectedName;
        opt.textContent = selectedName;
        selectEl.insertBefore(opt, selectEl.lastElementChild);
        selectEl.value = selectedName;
    }
}

async function loadOpponentsAndLocations() {
    S.opponents = await api('/api/opponents');
    S.locations = await api('/api/locations');

    populateNameDropdown($('opponent'), S.opponents, null, 'Add new opponent');
    populateNameDropdown($('location'), S.locations, null, 'Add new location');
}

async function handleAddNewChoice(selectEl, endpoint, listRefName, label) {
    if (selectEl.value !== ADD_NEW_VALUE) {
        return selectEl.value;
    }

    if (endpoint === '/api/opponents') {
        S.opponentSelectAfterSave = selectEl;
        selectEl.value = '';
        openOpponentModal();
        return '';
    }

    if (endpoint === '/api/locations') {
        S.locationSelectAfterSave = selectEl;
        selectEl.value = '';
        openLocationModal();
        return '';
    }

    const name = await showPrompt(`Enter new ${label} name:`);

    if (!name || !name.trim()) {
        selectEl.value = '';
        return '';
    }

    try {
        const created = await api(endpoint, {
            method: 'POST',
            body: JSON.stringify({ name: name.trim() })
        });

        S[listRefName] = await api(endpoint);

        populateNameDropdown(selectEl, S[listRefName], created.name, `Add new ${label}`);

        return created.name;
    }
    catch (e) {
        toast(e.message);
        selectEl.value = '';
        return '';
    }
}

/* ---------------- Games list / reports ---------------- */

function renderGames() {
    $('gameSelect').innerHTML =
        '<option value="">Select game</option>' +
        S.games.map(g => `<option value="${g.id}">${g.game_date} vs ${escapeHtml(g.opponent)} (${g.status})</option>`).join('');

    $('gameSelect').onchange = () => loadGame(+$('gameSelect').value);
}

function populateReportSeasonFilter() {
    const select = $('reportSeason');
    if (!select) return;

    const currentValue = select.value;

    select.innerHTML =
        '<option value="">All Seasons</option>' +
        S.seasons.map(season => `<option value="${season.id}">${escapeHtml(season.name)}</option>`).join('');

    const activeSeason = S.seasons.find(s => s.is_active);

    if (currentValue) {
        select.value = currentValue;
    }
    else if (activeSeason) {
        select.value = activeSeason.id;
    }
}

function renderReports() {
    const table = $('reportsTable');
    if (!table) return;

    const seasonId = $('reportSeason').value;
    let games = [...S.games];

    if (seasonId) {
        games = games.filter(g => String(g.season_id) === seasonId);
    }

    if (!games.length) {
        table.innerHTML = '<tr><td colspan="6">No games found for this season.</td></tr>';
        return;
    }

    table.innerHTML = games.map(g => `
        <tr>
            <td>${escapeHtml(g.game_date)}</td>
            <td>${escapeHtml(g.opponent)}</td>
            <td>${escapeHtml(g.season_name)}</td>
            <td>${escapeHtml(g.status)}</td>
            <td>${g.team_score ?? 0} - ${g.opponent_score ?? 0}</td>
            <td>
                <button class="btn secondary" onclick="previewGameReport(${g.id})">Preview</button>
                <button class="btn primary" onclick="shareGameReport(${g.id})">Share PDF</button>
            </td>
        </tr>
    `).join('');
}

async function shareGameReport(gameId) {
    await shareReportFile(`/api/games/${gameId}/report.pdf`, `game-${gameId}-report.pdf`);
}

async function previewGameReport(gameId) {
    await previewReportFile(`/api/games/${gameId}/report.pdf`, `game-${gameId}-report.pdf`);
}

async function shareSeasonReport() {
    const seasonId = $('reportSeason').value;

    if (!seasonId) {
        toast('Select a season first');
        return;
    }

    await shareReportFile(
        `/api/seasons/${seasonId}/report.pdf`,
        `season-${seasonId}-summary.pdf`
    );
}

async function previewSeasonReport() {
    const seasonId = $('reportSeason').value;
    if (!seasonId) {
        toast('Select a season first');
        return;
    }
    await previewReportFile(
        `/api/seasons/${seasonId}/report.pdf`,
        `season-${seasonId}-summary.pdf`
    );
}

async function previewReportFile(url, filename) {
    try {
        toast('Preparing PDF preview...');
        const response = await fetch(url);
        if (!response.ok) throw new Error('Could not create the PDF report');
        const blob = await response.blob();

        if (/Android/i.test(navigator.userAgent)) {
            const pdfData = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = () => reject(new Error('Could not read the PDF report'));
                reader.readAsDataURL(blob);
            });
            const nativeResponse = await fetch('/api/share-file', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    filename,
                    content_type: 'application/pdf',
                    action: 'view',
                    data: pdfData
                })
            });
            if (!nativeResponse.ok) throw new Error('Could not open the PDF preview');
            const nativeResult = await nativeResponse.json();
            window.location.href = new URL(nativeResult.url, window.location.href).href;
            return;
        }

        const previewUrl = URL.createObjectURL(blob);
        $('pdfPreviewFrame').src = previewUrl;
        $('pdfPreviewModal').classList.add('open');
        S.pdfPreview = { url: previewUrl, reportUrl: url, filename };
    } catch (error) {
        toast(error.message || 'Could not preview PDF');
    }
}

async function sharePreviewedPdf() {
    if (S.pdfPreview) {
        await shareReportFile(S.pdfPreview.reportUrl, S.pdfPreview.filename);
    }
}

function closePdfPreview() {
    closeModal('pdfPreviewModal');
    if (S.pdfPreview?.url) URL.revokeObjectURL(S.pdfPreview.url);
    S.pdfPreview = null;
    $('pdfPreviewFrame').removeAttribute('src');
}

async function shareReportFile(url, filename) {
    try {
        toast('Preparing PDF share...');
        const response = await fetch(url);
        if (!response.ok) throw new Error('Could not create the PDF report');

        const blob = await response.blob();
        const pdfData = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('Could not read the PDF report'));
            reader.readAsDataURL(blob);
        });

        const shareResponse = await fetch('/api/share-file', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename, content_type: 'application/pdf', data: pdfData })
        });
        if (!shareResponse.ok) throw new Error('Could not prepare the PDF for sharing');

        const result = await shareResponse.json();
        window.location.href = new URL(result.url, window.location.href).href;
    } catch (error) {
        if (error.name !== 'AbortError') toast(error.message || 'Could not share PDF');
    }
}

/* ---------------- Game Management ---------------- */

function isPreviousGame(game) {
    return game.status === 'final' || game.status === 'cancelled';
}

function setGameManagementFilter(filter) {
    S.gameManagementFilter = filter;

    $('activeGamesFilter').className = filter === 'active' ? 'btn primary' : 'btn secondary';
    $('previousGamesFilter').className = filter === 'previous' ? 'btn primary' : 'btn secondary';
    $('allGamesFilter').className = filter === 'all' ? 'btn primary' : 'btn secondary';

    renderGameManagement();
}

function renderGameManagement() {
    const container = $('gameManagementList');
    if (!container) return;

    let games = [...S.games];

    if (S.gameManagementFilter === 'active') {
        games = games.filter(g => !isPreviousGame(g));
    }
    if (S.gameManagementFilter === 'previous') {
        games = games.filter(g => isPreviousGame(g));
    }

    if (!games.length) {
        container.innerHTML = '<div class="card empty">No games found in this category.</div>';
        return;
    }

    container.innerHTML = games.map(game => {
        const location = game.location || 'Location not set';
        const level = game.team_level || 'Team level not set';
        const status = game.status || 'scheduled';

        return `
            <div class="card game-management-card">
                <div class="game-management-heading">
                    <div>
                        <h3 class="game-management-title">${escapeHtml(game.opponent)}</h3>
                        <div class="game-management-meta">
                            ${escapeHtml(game.game_date)} · ${escapeHtml(game.season_name)} · ${escapeHtml(location)} · ${escapeHtml(level)}
                        </div>
                        <div style="margin-top:10px">
                            <span class="game-status game-status-${escapeHtml(status)}">${escapeHtml(status)}</span>
                        </div>
                    </div>
                    <div class="game-management-score">${game.team_score ?? 0} - ${game.opponent_score ?? 0}</div>
                </div>

                <div class="game-management-actions">
                    <button class="btn primary" onclick="openManagedGame(${game.id})">Open Game</button>
                    <button class="btn secondary" onclick="openEditGame(${game.id})">Edit</button>
                    <button class="btn secondary" onclick="duplicateGame(${game.id})">Duplicate</button>
                    <button class="btn secondary" onclick="shareGameReport(${game.id})">Share PDF</button>
                    <button class="btn danger" onclick="deleteManagedGame(${game.id})">Delete</button>
                </div>
            </div>
        `;
    }).join('');
}

async function openManagedGame(gameId) {
    document.querySelectorAll('.nav button').forEach(b => b.classList.toggle('active', b.dataset.screen === 'live'));
    document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === 'live'));

    $('gameSelect').value = gameId;
    await loadGame(gameId);
}

async function openEditGame(gameId) {
    try {
        const game = await api(`/api/games/${gameId}`);

        await loadOpponentsAndLocations();

        $('editGameId').value = game.id;

        $('editGameSeason').innerHTML = S.seasons.map(season => `
            <option value="${season.id}">${escapeHtml(season.name)}</option>
        `).join('');
        $('editGameSeason').value = game.season_id;

        populateNameDropdown($('editGameOpponent'), S.opponents, game.opponent, 'Add new opponent');
        populateNameDropdown($('editGameLocation'), S.locations, game.location, 'Add new location');

        $('editGameDate').value = game.game_date || '';
        $('editGameLevel').value = game.team_level || 'Varsity';
        $('editGameStatus').value = game.status || 'live';
        $('editGameTeamScore').value = game.team_score ?? 0;
        $('editGameOpponentScore').value = game.opponent_score ?? 0;

        const selectedPlayerIds = new Set(game.players.map(p => p.id));

        $('editGamePlayers').innerHTML = S.players.map(player => `
            <label class="game-player-option">
                <input class="edit-game-player" type="checkbox" value="${player.id}"
                    ${selectedPlayerIds.has(player.id) ? 'checked' : ''}>
                #${player.jersey_number ?? ''} ${escapeHtml(player.first_name)} ${escapeHtml(player.last_name)}
            </label>
        `).join('');

        $('editGameModal').classList.add('open');
    }
    catch (e) {
        toast(e.message);
    }
}

async function saveEditedGame() {
    const gameId = Number($('editGameId').value);
    const opponent = $('editGameOpponent').value;

    if (!opponent || opponent === ADD_NEW_VALUE) {
        toast('Select or add an opponent first');
        return;
    }

    const playerIds = [...document.querySelectorAll('.edit-game-player:checked')]
        .map(cb => Number(cb.value));

    const data = {
        season_id: Number($('editGameSeason').value),
        opponent: opponent,
        game_date: $('editGameDate').value,
        location: $('editGameLocation').value || null,
        team_level: $('editGameLevel').value,
        status: $('editGameStatus').value,
        team_score: Number($('editGameTeamScore').value) || 0,
        opponent_score: Number($('editGameOpponentScore').value) || 0,
        player_ids: playerIds
    };

    if (!data.game_date) {
        toast('Game date is required');
        return;
    }

    try {
        await api(`/api/games/${gameId}/details`, {
            method: 'PUT',
            body: JSON.stringify(data)
        });

        await reloadGames();
        closeModal('editGameModal');

        if (S.game && S.game.id === gameId) {
            await loadGame(gameId, true);
        }

        toast('Game updated');
    }
    catch (e) {
        toast(e.message);
    }
}

async function duplicateGame(gameId) {
    const game = S.games.find(item => item.id === gameId);
    if (!game) return;

    const newDate = await showPrompt(
        `Enter the date for the duplicated game against ${game.opponent}:`,
        game.game_date
    );

    if (newDate === null) {
        return;
    }

    try {
        const duplicate = await api(`/api/games/${gameId}/duplicate`, {
            method: 'POST',
            body: JSON.stringify({ game_date: newDate || game.game_date })
        });

        await reloadGames();
        toast(`Game duplicated against ${duplicate.opponent}`);
    }
    catch (e) {
        toast(e.message);
    }
}

async function deleteManagedGame(gameId) {
    const game = S.games.find(item => item.id === gameId);
    if (!game) return;

    const confirmed = await showConfirm(
        `Permanently delete the game against ${game.opponent} on ${game.game_date}? This also deletes its shots and statistics.`
    );

    if (!confirmed) return;

    try {
        await api(`/api/games/${gameId}`, { method: 'DELETE' });

        if (S.game && S.game.id === gameId) {
            S.game = null;
            S.pending = null;
            $('gameSelect').value = '';
            $('liveBody').style.display = 'none';
            $('liveEmpty').style.display = 'block';
        }

        await reloadGames();
        toast('Game deleted');
    }
    catch (e) {
        toast(e.message);
    }
}

async function reloadGames() {
    S.games = await api('/api/games');
    renderGames();
    populateReportSeasonFilter();
    renderReports();
    renderGameManagement();
}

/* ---------------- New Game ---------------- */

function openGameModal() {
    $('gameDate').value = new Date().toISOString().slice(0, 10);

    renderGamePlayers();

    loadOpponentsAndLocations();

    $('gameModal').classList.add('open');
}

function renderGamePlayers(selectedIds = null) {
    const selected = selectedIds
        ? new Set(selectedIds)
        : new Set(S.players.filter(p => p.is_active).map(p => p.id));

    $('gamePlayers').innerHTML = S.players
        .filter(p => p.is_active)
        .map(p => `
            <label style="display:block;padding:6px">
                <input style="width:auto" type="checkbox" class="gp" value="${p.id}"
                    ${selected.has(p.id) ? 'checked' : ''}>
                #${p.jersey_number ?? ''} ${escapeHtml(p.first_name)} ${escapeHtml(p.last_name)}
            </label>
        `).join('');

    const playerChoice = $('newGamePlayerChoice');
    if (playerChoice) {
        playerChoice.innerHTML =
            '<option value="${ADD_NEW_VALUE}">Add new player...</option>' +
            S.players
                .filter(p => p.is_active)
                .map(p => `<option value="${p.id}">#${p.jersey_number ?? ''} ${escapeHtml(p.first_name)} ${escapeHtml(p.last_name)}</option>`)
                .join('') +
            `<option value="${ADD_NEW_VALUE}">Add new player...</option>`;
    }
}

function openNewPlayerFromGame() {
    openPlayerModal(null, true);
}

async function saveGame() {
    const opponent = $('opponent').value;

    if (!opponent || opponent === ADD_NEW_VALUE) {
        toast('Select or add an opponent first');
        return;
    }

    const d = {
        season_id: +$('gameSeason').value,
        opponent: opponent,
        game_date: $('gameDate').value,
        location: $('location').value || null,
        team_level: $('teamLevel').value,
        player_ids: [...document.querySelectorAll('.gp:checked')].map(x => +x.value)
    };

    try {
        const g = await api('/api/games', { method: 'POST', body: JSON.stringify(d) });

        S.opponents = await api('/api/opponents');
        S.locations = await api('/api/locations');

        await reloadGames();
        closeModal('gameModal');

        $('gameSelect').value = g.id;
        loadGame(g.id);
    }
    catch (e) {
        toast(e.message);
    }
}

/* ---------------- Live game ---------------- */

async function loadGame(id, silent = false) {
    if (!id) {
        S.game = null;
        $('liveEmpty').style.display = 'block';
        $('liveBody').style.display = 'none';
        return;
    }

    const oldPid = +$('livePlayer').value;
    const gameChanged = S.game?.id !== +id;
    S.game = await api(`/api/games/${id}`);

    $('liveEmpty').style.display = 'none';
    $('liveBody').style.display = 'block';
    $('gameSelect').value = id;
    $('livePlayer').innerHTML = S.game.players.map(p => `
        <option value="${p.id}">#${p.jersey_number ?? ''} ${escapeHtml(p.first_name)} ${escapeHtml(p.last_name)}</option>
    `).join('') + '<option value="${ADD_NEW_VALUE}">Add new player...</option>';

    if (S.game.players.some(p => p.id === oldPid)) {
        $('livePlayer').value = oldPid;
    }
    S.playerId = +$('livePlayer').value;

    $('livePlayer').onchange = handleLivePlayerChange;
    if (gameChanged || !S.minutes.players) {
        await loadMinutes();
    }
    renderLive();

    if (!silent) {
        toast('Game loaded');
    }
}

function handleLivePlayerChange() {
    if ($('livePlayer').value === '__add_new__') {
        $('livePlayer').value = S.playerId || S.game?.players[0]?.id || '';
        openPlayerModal();
        return;
    }

    S.playerId = +$('livePlayer').value;
    renderLive();
}

function currentPlayer() {
    return S.game?.players.find(p => p.id === +$('livePlayer').value);
}

function renderLive() {
    const p = currentPlayer();
    if (!p) return;

    const s = p.stats;

    const vals = [
        ['PTS', s.pts],
        ['FT', `${s.ftm}/${s.fta}`],
        ['FT%', `${s.ft_pct}%`],
        ['2PT', `${s.fgm - s.tpm}/${s.fga - s.tpa}`],
        ['3PT', `${s.tpm}/${s.tpa}`],
        ['AST', s.ast],
        ['TO', s.to],
        ['STL', s.stl],
        ['OREB', s.oreb],
        ['DREB', s.dreb],
        ['BLK', s.blk]
    ];

    $('statsGrid').innerHTML = vals.map(v => `
        <div class="stat"><label>${v[0]}</label><div class="pill">${v[1]}</div></div>
    `).join('');

    drawCourt();
    renderMinutesPrototype();
}

function formatMinutesClock(seconds) {
    const wholeSeconds = Math.max(0, Math.floor(seconds));
    return `${String(Math.floor(wholeSeconds / 60)).padStart(2, '0')}:${String(wholeSeconds % 60).padStart(2, '0')}`;
}

function updateMinutesPeriodOptions() {
    const numberSelect = $('minutesPeriodNumber');
    if (!numberSelect) return;
    const count = S.minutes.periodType === 'quarter' ? 4 : 2;
    numberSelect.innerHTML = Array.from({ length: count }, (_, index) =>
        `<option value="${index + 1}">${S.minutes.periodType === 'quarter' ? 'Quarter' : 'Half'} ${index + 1}</option>`
    ).join('');
    numberSelect.value = String(S.minutes.periodNumber);
}

async function loadMinutes() {
    if (!S.game) return;
    clearInterval(S.minutes.timer);
    S.minutes.timer = null;
    const data = await api(minutesUrl());
    S.minutes.periodType = data.period_type;
    S.minutes.periodNumber = data.period_number;
    S.minutes.elapsed = data.period.elapsed_seconds;
    S.minutes.running = data.period.is_running;
    S.minutes.lastTick = S.minutes.running ? Date.now() : null;
    S.minutes.players = Object.fromEntries(data.players.map(player => [player.id, {
        onCourt: player.on_court,
        seconds: player.seconds,
        enteredAt: player.on_court ? data.period.elapsed_seconds - player.seconds : null
    }]));
    $('minutesPeriodType').value = S.minutes.periodType;
    updateMinutesPeriodOptions();
    if (S.minutes.running) {
        S.minutes.timer = setInterval(tickMinutesPrototype, 250);
    }
    renderMinutesPrototype();
}

function renderMinutesPrototype() {
    if (!S.game || !$('minutesPlayerList')) return;

    $('minutesClock').textContent = formatMinutesClock(S.minutes.elapsed);
    $('minutesClockButton').textContent = S.minutes.running ? 'Pause Period' : 'Start Period';

    $('minutesPlayerList').innerHTML = S.game.players.map(player => {
        const state = S.minutes.players[player.id] || { onCourt: false, seconds: 0, enteredAt: null };
        const liveSeconds = state.onCourt && S.minutes.running && state.enteredAt !== null
            ? state.seconds + (S.minutes.elapsed - state.enteredAt)
            : state.seconds;
        const playerName = `#${player.jersey_number ?? ''} ${escapeHtml(player.first_name)} ${escapeHtml(player.last_name)}`;
        return `
            <div class="minutes-player-row">
                <div>
                    <strong>${playerName}</strong>
                    <div class="small">${formatMinutesClock(liveSeconds)}</div>
                </div>
                <button class="minutes-status ${state.onCourt ? 'on-court' : ''}"
                    onclick="togglePlayerCourt(${player.id})">
                    ${state.onCourt ? 'On Court' : 'On Bench'}
                </button>
            </div>
        `;
    }).join('');
}

async function toggleMinutesClock() {
    try {
        const action = S.minutes.running ? 'pause' : 'start';
        const data = await api(`/api/games/${S.game.id}/minutes/period`, {
            method: 'POST',
            body: JSON.stringify({
                period_type: S.minutes.periodType,
                period_number: S.minutes.periodNumber,
                action
            })
        });
        applyMinutesData(data);
    } catch (error) {
        toast(error.message);
    }
}

function tickMinutesPrototype() {
    if (!S.minutes.running || S.minutes.lastTick === null) return;
    const now = Date.now();
    S.minutes.elapsed += (now - S.minutes.lastTick) / 1000;
    S.minutes.lastTick = now;
    renderMinutesPrototype();
}

async function togglePlayerCourt(playerId) {
    try {
        const data = await api(`/api/games/${S.game.id}/minutes/player?period_type=${S.minutes.periodType}&period_number=${S.minutes.periodNumber}`, {
            method: 'POST',
            body: JSON.stringify({ player_id: playerId })
        });
        applyMinutesData(data);
    } catch (error) {
        toast(error.message);
    }
}

async function resetMinutesPrototype() {
    try {
        const data = await api(`/api/games/${S.game.id}/minutes/period`, {
            method: 'POST',
            body: JSON.stringify({
                period_type: S.minutes.periodType,
                period_number: S.minutes.periodNumber,
                action: 'reset'
            })
        });
        applyMinutesData(data);
    } catch (error) {
        toast(error.message);
    }
}

function applyMinutesData(data) {
    clearInterval(S.minutes.timer);
    S.minutes.timer = null;
    S.minutes.periodType = data.period_type;
    S.minutes.periodNumber = data.period_number;
    S.minutes.elapsed = data.period.elapsed_seconds;
    S.minutes.running = data.period.is_running;
    S.minutes.lastTick = S.minutes.running ? Date.now() : null;
    S.minutes.players = Object.fromEntries(data.players.map(player => [player.id, {
        onCourt: player.on_court,
        seconds: player.seconds,
        enteredAt: player.on_court ? data.period.elapsed_seconds - player.seconds : null
    }]));
    $('minutesPeriodType').value = S.minutes.periodType;
    updateMinutesPeriodOptions();
    if (S.minutes.running) {
        S.minutes.timer = setInterval(tickMinutesPrototype, 250);
    }
    renderMinutesPrototype();
}

async function saveScore() {
    toast('Game saved');
}

async function finishGame() {
    $('finishTeamScore').value = S.game?.team_score ?? 0;
    $('finishOpponentScore').value = S.game?.opponent_score ?? 0;
    openModal('finishGameModal');
}

async function confirmFinishGame() {
    await api(`/api/games/${S.game.id}`, {
        method: 'PUT',
        body: JSON.stringify({
            status: 'final',
            team_score: +$('finishTeamScore').value || 0,
            opponent_score: +$('finishOpponentScore').value || 0
        })
    });

    closeModal('finishGameModal');
    await reloadGames();
    await refreshGame();
}

/* ---------------- Court / shots ---------------- */

function canvasPointFromEvent(canvas, event) {
    const rect = canvas.getBoundingClientRect();
    return {
        x: (event.clientX - rect.left) * (canvas.width / rect.width),
        y: (event.clientY - rect.top) * (canvas.height / rect.height)
    };
}

function normalizeCanvasPoint(canvas, point) {
    return {
        x: point.x / canvas.width,
        y: point.y / canvas.height
    };
}

function setupCourt() {
    const c = $('court');

    c.addEventListener('pointerdown', e => {
        if (!S.game || !currentPlayer()) return;

        const r = c.getBoundingClientRect();
        const canvasPoint = canvasPointFromEvent(c, e);
        const point = normalizeCanvasPoint(c, canvasPoint);
        const now = Date.now();
        const previousTap = S.lastTap;
        S.lastTap = { time: now, point };

        const selectedShot = S.game.shots
            .filter(s => s.player_id === currentPlayer().id)
            .map(shot => ({
                shot,
                distance: Math.hypot(
                    shot.x * c.width - canvasPoint.x,
                    shot.y * c.height - canvasPoint.y
                )
            }))
            .sort((a, b) => a.distance - b.distance)[0];

        clearTimeout(S.shotPressTimer);

        if (
            previousTap &&
            now - previousTap.time <= 350 &&
            Math.hypot(
                (previousTap.point.x - point.x) * c.width,
                (previousTap.point.y - point.y) * c.height
            ) <= 35
        ) {
            S.lastTap = null;
            S.pending = point;
            S.override = null;
            $('shotType').textContent = `Pending: ${autoThree(S.pending) ? '3PT' : '2PT'}`;
            drawCourt();
            $('shotResultType').textContent = autoThree(S.pending) ? '3PT' : '2PT';
            $('shotResultModal').classList.add('open');
            positionShotModal('shotResultModal', point, r);
            return;
        }

        S.shotPressTimer = setTimeout(() => {
            S.pending = selectedShot && selectedShot.distance <= 20 ? null : point;
            S.override = null;
            S.selectedShotId = selectedShot && selectedShot.distance <= 20
                ? selectedShot.shot.id
                : null;
            drawCourt();
            if (S.selectedShotId) {
                $('deleteShotResult').textContent = selectedShot.shot.made
                    ? 'Made shot'
                    : 'Missed shot';
            }
            $('statMenuModal').classList.add('open');
            positionShotModal('statMenuModal', point, r);
        }, 550);
    });

    c.addEventListener('pointerup', () => clearTimeout(S.shotPressTimer));
    c.addEventListener('pointercancel', () => clearTimeout(S.shotPressTimer));
}

function positionShotModal(modalId, point, courtRect) {
    const card = $(modalId).querySelector('.modal-card');
    const shotX = courtRect.left + point.x * courtRect.width;
    const shotY = courtRect.top + point.y * courtRect.height;
    const margin = 12;

    card.style.position = 'fixed';
    card.style.top = `${shotY + 16}px`;
    card.style.transform = 'translateX(-50%)';
    card.classList.add('shot-delete-card');

    requestAnimationFrame(() => {
        const cardRect = card.getBoundingClientRect();
        const minLeft = margin + cardRect.width / 2;
        const maxLeft = window.innerWidth - margin - cardRect.width / 2;
        const boundedX = Math.max(minLeft, Math.min(shotX, maxLeft));
        const arrowLeft = Math.max(
            18,
            Math.min(cardRect.width - 18, shotX - boundedX + cardRect.width / 2)
        );
        card.style.left = `${boundedX}px`;
        card.style.setProperty('--arrow-left', `${arrowLeft}px`);
        if (cardRect.bottom > window.innerHeight - margin) {
            card.style.top = `${Math.max(margin, shotY - cardRect.height - 16)}px`;
            card.classList.add('arrow-bottom');
            card.classList.remove('arrow-top');
        } else {
            card.classList.add('arrow-top');
            card.classList.remove('arrow-bottom');
        }
    });
}

function autoThree(p) {
    const courtWidth = 720;
    const courtHeight = 650;
    const centerX = courtWidth * 0.5;
    const centerY = courtHeight * 0.06;
    const radius = courtWidth * 0.345;
    const cornerX = courtWidth * 0.16;
    const cornerY = centerY + Math.sqrt(radius ** 2 - (centerX - cornerX) ** 2);
    const pixelX = p.x * courtWidth;
    const pixelY = p.y * courtHeight;

    if ((pixelX <= cornerX || pixelX >= courtWidth - cornerX) && pixelY <= cornerY) {
        return true;
    }

    return Math.hypot(pixelX - centerX, pixelY - centerY) > radius;
}

function toggleShotType() {
    if (!S.pending) return;

    S.override = S.override === null ? !autoThree(S.pending) : !S.override;
    const label = `${S.override ? '3PT' : '2PT'} (override)`;
    $('shotType').textContent = `Pending: ${label}`;
    $('shotResultType').textContent = label;
}

async function saveShot(made) {
    if (!S.pending) {
        toast('Tap the court first');
        return;
    }

    const d = {
        game_id: S.game.id,
        player_id: currentPlayer().id,
        x: S.pending.x,
        y: S.pending.y,
        made,
        is_three: S.override ?? autoThree(S.pending)
    };

    await api('/api/shots', { method: 'POST', body: JSON.stringify(d) });

    S.pending = null;
    S.override = null;
    S.selectedShotId = null;
    closeModal('shotResultModal');
    closeModal('statMenuModal');
    $('shotType').textContent = 'Pending: Auto';

    await refreshGame();
}

function cancelShot() {
    S.pending = null;
    S.override = null;
    S.selectedShotId = null;
    $('shotType').textContent = 'Pending: Auto';
    closeModal('shotResultModal');
    drawCourt();
}

async function deleteShot() {
    closeModal('statMenuModal');
    if (S.selectedShotId) {
        const shotId = S.selectedShotId;
        S.selectedShotId = null;
        await api(`/api/shots/${shotId}`, { method: 'DELETE' });
        await refreshGame();
        return;
    }

    const shots = S.game.shots.filter(s => s.player_id === currentPlayer().id);
    if (!shots.length) return;

    await api(`/api/shots/${shots.at(-1).id}`, { method: 'DELETE' });
    await refreshGame();
}

async function deleteSelectedShot() {
    if (!S.selectedShotId) return;

    const shotId = S.selectedShotId;
    S.selectedShotId = null;
    closeModal('shotDeleteModal');

    await api(`/api/shots/${shotId}`, { method: 'DELETE' });
    await refreshGame();
}

function cancelSelectedShot() {
    S.selectedShotId = null;
    closeModal('shotDeleteModal');
    drawCourt();
}

async function clearChart() {
    if (!await showConfirm('Clear all shots for this player in this game?')) return;

    closeModal('statMenuModal');
    await api(`/api/games/${S.game.id}/shots?player_id=${currentPlayer().id}`, { method: 'DELETE' });
    await refreshGame();
}

async function eventStat(t) {
    closeModal('statMenuModal');
    await api('/api/events', {
        method: 'POST',
        body: JSON.stringify({
            game_id: S.game.id,
            player_id: currentPlayer().id,
            event_type: t,
            value: 1
        })
    });
    await refreshGame();
}

async function removeLatestStat() {
    closeModal('statMenuModal');
    await api(`/api/events/latest?game_id=${S.game.id}&player_id=${currentPlayer().id}`, { method: 'DELETE' });
    await refreshGame();
}

async function refreshGame() {
    await loadGame(S.game.id, true);
}

function courtBase(ctx, w, h) {
    ctx.clearRect(0, 0, w, h);

    ctx.fillStyle = '#c7aa6b';
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = '#171717';
    ctx.lineWidth = 2;

    // Court border
    ctx.strokeRect(w * 0.06, h * 0.04, w * 0.88, h * 0.90);

    // Paint
    ctx.strokeRect(w * 0.39, h * 0.04, w * 0.22, h * 0.30);

    // Free throw circle
    ctx.beginPath();
    ctx.arc(w * 0.5, h * 0.34, w * 0.09, 0, Math.PI * 2);
    ctx.stroke();

    // Rim
    ctx.beginPath();
    ctx.arc(w * 0.5, h * 0.06, w * 0.018, 0, Math.PI * 2);
    ctx.stroke();

    // Three-point line: straight corner sections joined to a rim-centered arc.
    const threePointCenterX = w * 0.5;
    const threePointCenterY = h * 0.06;
    const threePointCornerX = w * 0.16;
    // High-school three-point radius: 19.75 ft on a 50 ft court.
    const threePointRadius = w * 0.345;
    const threePointHorizontalDistance = threePointCenterX - threePointCornerX;
    const threePointVerticalDistance = Math.sqrt(
        threePointRadius ** 2 - threePointHorizontalDistance ** 2
    );
    const threePointCornerY = threePointCenterY + threePointVerticalDistance;
    const threePointAngle = Math.atan2(
        threePointVerticalDistance,
        threePointHorizontalDistance
    );

    ctx.beginPath();
    ctx.moveTo(w * 0.84, h * 0.04);
    ctx.lineTo(w * 0.84, threePointCornerY);
    ctx.arc(
        threePointCenterX,
        threePointCenterY,
        threePointRadius,
        threePointAngle,
        Math.PI - threePointAngle
    );
    ctx.lineTo(threePointCornerX, h * 0.04);
    ctx.stroke();
}

function drawCourt() {
    const c = $('court');
    const ctx = c.getContext('2d');

    courtBase(ctx, c.width, c.height);

    if (S.game && currentPlayer()) {
        S.game.shots
            .filter(s => s.player_id === currentPlayer().id)
            .forEach(s => dot(ctx, s.x * c.width, s.y * c.height, s.made ? '#14953b' : '#df3434', 7));
    }

    if (S.pending) {
        dot(ctx, S.pending.x * c.width, S.pending.y * c.height, '#1267d6', 8);
    }
}

function dot(ctx, x, y, color, r) {
    ctx.fillStyle = color;
    ctx.strokeStyle = 'white';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
}

function createShareChartCanvas() {
    const court = $('court');
    const player = currentPlayer();
    const stats = player?.stats;
    const shareCanvas = document.createElement('canvas');
    const headerHeight = 190;
    shareCanvas.width = court.width;
    shareCanvas.height = court.height + headerHeight;

    const ctx = shareCanvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, shareCanvas.width, shareCanvas.height);
    ctx.fillStyle = '#161616';
    ctx.fillRect(0, 0, shareCanvas.width, headerHeight);
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 28px sans-serif';
    ctx.fillText(
        `${player ? `#${player.jersey_number ?? ''} ${player.first_name} ${player.last_name}` : 'Shot Chart'}`,
        24,
        38
    );
    ctx.font = '18px sans-serif';
    ctx.fillText(
        `${S.game?.opponent ? `vs ${S.game.opponent}` : ''}${S.game?.game_date ? `  ${S.game.game_date}` : ''}`,
        24,
        68
    );

    const statValues = stats ? [
        ['PTS', stats.pts],
        ['FG', `${stats.fgm}/${stats.fga}`],
        ['3PT', `${stats.tpm}/${stats.tpa}`],
        ['FT', `${stats.ftm}/${stats.fta}`],
        ['AST', stats.ast],
        ['REB', stats.oreb + stats.dreb],
        ['STL', stats.stl],
        ['BLK', stats.blk],
        ['TO', stats.to]
    ] : [];
    const cellWidth = (shareCanvas.width - 48) / 5;
    statValues.forEach(([label, value], index) => {
        const column = index % 5;
        const row = Math.floor(index / 5);
        const x = 24 + column * cellWidth;
        const y = 108 + row * 38;
        ctx.font = '700 14px sans-serif';
        ctx.fillStyle = '#ffb52e';
        ctx.fillText(label, x, y);
        ctx.font = '18px sans-serif';
        ctx.fillStyle = '#ffffff';
        ctx.fillText(String(value), x + 42, y);
    });

    ctx.drawImage(court, 0, headerHeight);
    return shareCanvas;
}

async function shareShotChart() {
    const shareCanvas = createShareChartCanvas();
    const filename = `shot-chart-${currentPlayer()?.last_name || 'player'}.png`;

    try {
        toast('Preparing share...');
        const blob = await new Promise(resolve => shareCanvas.toBlob(resolve, 'image/png'));
        if (!blob) throw new Error('Could not create the shot chart image');

        const file = new File([blob], filename, { type: 'image/png' });
        if (navigator.share) {
            await navigator.share({ title: 'Shot Chart', files: [file] });
            toast('Shot chart shared');
            return;
        }

        const imageData = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('Could not read the shot chart image'));
            reader.readAsDataURL(blob);
        });
        const response = await fetch('/api/share-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename, data: imageData })
        });
        if (!response.ok) throw new Error('Could not prepare image for sharing');
        const result = await response.json();
        window.location.href = new URL(result.url, window.location.href).href;
    } catch (error) {
        if (error.name !== 'AbortError') {
            toast(error.message || 'Could not share shot chart');
        }
    }
}

/* ---------------- Player stats ---------------- */

async function loadPlayerStats() {
    const pid = +$('statsPlayer').value;
    if (!pid) return;

    $('statsContent').innerHTML = '<div class="card">Loading…</div>';

    const sid = $('statsSeason').value;
    const d = await api(`/api/players/${pid}/stats${sid ? '?season_id=' + sid : ''}`);
    const s = d.summary;

    const statCells = [
        ['GP', d.games_played], ['PTS', s.pts],
        ['FG', `${s.fgm}/${s.fga}`], ['FG%', `${s.fg_pct}%`],
        ['3PT', `${s.tpm}/${s.tpa}`], ['3PT%', `${s.tp_pct}%`],
        ['FT', `${s.ftm}/${s.fta}`], ['AST', s.ast],
        ['REB', s.oreb + s.dreb], ['STL', s.stl],
        ['BLK', s.blk], ['TO', s.to]
    ].map(v => `<div class="stat"><label>${v[0]}</label><div class="pill">${v[1]}</div></div>`).join('');

    const gameLogRows = d.game_log.map(g => `
        <tr>
            <td>${g.game_date}</td>
            <td>${escapeHtml(g.opponent)}</td>
            <td>${g.stats.pts}</td>
            <td>${g.stats.fgm}/${g.stats.fga}</td>
            <td>${g.stats.tpm}/${g.stats.tpa}</td>
            <td>${g.stats.ast}</td>
            <td>${g.stats.oreb + g.stats.dreb}</td>
        </tr>
    `).join('');

    $('statsContent').innerHTML = `
        <div class="card">
            <h2>#${d.player.jersey_number ?? ''} ${escapeHtml(d.player.first_name)} ${escapeHtml(d.player.last_name)}</h2>
            <div class="stats-grid">${statCells}</div>
        </div>

        <div class="card">
            <h3>Player Shot Map and Heat Map</h3>
            <div class="canvas-row">
                <canvas id="playerMap" class="mini-canvas" width="600" height="545"></canvas>
                <canvas id="heatMap" class="mini-canvas" width="600" height="545"></canvas>
            </div>
        </div>

        <div class="card">
            <h3>Game Log</h3>
            <div style="overflow:auto">
                <table>
                    <thead>
                        <tr><th>Date</th><th>Opponent</th><th>PTS</th><th>FG</th><th>3PT</th><th>AST</th><th>REB</th></tr>
                    </thead>
                    <tbody>${gameLogRows}</tbody>
                </table>
            </div>
        </div>
    `;

    drawPlayerVisuals(d.shots);
}

function drawPlayerVisuals(shots) {
    let c = $('playerMap');
    let ctx = c.getContext('2d');
    courtBase(ctx, c.width, c.height);

    shots.forEach(s => dot(ctx, s.x * c.width, s.y * c.height, s.made ? '#14953b' : '#df3434', 6));

    c = $('heatMap');
    ctx = c.getContext('2d');
    courtBase(ctx, c.width, c.height);

    const bins = 12;
    const grid = Array.from({ length: bins }, () =>
        Array.from({ length: bins }, () => ({ made: 0, missed: 0 }))
    );

    shots.forEach(s => {
        const gx = Math.min(bins - 1, Math.floor(s.x * bins));
        const gy = Math.min(bins - 1, Math.floor(s.y * bins));
        grid[gy][gx][s.made ? 'made' : 'missed']++;
    });

    const max = Math.max(
        1,
        ...grid.flat().map(cell => cell.made + cell.missed)
    );
    ctx.globalAlpha = .65;

    grid.forEach((row, y) => row.forEach((cell, x) => {
        const attempts = cell.made + cell.missed;
        if (!attempts) return;

        const makeRate = cell.made / attempts;
        const hue = makeRate * 120;
        const lightness = 48 + (1 - attempts / max) * 12;
        ctx.fillStyle = `hsl(${hue} 85% ${lightness}%)`;
        ctx.fillRect(
            x * c.width / bins,
            y * c.height / bins,
            c.width / bins,
            c.height / bins
        );
    }));

    ctx.globalAlpha = 1;
}

init().catch(e => toast(e.message));

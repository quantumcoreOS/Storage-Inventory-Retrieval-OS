let shelvingDatabase = [];
let currentRackId = null;
let currentBoxId = null;
let currentBoxDocId = null;
let highlightedBlockId = null;
let rawNodes = [], rawBlocks = [], rawRecords = [], rawNotes = [];
let debounceTimer = null;
let highlightTimeout = null;
let transferState = { type: null, id: null };
let db = null;
let SQL = null;

const SYSTEM_CONFIG = {
    DB: {
        NAME: 'QuantumSystemDB',
        STORE: 'sqlite_store',
        KEY: 'db_file'
    }
};

async function initApp() {
    console.log("%c Storage Inventory & Retrieval System: SECURE CLIENT-SIDE MODE", "color: #00f2ff; font-weight: bold; background: #000; padding: 5px;");
    await initDatabase();

    const savedTheme = localStorage.getItem('theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);

    if (localStorage.getItem('isAuthenticated') === 'true') {
        initializeSession();
    }
    
    const loginInputs = document.querySelectorAll('#login-form input');
    loginInputs.forEach(input => {
        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') handleLogin();
        });
    });

    document.addEventListener('input', (e) => {
        if (e.target.closest('.auth-form')) return;

        if ((e.target.tagName === 'INPUT' && e.target.type === 'text') || e.target.tagName === 'TEXTAREA') {
            const start = e.target.selectionStart;
            const end = e.target.selectionEnd;
            e.target.value = e.target.value.toUpperCase();
            e.target.setSelectionRange(start, end);
        }
    });

    document.getElementById('transfer-modal').addEventListener('click', (e) => {
        if (e.target.id === 'transfer-modal') closeTransferModal();
    });
    document.getElementById('transfer-node-select').addEventListener('change', updateTransferBlockOptions);
    setupTooltips();
}

function getDBStore(mode) {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(SYSTEM_CONFIG.DB.NAME, 1);
        request.onupgradeneeded = (e) => e.target.result.createObjectStore(SYSTEM_CONFIG.DB.STORE);
        request.onsuccess = (e) => {
            const db = e.target.result;
            const tx = db.transaction(SYSTEM_CONFIG.DB.STORE, mode);
            resolve(tx.objectStore(SYSTEM_CONFIG.DB.STORE));
        };
        request.onerror = (e) => reject(e);
    });
}

async function initDatabase() {
    const config = { locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/${file}` };
    SQL = await initSqlJs(config);
    
    // 1. Check for Cloud Share Link (Snapshot)
    const urlParams = new URLSearchParams(window.location.search);
    const syncId = urlParams.get('sync_id');
    
    if (syncId) {
        console.log("Loading Cloud Snapshot:", syncId);
        try {
            const cloudData = await fetchCloudSnapshot(syncId);
            if (cloudData) {
                db = new SQL.Database(cloudData);
                showNotification("CLOUD SNAPSHOT LOADED");
                return; // Skip local loading
            }
        } catch (e) { console.error("Cloud Load Error", e); showNotification("LINK EXPIRED OR INVALID"); }
    }

    let savedData = null;
    try {
        const store = await getDBStore('readonly');
        savedData = await new Promise((resolve) => {
            const req = store.get(SYSTEM_CONFIG.DB.KEY);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
        });
    } catch (e) { console.log("Initializing New DB"); }

    if (!savedData) {
        try {
            const response = await fetch('database.db');
            if (response.ok) {
                const buffer = await response.arrayBuffer();
                savedData = new Uint8Array(buffer);
            }
        } catch (e) {}
    }

    if (savedData) {
        db = new SQL.Database(new Uint8Array(savedData));
        try { db.run("ALTER TABLE blocks ADD COLUMN originNodeId TEXT"); } catch (e) {}
        try { db.run("ALTER TABLE records ADD COLUMN blockDocId TEXT"); } catch (e) {}
        try {
            db.run(`UPDATE records SET blockDocId = (
                SELECT docId FROM blocks WHERE blocks.blockId = records.blockId AND blocks.nodeId = records.nodeId
            ) WHERE blockDocId IS NULL`);
        } catch(e) {}
    } else {
        db = new SQL.Database();
        db.run("CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT, password TEXT)");
        db.run("CREATE TABLE IF NOT EXISTS nodes (docId TEXT PRIMARY KEY, nodeId TEXT)");
        db.run("CREATE TABLE IF NOT EXISTS blocks (docId TEXT PRIMARY KEY, blockId TEXT, nodeId TEXT, originNodeId TEXT)");
        db.run("CREATE TABLE IF NOT EXISTS records (docId TEXT PRIMARY KEY, fileNumber TEXT, fileName TEXT, fullName TEXT, fileDate TEXT, blockId TEXT, nodeId TEXT, blockDocId TEXT)");
        db.run("CREATE TABLE IF NOT EXISTS notes (docId TEXT PRIMARY KEY, text TEXT, time TEXT)");
        await saveDB();
    }

    overrideFetch();
}

async function saveDB() {
    const data = db.export();
    const store = await getDBStore('readwrite');
    return new Promise((resolve, reject) => {
        const req = store.put(data, SYSTEM_CONFIG.DB.KEY);
        req.onsuccess = () => resolve();
        req.onerror = (e) => reject(e);
    });
}

async function hashPassword(pwd) {
    if (!window.crypto || !window.crypto.subtle) {
        let hash = 0;
        for (let i = 0; i < pwd.length; i++) {
            hash = ((hash << 5) - hash) + pwd.charCodeAt(i);
            hash |= 0;
        }
        return "fallback_" + Math.abs(hash).toString(16);
    }
    try {
        const msgBuffer = new TextEncoder().encode(pwd);
        const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) {
        console.error("Hashing Error:", e);
        return 'error_hash';
    }
}

function overrideFetch() {
    const originalFetch = window.fetch;
    window.fetch = async (url, options = {}) => {
        if (!url.startsWith('/api/')) return originalFetch(url, options);

        const method = options.method || 'GET';
        const body = options.body ? JSON.parse(options.body) : {};
        const path = url.replace('/api/', '').split('/');
        const endpoint = path[0];
        const id = path[1];
        const action = path[2];

        await new Promise(r => setTimeout(r, 100));

        let response = null;
        const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).substr(2));

        try {
            if (endpoint === 'auth') {
                if (id === 'login') {
                    const hash = await hashPassword(body.password);
                    const stmt = db.prepare("SELECT * FROM users WHERE username=:u AND password=:p");
                    stmt.bind({':u': body.username, ':p': hash});
                    if (stmt.step()) {
                        response = { token: 'local-token', username: body.username };
                    } else {
                        throw { status: 401, error: "INVALID CREDENTIALS" };
                    }
                    stmt.free();
                } else if (id === 'register') {
                    const countRes = db.exec("SELECT COUNT(*) FROM users");
                    if (countRes[0].values[0][0] > 0) {
                        throw { status: 403, error: "REGISTRATION IS CLOSED" };
                    }
                    const hash = await hashPassword(body.password);
                    db.run("INSERT INTO users VALUES (?, ?, ?)", [uuid(), body.username, hash]);
                    await saveDB();
                    response = { success: true };
                }
            }
            else if (endpoint === 'nodes') {
                if (method === 'GET') {
                    const res = db.exec("SELECT * FROM nodes");
                    response = res.length ? res[0].values.map(r => ({ docId: r[0], nodeId: r[1] })) : [];
                } else if (method === 'POST') {
                    db.run("INSERT INTO nodes VALUES (?, ?)", [uuid(), body.nodeId]);
                    await saveDB();
                    response = { success: true };
                } else if (method === 'DELETE') {
                    const nodeRes = db.exec("SELECT nodeId FROM nodes WHERE docId = ?", [decodeURIComponent(id)]);
                    if (nodeRes.length && nodeRes[0].values.length) {
                        const nodeId = nodeRes[0].values[0][0];
                        db.run("DELETE FROM blocks WHERE nodeId = ?", [nodeId]);
                        db.run("DELETE FROM records WHERE nodeId = ?", [nodeId]);
                    }
                    db.run("DELETE FROM nodes WHERE docId = ?", [decodeURIComponent(id)]);
                    await saveDB();
                    response = { success: true };
                }
            }
            else if (endpoint === 'blocks') {
                if (method === 'GET') {
                    const res = db.exec("SELECT docId, blockId, nodeId, originNodeId FROM blocks");
                    response = res.length ? res[0].values.map(r => ({ docId: r[0], blockId: r[1], nodeId: r[2], originNodeId: r[3] })) : [];
                } else if (method === 'POST') {
                    db.run("INSERT INTO blocks (docId, blockId, nodeId, originNodeId) VALUES (?, ?, ?, ?)", [uuid(), body.blockId, body.nodeId, null]);
                    await saveDB();
                    response = { success: true };
                } else if (method === 'DELETE') {
                    db.run("DELETE FROM blocks WHERE docId = ?", [id]);
                    await saveDB();
                    response = { success: true };
                } else if (method === 'PUT' && action === 'move') {
                    const blockRes = db.exec("SELECT blockId, nodeId FROM blocks WHERE docId = ?", [id]);
                    if (!blockRes.length || !blockRes[0].values.length) throw { status: 404, error: "BLOCK NOT FOUND" };
                    
                    const currentBlockId = blockRes[0].values[0][0];
                    const oldNodeId = blockRes[0].values[0][1];
                    
                    db.run("UPDATE blocks SET nodeId = ?, originNodeId = ? WHERE docId = ?", [body.targetNodeId, oldNodeId, id]);
                    
                    db.run("UPDATE records SET nodeId = ? WHERE blockDocId = ?", [body.targetNodeId, id]);
                    db.run("UPDATE records SET nodeId = ?, blockDocId = ? WHERE nodeId = ? AND blockId = ? AND blockDocId IS NULL", [body.targetNodeId, id, oldNodeId, currentBlockId]);

                    await saveDB();
                    response = { success: true };
                }
            }
            else if (endpoint === 'records') {
                if (method === 'GET') {
                    const res = db.exec("SELECT docId, fileNumber, fileName, fullName, fileDate, blockId, nodeId, blockDocId FROM records");
                    response = res.length ? res[0].values.map(r => ({ docId: r[0], fileNumber: r[1], fileName: r[2], fullName: r[3], fileDate: r[4], blockId: r[5], nodeId: r[6], blockDocId: r[7] })) : [];
                } else if (method === 'POST') {
                    db.run("INSERT INTO records (docId, fileNumber, fileName, fullName, fileDate, blockId, nodeId, blockDocId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [uuid(), body.fileNumber, body.fileName, body.fullName, body.fileDate, body.blockId, body.nodeId, body.blockDocId]);
                    await saveDB();
                    response = { success: true };
                } else if (method === 'DELETE') {
                    db.run("DELETE FROM records WHERE docId = ?", [decodeURIComponent(id)]);
                    await saveDB();
                    response = { success: true };
                } else if (method === 'PUT' && action === 'move') {
                    const blockRes = db.exec("SELECT blockId FROM blocks WHERE docId = ?", [body.targetBlockId]);
                    const targetName = (blockRes.length && blockRes[0].values.length) ? blockRes[0].values[0][0] : "UNKNOWN";
                    db.run("UPDATE records SET nodeId = ?, blockId = ?, blockDocId = ? WHERE docId = ?", [body.targetNodeId, targetName, body.targetBlockId, id]);
                    await saveDB();
                    response = { success: true };
                }
            }
            else if (endpoint === 'notes') {
                if (method === 'GET') {
                    const res = db.exec("SELECT * FROM notes");
                    response = res.length ? res[0].values.map(r => ({ docId: r[0], text: r[1], time: r[2] })) : [];
                } else if (method === 'POST') {
                    db.run("INSERT INTO notes VALUES (?, ?, ?)", [uuid(), body.text, body.time]);
                    await saveDB();
                    response = { success: true };
                } else if (method === 'DELETE') {
                    db.run("DELETE FROM notes WHERE docId = ?", [id]);
                    await saveDB();
                    response = { success: true };
                }
            }

            if (response) {
                return new Response(JSON.stringify(response), { status: 200, headers: { 'Content-Type': 'application/json' } });
            } else {
                throw { status: 404, error: "NOT FOUND" };
            }
        } catch (err) {
            console.error("Mock Server Error:", err);
            const status = err.status || 500;
            const msg = err.error || "INTERNAL ERROR";
            return new Response(JSON.stringify({ error: msg }), { status: status, headers: { 'Content-Type': 'application/json' } });
        }
    };
}

async function handleLogin() {
    const username = document.getElementById('login-username').value;
    const password = document.getElementById('login-password').value;
    const errorEl = document.getElementById('login-error');

    if (!username || !password) return showError(errorEl, "CREDENTIALS REQUIRED");

    const cleanUser = username.replace(/\s/g, '').toLowerCase();
    const cleanPass = password.replace(/\s/g, '').toLowerCase();
    
    try {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: cleanUser, password: cleanPass })
        });
        const data = await res.json();

        if (res.ok) {
            localStorage.setItem('isAuthenticated', 'true');
            localStorage.setItem('currentUser', data.username);
            localStorage.setItem('authToken', data.token);
            initializeSession();
        } else {
            showError(errorEl, data.error || "ACCESS DENIED");
        }
    } catch (err) {
        console.error("Login Error:", err);
        showError(errorEl, "SERVER CONNECTION FAILED");
    }
}

async function handleRegister() {
    const username = document.getElementById('reg-username').value;
    const password = document.getElementById('reg-password').value;
    const errorEl = document.getElementById('reg-error');

    if (!username || !password) return showError(errorEl, "FIELDS REQUIRED");

    const cleanUser = username.replace(/\s/g, '').toLowerCase();
    const cleanPass = password.replace(/\s/g, '').toLowerCase();
    
    try {
        const res = await fetch('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: cleanUser, password: cleanPass })
        });
        const data = await res.json();

        if (res.ok) {
            toggleAuthMode();
            document.getElementById('login-username').value = username;
            document.getElementById('login-password').value = password;
            await handleLogin();
        } else {
            showError(errorEl, data.error || "REGISTRATION FAILED");
        }
    } catch (err) {
        console.error("Registration Error:", err);
        showError(errorEl, "SERVER CONNECTION FAILED");
    }
}

function processData() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
        renderData();
    }, 50);
}

function renderData() {
    const tree = {};
    
    rawNodes.forEach(n => {
        if (n.nodeId) {
            tree[n.nodeId] = { id: n.nodeId, docId: n.docId, boxes: [] };
        }
    });

    rawBlocks.forEach(b => {
        if (tree[b.nodeId]) {
            tree[b.nodeId].boxes.push({ id: b.blockId, docId: b.docId, origin: b.originNodeId, files: [] });
        }
    });

    rawRecords.forEach(r => {
        if (tree[r.nodeId]) {
            let box;
            if (r.blockDocId) box = tree[r.nodeId].boxes.find(b => b.docId === r.blockDocId);
            if (!box) box = tree[r.nodeId].boxes.find(b => b.id.toString() === r.blockId.toString());
            
            if (box) {
                box.files.push({
                    id: r.docId,
                    fileNumber: r.fileNumber,
                    fileName: r.fileName,
                    fullName: r.fullName,
                    fileDate: r.fileDate
                });
            }
        }
    });

    shelvingDatabase = Object.values(tree);

    const notesObj = {};
    rawNotes.forEach(n => {
        notesObj[n.docId] = { text: n.text, time: n.time };
    });

    updateStats();
    renderShelfGrid();
    renderDatabase();
    renderNotes(notesObj);
    
    if (currentRackId) {
        refreshRackView();
        if (currentBoxId) updateBoxFileList();
    }
}

function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function initializeSession() {
    const authPage = document.getElementById('auth-page');
    if (authPage) {
        authPage.classList.remove('active');
        authPage.style.display = 'none';
    }
    document.getElementById('main-container').style.display = 'block';
    document.getElementById('app-sidebar').style.display = 'flex';
    
    setupDataListeners();
}

function toggleAuthMode() {
    document.getElementById('login-form').classList.toggle('active');
    document.getElementById('register-form').classList.toggle('active');
    document.querySelectorAll('.error-message').forEach(el => el.style.display = 'none');
}

function showError(element, message) {
    element.innerText = message.toUpperCase();
    element.style.display = 'block';
    const box = element.parentElement;
    box.style.animation = "glitch-shake 0.4s cubic-bezier(.36,.07,.19,.97) both";
    setTimeout(() => box.style.animation = "", 400);
}

function setupDataListeners() {
    fetchData();
    setInterval(fetchData, 2000);
    showSection('dashboard');
}

async function fetchData() {
    try {
        const headers = { 'Authorization': localStorage.getItem('authToken') };
        const check = (r) => { if(r.status === 401) { logout(); throw 'Unauthorized'; } return r.json(); };
        const [nodes, blocks, records, notes] = await Promise.all([
            fetch('/api/nodes', { headers }).then(check),
            fetch('/api/blocks', { headers }).then(check),
            fetch('/api/records', { headers }).then(check),
            fetch('/api/notes', { headers }).then(check)
        ]);

        rawNodes = Array.isArray(nodes) ? nodes : [];
        rawBlocks = Array.isArray(blocks) ? blocks : [];
        rawRecords = Array.isArray(records) ? records : [];
        rawNotes = Array.isArray(notes) ? notes : [];
        processData();
    } catch (err) {
        console.error("Data Sync Error:", err);
    }
}

function showSection(id) {
    document.querySelectorAll('.content-section').forEach(s => {
        s.style.display = 'none';
        s.classList.remove('active');
    });
    
    const target = document.getElementById(id);
    if (target) {
        target.style.display = 'block';
        setTimeout(() => target.classList.add('active'), 10);
    }

    document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));
    
    let navId = '';
    if (id === 'dashboard') navId = 'btn-nav-dashboard';
    else if (['shelf-view', 'single-shelf-view', 'box-detail-view'].includes(id)) navId = 'btn-nav-nodes';
    else if (id === 'database') navId = 'btn-nav-data';

    if (navId) document.getElementById(navId)?.classList.add('active');
}

function renderShelfGrid() {
    const grid = document.getElementById('shelf-grid');
    if (!grid) return;

    grid.innerHTML = shelvingDatabase.map(node => `
        <div class="card-cyber">
            <button class="delete-btn" onclick="deleteNode('${node.docId}')" title="DELETE RACK"><i class="fas fa-trash"></i></button>
            <i class="fas fa-server" style="font-size: 2rem; color: var(--primary);"></i>
            <h3>${escapeHtml(node.id)}</h3>
            <button class="btn-cyber-main" onclick="openRack('${node.id}')">ACCESS RACK SHELVES</button>
        </div>
    `).join('');
}

function renderDatabase() {
    let html = '';
    shelvingDatabase.forEach(node => {
        (node.boxes || []).forEach(box => {
            if (!box) return;
            (box.files || []).forEach(f => {
                html += `<tr>
                    <td>${escapeHtml(box.id)}</td>
                    <td onclick="openRack('${node.id}', '${box.id}')" style="color:var(--primary); cursor:pointer;">${escapeHtml(node.id)}</td>
                    <td>${escapeHtml(f.fileNumber)}</td>
                    <td>${escapeHtml(f.fileName)}</td>
                    <td>${escapeHtml(f.fullName)}</td>
                    <td>${escapeHtml(f.fileDate)}</td>
                    <td><button class="btn-cyber-main" onclick="deleteRecord('${f.id}')">DELETE</button></td>
                </tr>`;
            });
        });
    });
    const dbBody = document.getElementById('db-body');
    if (dbBody) dbBody.innerHTML = html || '<tr><td colspan="7">NO RECORDS FOUND</td></tr>';
}

function updateBoxFileList() {
    if (!currentRackId || !currentBoxId) return;

    const rack = shelvingDatabase.find(r => r.id === currentRackId);
    const box = rack?.boxes.find(b => b.id === currentBoxId);

    if (!box) {
        console.error(`Box ${currentBoxId} not found in rack ${currentRackId}`);
        return;
    }

    const listContainer = document.getElementById('current-box-list');
    if (!listContainer) return;

    const filesHtml = (box.files || []).map(f => `
        <tr>
            <td>${escapeHtml(f.fileNumber)}</td>
            <td>${escapeHtml(f.fileName)}</td>
            <td>${escapeHtml(f.fullName)}</td>
            <td>${escapeHtml(f.fileDate)}</td>
            <td><button class="btn-cyber-main" style="padding: 2px 8px; font-size: 0.8rem; margin-right:5px;" onclick="initiateFileTransfer('${f.id}')">MOVE</button>
            <button class="btn-cyber-main" style="padding: 2px 8px; font-size: 0.8rem; background: #ff4d4d;" onclick="deleteRecord('${f.id}')">DELETE</button></td>
        </tr>
    `).join('') || '<tr><td colspan="5" style="text-align:center; opacity:0.5;">EMPTY BOX</td></tr>';

    listContainer.innerHTML = `
        <div class="card-cyber scroll-list">
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <h3>CONTENTS OF <span id="box-id-display">${escapeHtml(box.id)}</span></h3>
                <button class="btn-cyber-main" onclick="initiateBoxTransfer('${box.docId}')" style="font-size: 0.8rem;">TRANSFER BOX</button>
            </div>
            <input type="text" id="box-search" onkeyup="filterBoxContents()" placeholder="SEARCH FILES..." class="input-cyber" style="margin-bottom: 10px;">
            <table class="monitor-table">
                <thead>
                    <tr>
                        <th>FILE #</th>
                        <th>FILE NAME</th>
                        <th>FULL NAME</th>
                        <th>FILE DATE</th>
                        <th>ACTION</th>
                    </tr>
                </thead>
                <tbody id="box-files-body">${filesHtml}</tbody>
            </table>
        </div>
    `;

    filterBoxContents();
}

function renderNotes(notes) {
    const grid = document.getElementById('sticky-notes-grid');
    if (!grid) return;
    
    grid.innerHTML = Object.entries(notes).map(([id, note]) => `
        <div class="note-card">
            <div class="note-content">${escapeHtml(note.text)}</div>
            <div class="note-footer">
                <span>${note.time.split(',')[0]}</span>
                <i class="fas fa-times" onclick="deleteStickyNote('${id}')"></i>
            </div>
        </div>
    `).join('');
}

function refreshRackView() {
    const rack = shelvingDatabase.find(r => r.id === currentRackId);
    if (!rack) return;

    const titleEl = document.getElementById('current-rack-title');
    if (titleEl) titleEl.innerText = `RACK SHELVES: ${rack.id}`;
    
    const grid = document.getElementById('box-grid');
    if (!grid) return;

    grid.innerHTML = (rack.boxes || []).map(box => {
        const isHighlighted = highlightedBlockId && box.id === highlightedBlockId;
        const highlightClass = isHighlighted ? 'highlight-glow' : '';
        
        return `
        <div class="card-cyber ${highlightClass}" id="block-${box.id}">
            <button class="delete-btn" style="right: 45px;" onclick="initiateBoxTransfer('${box.docId}')" title="TRANSFER BOX"><i class="fas fa-exchange-alt"></i></button>
            <button class="delete-btn" onclick="deleteBox('${box.docId}')" title="DELETE BOX"><i class="fas fa-trash"></i></button>
            <i class="fas fa-cube" style="font-size: 2rem; color: var(--primary); margin-bottom: 10px;"></i>
            <h3>${escapeHtml(box.id)}</h3>
            ${box.origin ? `<div style="color: #ff9800; font-size: 0.7rem; margin-bottom: 5px; font-weight:bold;">FROM: ${escapeHtml(box.origin)}</div>` : ''}
            <p>${(box.files || []).length} RECORDS</p>
            <button class="btn-cyber-main" onclick="openBox('${box.id}', '${box.docId}')">ACCESS BOX</button>
        </div>
    `}).join('');
}
async function addNode() {
    let nextId = "RACK-01";
    if (shelvingDatabase.length > 0) {
        let maxNum = 0;
        let prefix = "RACK-";
        let hasNumber = false;

        shelvingDatabase.forEach(n => {
            const match = n.id.match(/^(.*?)(\d+)$/);
            if (match) {
                hasNumber = true;
                const num = parseInt(match[2], 10);
                if (num > maxNum) {
                    maxNum = num;
                    prefix = match[1];
                }
            }
        });

        if (hasNumber) nextId = `${prefix}${(maxNum + 1).toString().padStart(2, '0')}`;
        else nextId = `RACK-${(shelvingDatabase.length + 1).toString().padStart(2, '0')}`;
    }

    const id = await showInputModal("+ADD NEW RACK", "e.g., RACK-01", "RACK SHELVES ID", nextId);
    if (id) {
        if (/[.$#[\]/]/.test(id)) return showNotification("INVALID CHARACTERS");
        await fetch('/api/nodes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': localStorage.getItem('authToken') },
            body: JSON.stringify({ nodeId: id.trim().toUpperCase() })
        });
        showNotification("RACK SHELVES ONLINE");
        fetchData();
    }
}

async function addBox() {
    if (!currentRackId) return;
    
    let nextId = "BOX-01";
    const rack = shelvingDatabase.find(r => r.id === currentRackId);
    
    if (rack && rack.boxes && rack.boxes.length > 0) {
        let maxNum = 0;
        let prefix = "BOX-";
        let hasNumber = false;

        rack.boxes.forEach(b => {
            const match = b.id.match(/^(.*?)(\d+)$/);
            if (match) {
                hasNumber = true;
                const num = parseInt(match[2], 10);
                if (num > maxNum) {
                    maxNum = num;
                    prefix = match[1];
                }
            }
        });

        if (hasNumber) nextId = `${prefix}${(maxNum + 1).toString().padStart(2, '0')}`;
        else nextId = `BOX-${(rack.boxes.length + 1).toString().padStart(2, '0')}`;
    }

    const blockId = await showInputModal("ENTER BOX ID", "e.g., BOX-01", "BOX ID", nextId);
    if (!blockId) return;
    
    if (rack?.boxes?.length >= 40) return showNotification("RACK SHELVES FULL");

    await fetch('/api/blocks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': localStorage.getItem('authToken') },
        body: JSON.stringify({ blockId: blockId.trim().toUpperCase(), nodeId: currentRackId })
    });
    showNotification("BOX INITIALIZED");
    fetchData();
}

async function addFile() {
    const rack = shelvingDatabase.find(r => r.id === currentRackId);
    const box = rack?.boxes.find(b => b.id === currentBoxId);
    if (box && (box.files || []).length >= 500) return showNotification("BOX FULL (MAX 500)");

    const file = {
        fileNumber: document.getElementById('file-number').value,
        fileName: document.getElementById('file-name').value,
        fullName: document.getElementById('full-name').value,
        fileDate: document.getElementById('file-date').value
    };

    if (Object.values(file).some(v => !v)) return showNotification("FIELDS REQUIRED");

    try {
        const res = await fetch('/api/records', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': localStorage.getItem('authToken') },
            body: JSON.stringify({ ...file, blockId: currentBoxId, blockDocId: null, nodeId: currentRackId })
        });
        if (!res.ok) throw new Error("Save failed");
        
        showNotification("RECORD UPLOADED");
        fetchData();
        ['file-number', 'file-name', 'full-name', 'file-date'].forEach(id => document.getElementById(id).value = '');
    } catch (err) {
        console.error(err);
        showNotification("UPLOAD FAILED");
    }
}

async function addStickyNote() {
    const text = document.getElementById('note-text').value;
    if (!text) return showNotification("EMPTY NOTE");

    const time = new Date().toLocaleString();
    await fetch('/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': localStorage.getItem('authToken') },
        body: JSON.stringify({ text, time })
    });
    
    document.getElementById('note-text').value = '';
    showNotification("NOTE PINNED");
    fetchData();
}

let modalResolve = null;
function showInputModal(title, placeholder = "", label = "", defaultValue = "") {
    return new Promise((resolve) => {
        const modal = document.getElementById('custom-modal');
        const inputEl = document.getElementById('modal-input');
        const labelEl = document.getElementById('modal-label');
        
        document.getElementById('modal-title').innerText = title;
        if (labelEl) {
            labelEl.style.display = label ? 'block' : 'none';
            if (label) labelEl.innerText = label;
        }
        
        inputEl.value = defaultValue;
        inputEl.placeholder = placeholder;
        modal.classList.add('active');
        inputEl.focus();
        if (defaultValue) inputEl.select();
        modalResolve = resolve;
    });
}

window.closeModal = (confirmed) => {
    const modal = document.getElementById('custom-modal');
    modal.classList.remove('active');
    if (modalResolve) {
        modalResolve(confirmed ? document.getElementById('modal-input').value : null);
        modalResolve = null;
    }
};

window.initiateFileTransfer = (id) => {
    transferState = { type: 'FILE', id: id };
    document.getElementById('transfer-modal-title').innerText = "TRANSFER FILE";
    document.getElementById('transfer-block-wrapper').style.display = 'block';
    openTransferModal();
};
window.initiateBoxTransfer = (id) => {
    transferState = { type: 'BLOCK', id: id };
    document.getElementById('transfer-modal-title').innerText = "TRANSFER BOX";
    document.getElementById('transfer-block-wrapper').style.display = 'none';
    openTransferModal();
};

function openTransferModal() {
    const nodeSelect = document.getElementById('transfer-node-select');
    nodeSelect.innerHTML = shelvingDatabase.map(n => `<option value="${n.id}">${n.id}</option>`).join('');

    if (currentRackId) {
        nodeSelect.value = currentRackId;
    }

    document.getElementById('transfer-modal').style.display = 'flex';
    updateTransferBlockOptions();
}
function updateTransferBlockOptions() {
    const nodeId = document.getElementById('transfer-node-select').value;
    const blockSelect = document.getElementById('transfer-block-select');
    blockSelect.innerHTML = '';
    const node = shelvingDatabase.find(n => n.id === nodeId);
    if (node && node.boxes) {
        blockSelect.innerHTML = node.boxes.map(b => {
            const label = b.origin ? `${b.id} (FROM: ${b.origin})` : b.id;
            return `<option value="${b.docId}">${label}</option>`;
        }).join('');
    }
}

window.closeTransferModal = () => document.getElementById('transfer-modal').style.display = 'none';
window.confirmTransfer = async () => {
    const targetNodeId = document.getElementById('transfer-node-select').value;
    const targetBlockId = document.getElementById('transfer-block-select').value;

    if (!targetNodeId) return showNotification("SELECT TARGET RACK");
    if (transferState.type === 'FILE' && !targetBlockId) return showNotification("SELECT TARGET BOX");

    const url = transferState.type === 'FILE' ? `/api/records/${transferState.id}/move` : `/api/blocks/${transferState.id}/move`;
    const body = transferState.type === 'FILE' ? { targetNodeId, targetBlockId } : { targetNodeId, targetBlockId: null };
    
    try {
        const res = await fetch(url, { 
            method: 'PUT', 
            headers: {'Content-Type': 'application/json', 'Authorization': localStorage.getItem('authToken')}, 
            body: JSON.stringify(body) 
        });
        if (!res.ok) throw new Error("Transfer failed");
        
        closeTransferModal();
        showNotification("TRANSFER COMPLETE");
        fetchData();
    } catch (err) {
        console.error(err);
        showNotification("TRANSFER FAILED");
    }
};

function updateStats() {
    let n = shelvingDatabase.length, b = 0, f = 0;
    shelvingDatabase.forEach(node => {
        const boxes = node.boxes || [];
        b += boxes.length;
        boxes.forEach(box => f += (box.files || []).length);
    });
    document.getElementById('stat-racks').innerText = n;
    document.getElementById('stat-boxes').innerText = b;
    document.getElementById('stat-files').innerText = f;
}

function setupTooltips() {
    const tooltip = document.createElement('div');
    tooltip.className = 'cyber-tooltip';
    document.body.appendChild(tooltip);

    document.addEventListener('mouseover', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;

        let text = btn.getAttribute('data-tooltip') || btn.getAttribute('title') || btn.innerText;
        
        if (!text || text.trim() === '') {
            if (btn.querySelector('.fa-trash')) text = "DELETE";
            else if (btn.querySelector('.fa-exchange-alt')) text = "TRANSFER";
            else if (btn.querySelector('.fa-plus')) text = "ADD";
            else if (btn.querySelector('.fa-download')) text = "BACKUP";
            else if (btn.querySelector('.fa-print')) text = "PRINT";
            else if (btn.querySelector('.fa-sign-out-alt')) text = "LOGOUT";
        }
        
        if (text && text.trim() !== '') {
            if (btn.hasAttribute('title')) {
                btn.setAttribute('data-original-title', btn.getAttribute('title'));
                btn.removeAttribute('title');
            }
            
            tooltip.innerText = text;
            tooltip.style.display = 'block';
            
            const rect = btn.getBoundingClientRect();
            tooltip.style.top = (rect.top - 35) + 'px';
            tooltip.style.left = (rect.left + (rect.width / 2) - (tooltip.offsetWidth / 2)) + 'px';
            
            if (parseInt(tooltip.style.top) < 0) tooltip.style.top = (rect.bottom + 5) + 'px';
            if (parseInt(tooltip.style.left) < 0) tooltip.style.left = '5px';
        }
    });

    document.addEventListener('mouseout', (e) => {
        const btn = e.target.closest('button');
        if (btn) {
            tooltip.style.display = 'none';
            if (btn.hasAttribute('data-original-title')) {
                btn.setAttribute('title', btn.getAttribute('data-original-title'));
                btn.removeAttribute('data-original-title');
            }
        }
    });
}

function openRack(nodeId, blockId = null) {
    currentRackId = nodeId;
    highlightedBlockId = blockId;
    showSection('single-shelf-view');
    refreshRackView();

    if (blockId) {
        if (highlightTimeout) clearTimeout(highlightTimeout);

        setTimeout(() => {
            const el = document.getElementById(`block-${blockId}`);
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 500);

        highlightTimeout = setTimeout(() => {
            highlightedBlockId = null;
            refreshRackView();
        }, 30000);
    }
}

function openBox(boxId) {
    currentBoxId = boxId;
    showSection('box-detail-view');
    document.getElementById('box-num-display').innerText = `BOX: ${boxId}`;
    const list = document.getElementById('current-box-list');
    if(list) list.innerHTML = '';
    updateBoxFileList();
}

function showNotification(text) {
    const popup = document.getElementById('notification');
    document.getElementById('notification-text').innerText = text;
    popup.classList.add('show');
    setTimeout(() => popup.classList.remove('show'), 2000);
}
function toggleTheme() {
    const html = document.documentElement;
    const current = html.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    html.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
}

function togglePassword(inputId, icon) {
    const input = document.getElementById(inputId);
    if (input.type === "password") {
        input.type = "text";
        icon.classList.add("fa-eye-slash");
    } else {
        input.type = "password";
        icon.classList.remove("fa-eye-slash");
        icon.classList.add("fa-eye");
    }
}

window.showSection = showSection;
window.addNode = addNode;
window.addBox = addBox;
window.addFile = addFile;
window.addStickyNote = addStickyNote;
window.openRack = openRack;
window.openBox = openBox;
window.handleLogin = handleLogin;
window.handleRegister = handleRegister;
window.toggleAuthMode = toggleAuthMode;
window.toggleTheme = toggleTheme;
window.togglePassword = togglePassword;
window.handleCloudShare = handleCloudShare;
window.logout = () => {
    localStorage.removeItem('isAuthenticated');
    localStorage.removeItem('currentUser');
    localStorage.removeItem('authToken');
    window.location.reload();
};
window.deleteNode = async (id) => {
    if (confirm("DELETE RACK SHELVES?")) {
        try {
            const res = await fetch(`/api/nodes/${encodeURIComponent(id)}`, { 
                method: 'DELETE',
                headers: { 'Authorization': localStorage.getItem('authToken') }
            });
            if (!res.ok) throw new Error("Delete failed");
            showNotification("RACK SHELVES DELETED");
            fetchData();
        } catch (err) {
            console.error(err);
            showNotification("DELETE FAILED");
        }
    }
};
window.deleteBox = async (id) => {
    if (confirm("DELETE BOX?")) {
        try {
            const res = await fetch(`/api/blocks/${id}`, { 
                method: 'DELETE',
                headers: { 'Authorization': localStorage.getItem('authToken') }
            });
            if (!res.ok) throw new Error("Delete failed");
            showNotification("BOX DELETED");
            fetchData();
        } catch (err) {
            console.error(err);
            showNotification("DELETE FAILED");
        }
    }
};
window.deleteRecord = async (id) => {
    if (confirm("DELETE RECORD?")) {
        try {
            const res = await fetch(`/api/records/${encodeURIComponent(id)}`, { 
                method: 'DELETE',
                headers: { 'Authorization': localStorage.getItem('authToken') }
            });
            if (!res.ok) throw new Error("Delete failed");
            showNotification("RECORD DELETED");
            fetchData();
        } catch (err) {
            console.error(err);
            showNotification("DELETE FAILED");
        }
    }
};
window.deleteStickyNote = async (id) => {
    if(confirm("DELETE NOTE?")) {
        try {
            const res = await fetch(`/api/notes/${id}`, { 
                method: 'DELETE',
                headers: { 'Authorization': localStorage.getItem('authToken') }
            });
            if (!res.ok) throw new Error("Delete failed");
            fetchData();
        } catch (err) {
            console.error(err);
            showNotification("DELETE FAILED");
        }
    }
};
window.filterBoxContents = () => {
    const input = document.getElementById('box-search');
    if (!input) return;
    const filter = input.value.toUpperCase();
    const tbody = document.getElementById('box-files-body');
    if (!tbody) return;
    const tr = tbody.getElementsByTagName('tr');
    for (let i = 0; i < tr.length; i++) {
        const td = tr[i].getElementsByTagName('td');
        if (td.length > 0) {
            let txtValue = "";
            for(let j=0; j < td.length - 1; j++) {
                txtValue += (td[j].textContent || "") + " ";
            }
            if (txtValue.toUpperCase().indexOf(filter) > -1) {
                tr[i].style.display = "";
            } else {
                tr[i].style.display = "none";
            }
        }
    }
};
window.filterDatabase = () => {
    const input = document.getElementById('db-search');
    const filter = input.value.toUpperCase();
    const table = document.getElementById('db-body');
    const tr = table.getElementsByTagName('tr');
    for (let i = 0; i < tr.length; i++) {
        const td = tr[i].getElementsByTagName('td');
        let txtValue = "";
        for(let j=0; j<td.length; j++){
            if(td[j]) txtValue += td[j].textContent || td[j].innerText;
        }
        if (txtValue.toUpperCase().indexOf(filter) > -1) {
            tr[i].style.display = "";
        } else {
            tr[i].style.display = "none";
        }
    }
};
window.backupDatabase = async () => {
    try {
        const data = db.export();
        const blob = new Blob([data], { type: 'application/x-sqlite3' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const date = new Date().toISOString().slice(0,10);
        a.download = `STORAGE_SYSTEM_BACKUP_${date}.db`;
        a.click();
        window.URL.revokeObjectURL(url);
        showNotification("DATABASE EXPORTED");
    } catch(e) {
        console.error(e);
        showNotification("BACKUP FAILED");
    }
};
window.restoreDatabase = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.db,.sqlite,.sqlite3';
    input.style.display = 'none';
    document.body.appendChild(input);
    
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        if (!confirm("WARNING: THIS WILL OVERWRITE YOUR CURRENT DATABASE. ARE YOU SURE?")) {
            document.body.removeChild(input);
            return;
        }

        const reader = new FileReader();
        reader.onload = async function() {
            try {
                const u8 = new Uint8Array(this.result);
                const testDb = new SQL.Database(u8);
                testDb.close();

                const store = await getDBStore('readwrite');
                store.put(u8, SYSTEM_CONFIG.DB.KEY).onsuccess = () => {
                    showNotification("DATABASE RESTORED");
                    setTimeout(() => window.location.reload(), 1000);
                };
            } catch (err) { showNotification("INVALID DB FILE"); }
            finally { document.body.removeChild(input); }
        };
        reader.readAsArrayBuffer(file);
    };
    input.click();
};

// --- CLOUD SHARING LOGIC ---

async function handleCloudShare() {
    let apiKey = localStorage.getItem('jsonbin_key');
    if (!apiKey) {
        apiKey = await showInputModal("API KEY REQUIRED", "ENTER JSONBIN.IO MASTER KEY", "ONE-TIME SETUP");
        if (apiKey) {
            apiKey = apiKey.trim();
            localStorage.setItem('jsonbin_key', apiKey);
        } else return;
    } else {
        apiKey = apiKey.trim();
    }

    showNotification("GENERATING LINK...");
    
    try {
        const data = db.export();
        // Convert binary DB to Base64 string for JSON storage
        const binaryString = Array.from(data).map(b => String.fromCharCode(b)).join('');
        const base64Data = btoa(binaryString);

        const res = await fetch('https://api.jsonbin.io/v3/b', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Master-Key': apiKey,
                'X-Bin-Private': 'false' // Public so others can read it without key
            },
            body: JSON.stringify({
                timestamp: new Date().toISOString(),
                db_data: base64Data
            })
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({ message: "Upload Failed" }));
            
            if (res.status === 401 || (err.message && err.message.includes("Master Key"))) {
                localStorage.removeItem('jsonbin_key');
                throw new Error("INVALID MASTER KEY. Key has been reset. Please try again.");
            }
            throw new Error(err.message || "Upload Failed");
        }
        
        const json = await res.json();
        const binId = json.metadata.id;
        
        const shareUrl = `${window.location.origin}${window.location.pathname}?sync_id=${binId}`;
        
        // Copy to clipboard
        await navigator.clipboard.writeText(shareUrl);
        
        // Show user
        await showInputModal("SHAREABLE LINK GENERATED", "", "LINK COPIED TO CLIPBOARD", shareUrl);
        
    } catch (e) {
        console.error(e);
        showNotification("UPLOAD FAILED");
        
        if (localStorage.getItem('jsonbin_key')) {
            if(confirm(`Error: ${e.message}\n\nAPI Key might be invalid. Reset key?`)) localStorage.removeItem('jsonbin_key');
        } else {
            alert(`ERROR: ${e.message}`);
        }
    }
}

async function fetchCloudSnapshot(binId) {
    // We don't need the API Key to READ if the bin is public, or we can use a specific read key.
    // For JSONBin, if the bin is public, no header is needed.
    const res = await fetch(`https://api.jsonbin.io/v3/b/${binId}/latest`);
    if (!res.ok) return null;
    
    const json = await res.json();
    const base64Data = json.record.db_data;
    const binaryString = atob(base64Data);
    return new Uint8Array(binaryString.split('').map(c => c.charCodeAt(0)));
}

initApp();

setInterval(() => {
    const clock = document.getElementById('live-clock');
    if (clock) {
        const t = new Date().toLocaleTimeString('en-US');
        clock.innerHTML = t.replace(/(AM|PM)/, '<span onclick="window.location.href=\'master.html\'" style="cursor:default">$1</span>');
    }
}, 1000);

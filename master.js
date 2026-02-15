let db = null;
let SQL = null;
let currentTable = 'users';
let currentColumns = [];
let editingRowId = null;

const SYSTEM_CONFIG = {
    DB: { NAME: 'QuantumSystemDB', STORE: 'sqlite_store', KEY: 'db_file' }
};

async function init() {
    try {
        const config = { locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/${file}` };
        SQL = await initSqlJs(config);

        const store = await getDBStore('readonly');
        const savedData = await new Promise((resolve) => {
            const req = store.get(SYSTEM_CONFIG.DB.KEY);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
        });
        
        if (savedData) {
            db = new SQL.Database(new Uint8Array(savedData));
            checkAuth();
        } else {
            alert("NO DATABASE FOUND. Please initialize the app in index.html first.");
            window.location.href = 'index.html';
        }
    } catch (e) { console.error(e); alert("DB Error: " + e.message); }
}

function checkAuth() {
    if (sessionStorage.getItem('masterAuth') === 'true') {
        showMainInterface();
    } else {
        document.getElementById('auth-interface').style.display = 'flex';
    }
}

function showMainInterface() {
    document.getElementById('auth-interface').style.display = 'none';
    document.getElementById('main-interface').style.display = 'block';
    renderNav();
    loadTable('users');
}

window.toggleMasterAuth = () => {
    const login = document.getElementById('login-form');
    const reg = document.getElementById('register-form');
    if (login.style.display === 'none') {
        login.style.display = 'block';
        reg.style.display = 'none';
    } else {
        login.style.display = 'none';
        reg.style.display = 'block';
    }
};

window.handleMasterLogin = async () => {
    const u = document.getElementById('master-user').value.trim().toLowerCase();
    const p = document.getElementById('master-pass').value;
    if (!u || !p) return alert("CREDENTIALS REQUIRED");

    const hash = await hashPassword(p);
    const res = db.exec("SELECT * FROM users WHERE username=? AND password=?", [u, hash]);
    
    if (res.length && res[0].values.length) {
        sessionStorage.setItem('masterAuth', 'true');
        showMainInterface();
    } else {
        alert("INVALID CREDENTIALS");
    }
};

window.handleMasterRegister = async () => {
    const u = document.getElementById('reg-user').value.trim().toLowerCase();
    const p = document.getElementById('reg-pass').value;
    if (!u || !p) return alert("FIELDS REQUIRED");

    const countRes = db.exec("SELECT COUNT(*) FROM users");
    if (countRes[0].values[0][0] > 0) return alert("REGISTRATION IS CLOSED");

    const hash = await hashPassword(p);
    db.run("INSERT INTO users VALUES (?, ?, ?)", [uuid(), u, hash]);
    await saveDB();
    
    alert("REGISTRATION COMPLETE");
    window.toggleMasterAuth();
    document.getElementById('master-user').value = u;
    document.getElementById('master-pass').value = p;
};

function getDBStore(mode) {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(SYSTEM_CONFIG.DB.NAME, 1);
        request.onupgradeneeded = (e) => {
            if (!e.target.result.objectStoreNames.contains(SYSTEM_CONFIG.DB.STORE)) {
                e.target.result.createObjectStore(SYSTEM_CONFIG.DB.STORE);
            }
        };
        request.onsuccess = (e) => {
            const db = e.target.result;
            const tx = db.transaction(SYSTEM_CONFIG.DB.STORE, mode);
            resolve(tx.objectStore(SYSTEM_CONFIG.DB.STORE));
        };
        request.onerror = (e) => reject(e);
    });
}

async function saveDB() {
    const data = db.export();
    const store = await getDBStore('readwrite');
    store.put(data, SYSTEM_CONFIG.DB.KEY);
    alert("DATABASE SAVED TO DISK");
}

function renderNav() {
    const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")[0].values.flat();
    const nav = document.getElementById('table-nav');
    nav.innerHTML = tables.map(t => 
        `<button class="nav-btn ${t === currentTable ? 'active' : ''}" onclick="loadTable('${t}')">${t.toUpperCase()}</button>`
    ).join('');
}

function loadTable(tableName) {
    currentTable = tableName;
    renderNav();
    
    // Get Schema
    const schemaRes = db.exec(`PRAGMA table_info(${tableName})`);
    currentColumns = schemaRes[0].values.map(col => ({ name: col[1], type: col[2], pk: col[5] }));
    
    // Get Data
    const dataRes = db.exec(`SELECT * FROM ${tableName}`);
    const rows = dataRes.length ? dataRes[0].values : [];

    // Render Header
    const thead = document.getElementById('table-head');
    thead.innerHTML = `<tr>
        ${currentColumns.map(c => `<th>${c.name.toUpperCase()}</th>`).join('')}
        <th style="width: 100px;">ACTIONS</th>
    </tr>`;

    // Render Body
    const tbody = document.getElementById('table-body');
    tbody.innerHTML = rows.map(row => {
        const pkColIndex = currentColumns.findIndex(c => c.pk === 1);
        let actionButtons = '';

        if (pkColIndex !== -1) {
            const pkValue = row[pkColIndex];
            const safePk = String(pkValue).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            actionButtons = `
                <button class="action-btn" onclick="editRow('${safePk}')"><i class="fas fa-edit"></i></button>
                <button class="action-btn delete" onclick="deleteRow('${safePk}')"><i class="fas fa-trash"></i></button>
            `;
        }
        
        return `<tr>
            ${row.map(cell => `<td title="${cell}">${cell === null ? 'NULL' : cell}</td>`).join('')}
            <td>${actionButtons}</td>
        </tr>`;
    }).join('');
}

function openModal(pkValue = null) {
    editingRowId = pkValue;
    const modal = document.getElementById('crud-modal');
    const title = document.getElementById('modal-title');
    const form = document.getElementById('modal-form');
    
    title.innerText = pkValue ? `EDIT ${currentTable.toUpperCase()}` : `ADD TO ${currentTable.toUpperCase()}`;
    
    let rowData = null;
    if (pkValue) {
        const pkCol = currentColumns.find(c => c.pk === 1).name;
        const res = db.exec(`SELECT * FROM ${currentTable} WHERE ${pkCol} = ?`, [pkValue]);
        if (res.length) rowData = res[0].values[0];
    }

    form.innerHTML = currentColumns.map((col, index) => {
        const val = rowData ? rowData[index] : '';
        const isPk = col.pk === 1;
        const defaultVal = (!pkValue && isPk) ? uuid() : val;
        
        return `<div class="form-group">
            <label>${col.name.toUpperCase()} ${isPk ? '(PRIMARY KEY)' : ''}</label>
            <input type="text" id="field-${col.name}" value="${defaultVal}" ${isPk && pkValue ? 'disabled' : ''}>
        </div>`;
    }).join('');
    
    modal.classList.add('show');
}

function closeModal() {
    document.getElementById('crud-modal').classList.remove('show');
}

async function submitForm() {
    const values = [];
    const pkCol = currentColumns.find(c => c.pk === 1);
    
    for (let col of currentColumns) {
        let val = document.getElementById(`field-${col.name}`).value;
        // Auto-hash password if it looks like plain text (not 64 chars hex)
        if (currentTable === 'users' && col.name === 'password' && val.length !== 64) {
             val = await hashPassword(val);
        }
        values.push(val);
    }

    try {
        if (editingRowId) {
            const setClause = currentColumns.map(c => `${c.name} = ?`).join(', ');
            const params = [...values, editingRowId];
            db.run(`UPDATE ${currentTable} SET ${setClause} WHERE ${pkCol.name} = ?`, params);
        } else {
            const placeholders = values.map(() => '?').join(', ');
            db.run(`INSERT INTO ${currentTable} VALUES (${placeholders})`, values);
        }
        await saveDB();
        closeModal();
        loadTable(currentTable);
    } catch (e) { alert("Error: " + e.message); }
}

async function deleteRow(pkValue) {
    if (!confirm("DELETE ROW?")) return;
    
    try {
        const pkColObj = currentColumns.find(c => c.pk === 1);
        if (!pkColObj) throw new Error("Primary Key not found");
        const pkCol = pkColObj.name;

        if (currentTable === 'nodes') {
            const res = db.exec("SELECT nodeId FROM nodes WHERE docId = ?", [pkValue]);
            if (res.length && res[0].values.length) {
                const nodeId = res[0].values[0][0];
                db.run("DELETE FROM blocks WHERE nodeId = ?", [nodeId]);
                db.run("DELETE FROM records WHERE nodeId = ?", [nodeId]);
            }
        } else if (currentTable === 'blocks') {
            db.run("DELETE FROM records WHERE blockDocId = ?", [pkValue]);
        }

        db.run(`DELETE FROM ${currentTable} WHERE ${pkCol} = ?`, [pkValue]);
        await saveDB();
        loadTable(currentTable);
    } catch (e) { alert("DELETE FAILED: " + e.message); }
}

window.editRow = (id) => openModal(id);
window.deleteRow = deleteRow;

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).substr(2));
async function hashPassword(p) { const m = new TextEncoder().encode(p); const h = await crypto.subtle.digest('SHA-256', m); return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join(''); }

window.togglePassword = (inputId, icon) => {
    const input = document.getElementById(inputId);
    if (input.type === "password") {
        input.type = "text";
        icon.classList.add("fa-eye-slash");
    } else {
        input.type = "password";
        icon.classList.remove("fa-eye-slash");
        icon.classList.add("fa-eye");
    }
};

init();

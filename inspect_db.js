#!/usr/bin/env node
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');

const args = process.argv.slice(2);
let dbPath = null;
let mode = 'check';

// Parse command line arguments
for (let i = 0; i < args.length; i++) {
    if (args[i] === '-data') {
        dbPath = args[i + 1];
        i++;
    } else {
        mode = args[i]; // e.g., 'check'
    }
}

if (!dbPath) {
    console.log("Usage: node inspect_db.js -data <path-to-db-file> [check|users]");
    process.exit(1);
}

if (!fs.existsSync(dbPath)) {
    console.error(`\n[ERROR] File not found: "${dbPath}"`);
    const files = fs.readdirSync('.').filter(f => f.endsWith('.db') || f.endsWith('.sqlite'));
    if (files.length > 0) {
        console.log("Found these files in current directory:");
        files.forEach(f => console.log(`  node inspect_db.js -data "${f}" ${mode}`));
    } else {
        console.log("No .db files found in current directory.");
        console.log("Tip: Check your Downloads folder for the exported backup.");
    }
    process.exit(1);
}

const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
    if (err) {
        console.error("Connection Error:", err.message);
        process.exit(1);
    }
});

if (mode === 'check') {
    console.log(`\n--- INSPECTING DATABASE: ${dbPath} ---\n`);
    db.serialize(() => {
        db.all("SELECT name FROM sqlite_master WHERE type='table'", (err, tables) => {
            if (err) return console.error(err);
            
            if (tables.length === 0) {
                console.log("No tables found.");
            } else {
                tables.forEach(table => {
                    db.get(`SELECT COUNT(*) as count FROM ${table.name}`, (err, row) => {
                        if (!err) console.log(`TABLE [${table.name.padEnd(10)}]: ${row.count} rows`);
                    });
                });
            }
        });
    });
} else if (mode === 'users') {
    console.log(`\n--- LISTING USERS ---\n`);
    db.all("SELECT id, username, password FROM users", (err, rows) => {
        if (err) console.error(err.message);
        else console.table(rows);
    });
}

db.close();

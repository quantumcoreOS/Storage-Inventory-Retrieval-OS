# Storage Inventory & Retrieval System

A secure, offline-first inventory management system designed for static hosting environments like GitHub Pages. This application runs entirely in the browser using WebAssembly (SQLite) and IndexedDB for data persistence.

## Features

*   **Secure Client-Side Database**: Uses `sql.js` (SQLite via WebAssembly) to run a full SQL database inside your browser. No backend server required.
*   **Data Persistence**: Automatically saves your database to the browser's IndexedDB.
*   **Authentication**: Secure login system with client-side password hashing (SHA-256).
*   **Inventory Management**: Manage Racks, Boxes, and Files with a hierarchical structure.
*   **Transfer System**: Move boxes between racks or files between boxes with conflict resolution.
*   **Backup & Restore**: Export your entire database as a `.db` file for safe keeping.
*   **Dark/Light Mode**: Cyberpunk-inspired UI with theme toggling.

## Installation & Usage

### Local Usage
1.  Clone or download this repository.
2.  Open `index.html` in a modern web browser.
    *   *Note*: For full security features (crypto API), some browsers require serving via `localhost` or HTTPS, though a fallback is included for `file://` access.

### Deployment (GitHub Pages)
1.  Upload these files to a GitHub repository.
    *   `index.html`, `style.css`, `script.js`, `README.md`, `.gitignore`
2.  Go to **Settings** > **Pages**.
3.  Select the `main` branch as the source and save.
4.  Your system is now live and secure!

### Deployment (Netlify / Vercel)
1.  Simply drag and drop the project folder into the deployment dashboard.
2.  No build configuration is required (it is a static site).

## Security Note

This system is designed as a "Single Player" application.
*   **Data Privacy**: Your inventory data lives **only** in your browser. It is never sent to GitHub or any external server.
*   **Code Security**: Default credentials are hashed in the source code to prevent plain-text exposure.
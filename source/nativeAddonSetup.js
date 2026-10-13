// Self-extracts pkg-embedded assets that native code needs to open as real
// files, so a single distributed kioskservice.exe works without also
// copying `addons\canvas`, `fonts`, and `scripts` folders next to it.
//
// Why this is needed (same root cause, three places it bites):
//
// 1. canvas.node's own DLL dependencies (~40 files: libcairo, libpango,
//    libharfbuzz, libfontconfig, ...) are resolved by the Windows loader
//    via the DLL search path when canvas.node itself is loaded — this
//    happens outside of Node's require() system, so pkg has no way to
//    auto-extract them the way it does for canvas.node itself.
//
// 2. canvas's registerFont() opens font files via native (non-Node) file
//    I/O, using a plain path string. That native I/O has no knowledge of
//    pkg's virtual snapshot filesystem, so it cannot read an embedded font
//    file even though Node's own fs.readFileSync can.
//
// 3. Send-RawPrint.ps1 is launched as a separate `powershell.exe -File`
//    process (see amq/printService.js) — same problem, a different process
//    entirely can't see the snapshot.
//
// All three need a REAL file on REAL disk. We embed the folders as pkg
// assets (see package.json -> pkg.assets) and copy them out on first run.
//
// Every step below logs with the "[KioskNative]" prefix — if this still
// fails on a given machine, `grep KioskNative` (or Select-String) on
// log\service-stdout.log / service-stderr.log will show exactly which
// candidate directory was tried and why it didn't work (permission denied,
// disk full, antivirus having deleted a just-written file, etc.), instead
// of failing silently and leaving you guessing.
const fs = require('fs');
const path = require('path');
const os = require('os');

function log(msg) {
    console.log(`[KioskNative] ${msg}`);
}
function warn(msg) {
    console.warn(`[KioskNative] ${msg}`);
}

function copyDirSync(srcDir, destDir) {
    fs.mkdirSync(destDir, { recursive: true });
    for (const name of fs.readdirSync(srcDir)) {
        const srcPath = path.join(srcDir, name);
        const destPath = path.join(destDir, name);
        if (fs.statSync(srcPath).isDirectory()) {
            copyDirSync(srcPath, destPath);
        } else {
            fs.writeFileSync(destPath, fs.readFileSync(srcPath));
        }
    }
}

// True only if every file that should have been extracted is actually
// present on disk AND the right size. Catches partial copies (interrupted,
// disk full) and files removed/altered after the fact (e.g. by antivirus
// quarantining a freshly-written, unsigned DLL) — both of which would
// otherwise look "already extracted" forever and silently misbehave.
function isIntact(embeddedDir, targetDir) {
    let names;
    try {
        names = fs.readdirSync(embeddedDir);
    } catch (e) {
        warn(`Cannot read embedded source ${embeddedDir}: ${e.message}`);
        return false;
    }
    for (const name of names) {
        const embeddedPath = path.join(embeddedDir, name);
        const targetPath = path.join(targetDir, name);
        if (fs.statSync(embeddedPath).isDirectory()) {
            if (!isIntact(embeddedPath, targetPath)) return false;
            continue;
        }
        let embeddedSize, targetSize;
        try {
            embeddedSize = fs.statSync(embeddedPath).size;
            targetSize = fs.statSync(targetPath).size;
        } catch (e) {
            return false; // target missing entirely
        }
        if (embeddedSize !== targetSize) {
            warn(`${targetPath} is ${targetSize} bytes, expected ${embeddedSize} — treating as corrupt/incomplete (antivirus quarantine is a common cause).`);
            return false;
        }
    }
    return true;
}

// Proves a directory is actually writable by this process/account right
// now, rather than assuming so and finding out mid-copy.
function canWriteTo(dir) {
    try {
        fs.mkdirSync(dir, { recursive: true });
        const probe = path.join(dir, `.write-test-${process.pid}`);
        fs.writeFileSync(probe, 'ok');
        fs.unlinkSync(probe);
        return true;
    } catch (e) {
        warn(`Directory not writable: ${dir} (${e.message})`);
        return false;
    }
}

// Extracts an embedded directory (relative to the app root) to the first
// writable, verifiably-intact candidate among:
//   1. next to the exe
//   2. C:\ProgramData\KioskService\... (standard writable location for
//      services regardless of where the exe itself lives)
//   3. %TEMP%\KioskService\...
// Returns the real (non-snapshot) directory to use, or null if every
// candidate failed (fully logged either way).
function extractDir(relativeDir) {
    const embeddedDir = path.join(__dirname, relativeDir);
    const candidates = [
        path.join(path.dirname(process.execPath), relativeDir),
        path.join(process.env.ProgramData || 'C:\\ProgramData', 'KioskService', relativeDir),
        path.join(os.tmpdir(), 'KioskService', relativeDir),
    ];

    for (const targetDir of candidates) {
        log(`Checking ${relativeDir} -> ${targetDir}`);
        if (!canWriteTo(targetDir)) continue;

        if (isIntact(embeddedDir, targetDir)) {
            log(`Already extracted and intact: ${targetDir}`);
            return targetDir;
        }

        try {
            copyDirSync(embeddedDir, targetDir);
            if (isIntact(embeddedDir, targetDir)) {
                log(`Extracted ${relativeDir} to ${targetDir}`);
                return targetDir;
            }
            warn(`Copied ${relativeDir} to ${targetDir} but integrity check failed afterwards (antivirus may have altered/removed files) — trying next location.`);
        } catch (e) {
            warn(`Failed to extract ${relativeDir} to ${targetDir}: ${e.message}`);
        }
    }

    warn(`Could not extract ${relativeDir} to any candidate location. If this is a locked-down machine, check antivirus/endpoint-protection logs for blocked writes to the paths logged above, and add an exclusion.`);
    return null;
}

let resolvedCanvasAddonsDir = null;

/**
 * Ensures the canvas native addon's dependent DLLs are present on real disk
 * and prepends their directory to PATH so Windows can resolve them when
 * canvas.node itself is loaded. Safe to call multiple times (cached).
 */
function ensureCanvasAddonsExtracted() {
    if (resolvedCanvasAddonsDir) return resolvedCanvasAddonsDir;

    if (!process.pkg) {
        resolvedCanvasAddonsDir = path.join(__dirname, 'addons', 'canvas');
    } else {
        resolvedCanvasAddonsDir = extractDir(path.join('addons', 'canvas'))
            || path.join(path.dirname(process.execPath), 'addons', 'canvas');
    }

    process.env.PATH = resolvedCanvasAddonsDir + ';' + (process.env.PATH || '');
    return resolvedCanvasAddonsDir;
}

let resolvedFontsDir = null;

/**
 * Ensures the bundled Catamaran font files are present on real disk (native
 * font loading can't read them straight out of the pkg snapshot) and
 * returns that directory. Safe to call multiple times (cached).
 */
function ensureFontsExtracted() {
    if (resolvedFontsDir) return resolvedFontsDir;

    if (!process.pkg) {
        resolvedFontsDir = path.join(__dirname, 'fonts');
    } else {
        resolvedFontsDir = extractDir('fonts')
            || path.join(path.dirname(process.execPath), 'fonts');
    }

    return resolvedFontsDir;
}

let resolvedScriptsDir = null;

/**
 * Ensures Send-RawPrint.ps1 is present on real disk — it's launched as a
 * separate `powershell.exe -File <path>` process (see amq/printService.js),
 * which, like the DLLs and fonts above, cannot read straight out of the pkg
 * snapshot. Returns that directory. Safe to call multiple times (cached).
 */
function ensureScriptsExtracted() {
    if (resolvedScriptsDir) return resolvedScriptsDir;

    if (!process.pkg) {
        resolvedScriptsDir = path.join(__dirname, 'scripts');
    } else {
        resolvedScriptsDir = extractDir('scripts')
            || path.join(path.dirname(process.execPath), 'scripts');
    }

    return resolvedScriptsDir;
}

/**
 * Snapshot of what got resolved/extracted where, for diagnostics (see
 * index.js -> GET /api/diagnostics/native). Does not trigger extraction —
 * call the ensure*() functions first if you need this to be populated.
 */
function getDiagnostics() {
    return {
        canvasAddonsDir: resolvedCanvasAddonsDir,
        fontsDir: resolvedFontsDir,
        scriptsDir: resolvedScriptsDir,
        isPkg: !!process.pkg,
        execPath: process.execPath,
    };
}

module.exports = { ensureCanvasAddonsExtracted, ensureFontsExtracted, ensureScriptsExtracted, getDiagnostics };

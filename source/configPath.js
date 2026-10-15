/**
 * Config Path Utility
 * 
 * Centralises the config file location for the KioskService.
 * The config is stored in a common, shared location on the system:
 *   - Windows: C:\ProgramData\KioskService\kiosk.netConfig
 *   - macOS/Linux (dev): ./kiosk.netConfig (project root)
 * 
 * The file uses .netConfig extension but contains standard JSON content.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Config location ───────────────────────────────────────

const CONFIG_FILENAME = 'kiosk.netConfig';
const LOG_DIRNAME = 'logs';

// Defaults for keys that must never be silently left empty, backfilled into
// any already-migrated .netConfig that predates the key being introduced
// (e.g. an install set up before `updateRepo` existed). This is intentionally
// a hardcoded constant rather than read from the bundled source/config.json:
// syncSdkConfigFile() overwrites that file in place with the current
// .netConfig content on every run, so once the service has started once it
// no longer holds a pristine default and can't be used as one.
// The one public repo every install checks for new releases. A repo address
// is not a secret (the GitHub token is, and is never defaulted).
const DEFAULT_UPDATE_REPO = 'https://github.com/ssd-temple/ssd-nets-service';

const BACKFILL_DEFAULTS = {
    updateRepo: DEFAULT_UPDATE_REPO,
};

// A machine set up before the "leave updateRepo blank" fix above still has
// HEB's own repo URL written into its .netConfig from whatever shipped
// as the bundled default back then — a real, non-empty value already on
// disk, so BACKFILL_DEFAULTS (which only fills in something missing/blank)
// never touches it, and the Configuration page's "GitHub Update Repo" field
// keeps showing HEB's repo pre-filled instead of an empty, enterable field
// on every install that predates this fix, not just a fresh one. Matched
// loosely (trailing slash/.git, http vs https) since this was hand-typed
// into various installs' config over time.
const LEGACY_UPDATE_REPO_VALUES = [/github\.com\/HinduEndowmentsBoard\/NETS-Service\/?(?:\.git)?\/?$/i];

/**
 * Clears any BACKFILL_DEFAULTS key still carrying a known-stale value from
 * before this codebase was SSD's own — unlike backfillMissingDefaults, this
 * DOES overwrite an existing value, but only one that exactly matches a
 * known legacy default, never anything an operator actually configured.
 * @param {object} config
 * @returns {boolean} true if anything was scrubbed
 */
function scrubLegacyDefaults(config) {
    let changed = false;
    if (typeof config.updateRepo === 'string' && LEGACY_UPDATE_REPO_VALUES.some((re) => re.test(config.updateRepo.trim()))) {
        config.updateRepo = '';
        changed = true;
    }
    return changed;
}

/**
 * Returns the directory where the config file lives.
 * On Windows (production): C:\ProgramData\KioskService\
 * On macOS/Linux (dev):     project root (same dir as index.js)
 */
function getLocalConfigDir() {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'KioskService');
}

function getProgramDataConfigDir() {
    const programData = process.env.PROGRAMDATA || 'C:\\ProgramData';
    return path.join(programData, 'KioskService');
}

/**
 * Check that both the directory and the current config file (when present)
 * can be written by the account running the service.  `fs.access()` alone is
 * not sufficient on Windows: a ProgramData directory may be writable while a
 * config file copied by an elevated installer is not.
 */
function isConfigWritable(dir) {
    try {
        ensureDir(dir);
        const configPath = path.join(dir, CONFIG_FILENAME);

        if (fs.existsSync(configPath)) {
            const descriptor = fs.openSync(configPath, 'r+');
            fs.closeSync(descriptor);
            return true;
        }

        const probePath = path.join(dir, `.kiosk-write-test-${process.pid}-${Date.now()}`);
        const descriptor = fs.openSync(probePath, 'wx');
        fs.closeSync(descriptor);
        fs.unlinkSync(probePath);
        return true;
    } catch (e) {
        return false;
    }
}

function getConfigDir() {
    if (process.platform === 'win32') {
        const primaryDir = getProgramDataConfigDir();
        if (isConfigWritable(primaryDir)) {
            return primaryDir;
        }

        const fallbackDir = getLocalConfigDir();
        ensureDir(fallbackDir);
        return fallbackDir;
    }
    return path.resolve(__dirname);
}

function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function getLogDir() {
    const logDir = path.join(getConfigDir(), LOG_DIRNAME);
    ensureDir(logDir);
    return logDir;
}

function ensureRuntimeDirs() {
    ensureDir(getConfigDir());
    getLogDir();
}

/**
 * Returns the full path to the .netConfig file.
 */
function getConfigPath() {
    return path.join(getConfigDir(), CONFIG_FILENAME);
}

// ── Read / Write helpers ──────────────────────────────────

/**
 * Read and parse the .netConfig file.
 * @returns {object} Parsed JSON config
 */
function readConfig() {
    const configPath = getConfigPath();
    let sourcePath = configPath;

    // If an older ProgramData config is readable but was installed with a
    // restrictive ACL, retain its values while future writes use LocalAppData.
    if (!fs.existsSync(sourcePath) && process.platform === 'win32') {
        const programDataPath = path.join(getProgramDataConfigDir(), CONFIG_FILENAME);
        if (fs.existsSync(programDataPath)) {
            sourcePath = programDataPath;
        }
    }

    const data = fs.readFileSync(sourcePath, 'utf8');
    const config = JSON.parse(data);

    // Both run unconditionally (not chained with ||) — each can independently
    // decide this config needs rewriting, and skipping the second because the
    // first already returned true would leave a legacy value un-scrubbed.
    const backfilled = backfillMissingDefaults(config);
    const scrubbed = scrubLegacyDefaults(config);
    if (backfilled || scrubbed) {
        try {
            writeConfig(config);
        } catch (e) {
            // Non-fatal: the corrected value is still returned for this
            // read even if persisting it fails (e.g. read-only config dir).
        }
    }

    return config;
}

/**
 * Fill in any BACKFILL_DEFAULTS keys that are missing or blank in the given
 * config object, in place. Never overwrites a value the user actually set.
 * @param {object} config
 * @returns {boolean} true if anything was backfilled
 */
function backfillMissingDefaults(config) {
    let changed = false;
    for (const key of Object.keys(BACKFILL_DEFAULTS)) {
        const current = config[key];
        const isEmpty = current === undefined || current === null || current === '';
        if (isEmpty) {
            config[key] = BACKFILL_DEFAULTS[key];
            changed = true;
        }
    }
    return changed;
}

/**
 * Write config object back to the .netConfig file.
 * Creates the directory if it doesn't exist.
 * @param {object} config - The config object to write
 */
function writeConfig(config) {
    const serializedConfig = JSON.stringify(config, null, '\t');
    const preferredDir = getConfigDir();

    try {
        writeConfigToDir(preferredDir, serializedConfig);
    } catch (err) {
        // A ProgramData config can become read-only after installation or a
        // security-policy change. Save the same settings in the per-user
        // location instead of returning EPERM to the configuration screen.
        if (process.platform !== 'win32' || preferredDir === getLocalConfigDir()) {
            throw err;
        }
        writeConfigToDir(getLocalConfigDir(), serializedConfig);
    }
}

function writeConfigToDir(dir, serializedConfig) {
    ensureDir(dir);
    const configPath = path.join(dir, CONFIG_FILENAME);
    const temporaryPath = path.join(dir, `.${CONFIG_FILENAME}.${process.pid}.${Date.now()}.tmp`);

    try {
        fs.writeFileSync(temporaryPath, serializedConfig, 'utf8');
        fs.renameSync(temporaryPath, configPath);
    } finally {
        if (fs.existsSync(temporaryPath)) {
            fs.unlinkSync(temporaryPath);
        }
    }
}

/**
 * Get a single key from config.
 * @param {string} key
 * @returns {*} The value for the given key
 */
function getConfigByKey(key) {
    const config = readConfig();
    return config[key];
}

/**
 * Merge data into the existing config (shallow merge).
 * @param {object} data - Key/value pairs to merge into config
 */
function updateConfig(data) {
    const config = readConfig();
    Object.assign(config, data);
    writeConfig(config);
}

/**
 * Ensure the SDK's expected `config.json` in CWD is in sync.
 * 
 * The nets-service-sdk reads `./config.json` (relative to CWD).
 * This function creates or updates `./config.json` as a copy
 * of the .netConfig file so the SDK can read it.
 * 
 * On Windows it creates a symlink; on other platforms it copies the file.
 */
/**
 * Path to the pristine config.json template shipped next to the exe (pkg
 * build) or next to this file (dev). Unaffected by index.js's
 * process.chdir() since it's resolved from process.execPath/__dirname, not
 * CWD — this is the only place a genuinely fresh install (no .netConfig
 * anywhere yet) can seed sensible starting values from.
 */
function getBundledConfigTemplatePath() {
    const baseDir = process.pkg ? path.dirname(process.execPath) : __dirname;
    return path.join(baseDir, 'config.json');
}

function syncSdkConfigFile() {
    const configPath = getConfigPath();
    // index.js points process.cwd() at this same writable config directory
    // for pkg builds, so resolving against the actual CWD is correct here —
    // no need to recompute it independently.
    const sdkConfigPath = path.resolve(process.cwd(), 'config.json');

    // If the .netConfig IS in CWD with name config.json, nothing to do
    if (path.resolve(configPath) === path.resolve(sdkConfigPath)) {
        return;
    }

    if (!fs.existsSync(configPath)) {
        // First-ever run on this machine: nothing has been written to the
        // shared config dir yet. Without this, nets-service-sdk's own
        // config.json read (which happens at require-time, synchronously,
        // right after this function returns — see index.js) finds nothing
        // at all and crashes the whole service before it can start. Seed
        // both the real .netConfig and the SDK's copy from the bundled
        // template so a brand new install actually boots.
        const templatePath = getBundledConfigTemplatePath();
        if (fs.existsSync(templatePath)) {
            try {
                const content = fs.readFileSync(templatePath, 'utf8');
                writeConfig(JSON.parse(content));
                fs.writeFileSync(sdkConfigPath, content, 'utf8');
            } catch (err) {
                console.warn(`Warning: Could not seed config from bundled template: ${err.message}`);
            }
        }
        return;
    }

    try {
        // Copy the .netConfig content to ./config.json for the SDK
        const content = fs.readFileSync(configPath, 'utf8');
        fs.writeFileSync(sdkConfigPath, content, 'utf8');
    } catch (err) {
        console.warn(`Warning: Could not sync config.json for SDK: ${err.message}`);
    }
}

/**
 * Sync changes from SDK's config.json back to the .netConfig file.
 * Call this after SDK operations that modify config (e.g. updateConfig).
 */
function syncFromSdkConfigFile() {
    const configPath = getConfigPath();
    // See syncSdkConfigFile() above — CWD is already the right directory.
    const sdkConfigPath = path.resolve(process.cwd(), 'config.json');

    if (path.resolve(configPath) === path.resolve(sdkConfigPath)) {
        return;
    }

    if (!fs.existsSync(sdkConfigPath)) {
        return;
    }

    try {
        const content = fs.readFileSync(sdkConfigPath, 'utf8');
        const dir = path.dirname(configPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(configPath, content, 'utf8');
    } catch (err) {
        console.warn(`Warning: Could not sync .netConfig from config.json: ${err.message}`);
    }
}

/**
 * Migrate an existing config.json to the new .netConfig location.
 * Only runs once — skips if .netConfig already exists.
 * 
 * @param {string} [legacyPath] - Path to legacy config.json (defaults to ./config.json)
 */
function migrateFromLegacyConfig(legacyPath) {
    const configPath = getConfigPath();
    // In pkg builds __dirname is the snapshot path, not the real exe dir
    const baseDir = process.pkg ? path.dirname(process.execPath) : path.resolve(__dirname);
    const legacy = legacyPath || path.join(baseDir, 'config.json');

    // Already migrated
    if (fs.existsSync(configPath)) {
        return false;
    }

    if (!fs.existsSync(legacy)) {
        return false;
    }

    try {
        const content = fs.readFileSync(legacy, 'utf8');
        // Validate it's valid JSON
        JSON.parse(content);

        const dir = path.dirname(configPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(configPath, content, 'utf8');
        return true;
    } catch (err) {
        console.error(`Failed to migrate legacy config: ${err.message}`);
        return false;
    }
}


// ── Environment profiles (UAT / Production) ───────────────
// One install can be pointed at either backend. Each profile keeps its own
// Cloud URL, update repo, GitHub token and callback secret, and nothing is
// pre-filled: an operator enters every value, so no real address or secret
// ever ships inside the exe or the repo. The active profile is mirrored into
// the flat keys (cloud_url, updateRepo, githubToken, callbackSecret) that the
// rest of the service already reads.
const ENVIRONMENTS = ['uat', 'production'];
const ENVIRONMENT_FIELDS = ['cloud_url', 'updateRepo', 'githubToken', 'callbackSecret'];

/**
 * Pure: returns the config keys to write after saving `fields` into the
 * `environment` profile and making it the active one. A blank
 * `callbackSecret` keeps the secret already stored (the page never shows it
 * back, so an untouched field must not erase it); every other field is
 * saved exactly as given, so it can be cleared.
 * @param {object} config       current config
 * @param {string} environment  'uat' | 'production'
 * @param {object} fields       any of ENVIRONMENT_FIELDS
 */
function applyEnvironmentSettings(config, environment, fields = {}) {
    if (!ENVIRONMENTS.includes(environment)) {
        throw new Error(`Unknown environment "${environment}" — expected one of: ${ENVIRONMENTS.join(', ')}.`);
    }
    const environments = { ...(config.environments || {}) };
    const profile = { ...(environments[environment] || {}) };

    for (const key of ENVIRONMENT_FIELDS) {
        if (fields[key] === undefined || fields[key] === null) continue;
        const value = String(fields[key]).trim();
        if (key === 'callbackSecret' && value === '') continue;
        profile[key] = value;
    }
    environments[environment] = profile;

    return {
        environments,
        activeEnvironment: environment,
        cloud_url: profile.cloud_url || '',
        updateRepo: profile.updateRepo || DEFAULT_UPDATE_REPO,
        githubToken: profile.githubToken || '',
        callbackSecret: profile.callbackSecret || '',
    };
}

/**
 * Pure: the profiles as safe to send to the Configuration page — the
 * callback secret is replaced by a `hasCallbackSecret` flag.
 */
function describeEnvironments(config) {
    const out = {};
    for (const name of ENVIRONMENTS) {
        const profile = (config.environments || {})[name] || {};
        out[name] = {
            cloud_url: profile.cloud_url || '',
            updateRepo: profile.updateRepo || DEFAULT_UPDATE_REPO,
            githubToken: profile.githubToken || '',
            hasCallbackSecret: Boolean(profile.callbackSecret),
        };
    }
    return out;
}

module.exports = {
    CONFIG_FILENAME,
    getConfigDir,
    getConfigPath,
    getLogDir,
    ensureRuntimeDirs,
    readConfig,
    writeConfig,
    getConfigByKey,
    updateConfig,
    syncSdkConfigFile,
    syncFromSdkConfigFile,
    migrateFromLegacyConfig,
    ENVIRONMENTS,
    DEFAULT_UPDATE_REPO,
    applyEnvironmentSettings,
    describeEnvironments,
};

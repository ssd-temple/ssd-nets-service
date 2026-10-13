// Ensures node-canvas's bundled Cairo/Pango/Fontconfig stack has a valid,
// guaranteed-writable config + cache location.
//
// Why this exists: node-canvas v3 renders text (including Tamil, via the
// Catamaran font registered in amq/ESCPOSBuilder.js and
// amq/receiptImageGenerator.js) through Pango, which resolves fonts through
// Fontconfig. Fontconfig's default config looks for a cache directory under
// the current user's profile (e.g. %LOCALAPPDATA%). When this service runs
// as a Windows Service (nssm) under an account whose profile directory is
// missing, redirected, or unwritable, Fontconfig can fail to initialize a
// working cache. Latin text still renders (Cairo/Pango fall back to basic
// glyph lookup), but Tamil is a complex script that needs Pango+Fontconfig+
// HarfBuzz to pick a font that actually covers it — when that lookup can't
// complete, it silently substitutes a font with no Tamil glyphs, printing
// as tofu boxes. This only shows up on machines where the profile-based
// cache path doesn't work, which is why it can look fine on a developer
// machine and break on freshly installed kiosks.
//
// Fix: point FONTCONFIG_FILE at a config we control, with the app's own
// fonts directory plus the real Windows Fonts folder (for fallback scripts
// like Nirmala UI), and a cache directory next to the exe that we know is
// writable because the service already writes logs/images/temp there.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ensureFontsExtracted } = require('./nativeAddonSetup');

let initialized = false;
let configuredPath = null;
let configureError = null;

function ensureFontconfigConfigured() {
  if (initialized) return;
  initialized = true;

  // appFontsDir is guaranteed to be a real (non-snapshot) directory
  // containing the actual Catamaran .ttf files — see nativeAddonSetup.js.
  const appFontsDir = ensureFontsExtracted();
  const windowsFontsDir = path.join(process.env.SystemRoot || 'C:\\Windows', 'Fonts');

  // LocalAppData\KioskService tried first: configPath.js already learned
  // the hard way (see its getLocalConfigDir()/getProgramDataConfigDir()
  // comments) that an elevated installer can leave ProgramData\KioskService
  // with an ACL the service account can't write to, while LocalAppData
  // stays reliably writable under that same account — the Electron app
  // itself also installs per-user into LocalAppData\Programs (see
  // installer/setup.iss's PrivilegesRequired=lowest), so this is the
  // location actually proven to work for this app's current install model.
  // Next to the exe, then ProgramData, then a temp dir follow as fallbacks
  // for older nssm-service installs or locked-down machines where even
  // LocalAppData isn't usable.
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const candidateConfigDirs = [
    path.join(localAppData, 'KioskService', 'fontconfig'),
    path.join(process.pkg ? path.dirname(process.execPath) : __dirname, 'fontconfig'),
    path.join(process.env.ProgramData || 'C:\\ProgramData', 'KioskService', 'fontconfig'),
    path.join(os.tmpdir(), 'KioskService', 'fontconfig'),
  ];

  for (const configDir of candidateConfigDirs) {
    try {
      const cacheDir = path.join(configDir, 'cache');
      fs.mkdirSync(cacheDir, { recursive: true });
      // Prove the cache dir is actually writable now, not just creatable —
      // Fontconfig will need to write cache files into it continuously.
      const probe = path.join(cacheDir, `.write-test-${process.pid}`);
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);

      const fontsConfPath = path.join(configDir, 'fonts.conf');
      const xml = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${appFontsDir}</dir>
  <dir>${windowsFontsDir}</dir>
  <cachedir>${cacheDir}</cachedir>
</fontconfig>
`;
      fs.writeFileSync(fontsConfPath, xml, 'utf8');

      process.env.FONTCONFIG_FILE = fontsConfPath;
      configuredPath = fontsConfPath;
      console.log(`[fontSetup] Fontconfig configured: ${fontsConfPath} (fonts dir: ${appFontsDir})`);
      return;
    } catch (e) {
      console.warn(`[fontSetup] Could not configure Fontconfig at ${configDir}: ${e.message}`);
      configureError = e.message;
    }
  }
  console.error('[fontSetup] Could not configure Fontconfig at ANY candidate location (exe dir, ProgramData, temp). Tamil text will likely render incorrectly on this machine. Check antivirus/permissions on those paths.');
}

/**
 * Snapshot of the resolved Fontconfig config path (or the last error if
 * none of the candidates worked), for diagnostics. Does not trigger
 * configuration — call ensureFontconfigConfigured() first if needed.
 */
function getFontconfigDiagnostics() {
  return { configuredPath, configureError };
}

module.exports = { ensureFontconfigConfigured, getFontconfigDiagnostics };

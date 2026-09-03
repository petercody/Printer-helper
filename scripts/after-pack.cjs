// Ad-hoc code signing for macOS builds.
// electron-builder runs this after packing each arch. We give the .app a
// valid local ("ad-hoc") signature so it runs on Apple Silicon and Intel
// without an Apple Developer certificate. Users still remove the quarantine
// flag once after download:  xattr -dr com.apple.quarantine "/Applications/Printer Connect.app"
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename; // "Printer Connect"
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  if (!fs.existsSync(appPath)) {
    console.log(`[after-pack] no .app at ${appPath}, skipping`);
    return;
  }

  const arch = context.arch; // 0=ia32 1=x64 3=arm64 4=universal
  console.log(`[after-pack] ad-hoc signing ${appPath} (arch ${arch})`);
  execFileSync(
    'codesign',
    ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath],
    { stdio: 'inherit' }
  );
  console.log('[after-pack] ad-hoc signature applied');
};

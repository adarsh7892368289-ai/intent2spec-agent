'use strict';

const path = require('path');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

function electronBinaryPath(context) {
  const { appOutDir, packager } = context;
  const exeName = packager.appInfo.productFilename;
  switch (context.electronPlatformName) {
    case 'darwin':
      return path.join(appOutDir, `${exeName}.app`, 'Contents', 'MacOS', exeName);
    case 'win32':
      return path.join(appOutDir, `${exeName}.exe`);
    default:
      return path.join(appOutDir, exeName);
  }
}

module.exports = async function afterPack(context) {
  const electronBinary = electronBinaryPath(context);
  const isMac = context.electronPlatformName === 'darwin';

  await flipFuses(electronBinary, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: isMac,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false
  });
};

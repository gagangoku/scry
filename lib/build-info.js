const fs = require('fs');
const path = require('path');

// Version and build details shown in the app (GET /version, the header badge,
// the macOS About panel). CI writes build-info.json at the repo root before
// packaging the mac app (see .github/workflows/mac-app.yaml); a dev checkout
// has none, so the version comes from package.json and the build is "dev".
function loadBuildInfo(root = path.join(__dirname, '..')) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  let built = {};
  try {
    built = JSON.parse(fs.readFileSync(path.join(root, 'build-info.json'), 'utf8'));
  } catch (_) { /* dev checkout */ }
  return {
    version: pkg.version,
    build: 'dev',
    commit: null,
    builtAt: null,
    ...built,
  };
}

module.exports = { loadBuildInfo };

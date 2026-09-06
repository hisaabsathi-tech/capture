#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const manifestPath = path.join(root, 'manifest.json');
const packagePath = path.join(root, 'package.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function parseVersion(version) {
  if (!/^\d+(\.\d+){0,3}$/.test(version)) {
    throw new Error(`Invalid Chrome extension version "${version}". Use 1 to 4 numeric parts, for example 1.2.3.`);
  }
  const parts = version.split('.').map(Number);
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 65535)) {
    throw new Error('Each version part must be an integer between 0 and 65535.');
  }
  return parts;
}

function normalizeVersion(version) {
  return parseVersion(version).join('.');
}

function bumpVersion(current, level) {
  const parts = parseVersion(current);
  while (parts.length < 3) parts.push(0);

  if (level === 'major') {
    parts[0] += 1;
    parts[1] = 0;
    parts[2] = 0;
  } else if (level === 'minor') {
    parts[1] += 1;
    parts[2] = 0;
  } else if (level === 'patch') {
    parts[2] += 1;
  } else {
    throw new Error('Bump level must be major, minor, or patch.');
  }

  parseVersion(parts.join('.'));
  return parts.join('.');
}

function updateVersion(nextVersion) {
  const normalized = normalizeVersion(nextVersion);
  const manifest = readJson(manifestPath);
  manifest.version = normalized;
  writeJson(manifestPath, manifest);

  if (fs.existsSync(packagePath)) {
    const pkg = readJson(packagePath);
    pkg.version = normalized;
    writeJson(packagePath, pkg);
  }

  console.log(normalized);
}

function main() {
  const [command, arg] = process.argv.slice(2);
  const manifest = readJson(manifestPath);

  if (command === 'current') {
    console.log(manifest.version);
    return;
  }

  if (command === 'set') {
    if (!arg) throw new Error('Usage: node scripts/release-version.js set <version>');
    updateVersion(arg);
    return;
  }

  if (command === 'bump') {
    if (!arg) throw new Error('Usage: node scripts/release-version.js bump <major|minor|patch>');
    updateVersion(bumpVersion(manifest.version, arg));
    return;
  }

  throw new Error('Usage: node scripts/release-version.js current | set <version> | bump <major|minor|patch>');
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

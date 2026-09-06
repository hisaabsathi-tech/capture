# Releasing Hisaabsathi Capture

This project is a Chrome extension without a compile step. The release ZIP is built from only the files Chrome needs for **Load unpacked**:

- `manifest.json`
- `background.js`
- `sidepanel.html`
- `sidepanel.css`
- `sidepanel.js`
- `assets-logo.png`
- `lib/`
- `adapters/`
- `icons/`

Generated ZIPs are written to `dist/` with names like `Hisaabsathi Capture v1.0.0.zip`.

## Build a ZIP without changing the version

Use this when you only want a fresh ZIP from the current files.

```bash
npm run build:zip
```

In GitHub, run **Actions > Release Chrome Extension > Run workflow** and choose `build-only`. The ZIP will be available from the workflow run artifacts, but no GitHub Release is created.

## Release a new version

Chrome extension versions must be numeric, with 1 to 4 parts, such as `1.0.0`.

1. Bump the version locally:

```bash
npm run version:patch
```

Use `npm run version:minor`, `npm run version:major`, or `npm run version:set -- 1.0.0` when needed.

2. Commit the changed version files:

```bash
git add manifest.json package.json
git commit -m "Release v1.0.0"
```

3. Create and push a matching tag:

```bash
git tag v1.0.0
git push origin main
git push origin v1.0.0
```

The GitHub workflow validates that the tag matches `manifest.json`, builds the ZIP, and creates a GitHub Release with the ZIP attached.

## Draft a release from GitHub

You can also create a draft release from GitHub Actions.

1. Open **Actions > Release Chrome Extension > Run workflow**.
2. Choose `draft-release`.
3. Enter the new numeric version, for example `1.0.0`.
4. Download the ZIP from the draft GitHub Release.

This mode builds a release ZIP with the entered version inside GitHub. If you use that version permanently, update `manifest.json` and `package.json` in the repository too.

## Install the ZIP in Chrome

1. Download the release ZIP.
2. Unzip it.
3. Open `chrome://extensions`.
4. Turn on **Developer mode**.
5. Click **Load unpacked**.
6. Select the unzipped extension folder.

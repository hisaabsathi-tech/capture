# Hisaabsathi Capture

Chrome extension that copies shipment fields from Ekart and Shree Maruti booking pages into a side-panel sheet, then exports them as Excel.

## Supported pages

- [Ekart](https://app.elite.ekartlogistics.in/ship/forward)
- [Shree Maruti](https://bookings.innofulfill.com/credit-booking)

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked** and select this folder

## Release ZIP

Build a clean extension ZIP locally:

```bash
npm run build:zip
```

To show the ZIP on GitHub, run the **Release Chrome Extension** workflow with `published-release`.

Release steps are documented in [docs/releasing.md](docs/releasing.md).

## Use

1. Open a supported booking page
2. Click the extension icon to open the side panel
3. Fill the courier form as usual — captured fields appear live in the sheet
4. Complete the booking (**Create Shipment** / **Confirm Booking**) to save the row
5. Click **download excel** when you are done

In-progress rows stay in memory only (they disappear if you close the tab or the browser). Saved rows stay until you download or delete them. Download clears the exported rows — the spreadsheet is the record.

The toggle in the header turns capture on or off. Some columns (client ID, and a few courier-specific fields) are filled by hand.

The panel opens on any page. On anything other than the two booking pages above it says capture is idle, and the header chip reads **not supported** — your saved rows stay editable and downloadable.

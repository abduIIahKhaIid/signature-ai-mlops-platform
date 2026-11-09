# Signature Dataset Studio

A local dashboard for reviewing large Roboflow/YOLO detection datasets. The interface is plain HTML, CSS and JavaScript with no CDN assets, so it works without an internet connection (except for Hugging Face transfers). It was designed for datasets that are too large to render or unpack into browser memory at once.

The initial screen is deliberately upload-first: no existing dataset is selected, indexed, or rendered until the user uploads a ZIP or explicitly opens a project folder.

## Start

From the project root, double-click `START_DASHBOARD.bat`, or run:

```powershell
cd dataset_dashboard
npm start
```

Then open [http://127.0.0.1:4173](http://127.0.0.1:4173).

Node.js 20+ and the `tar` command (built into Windows 10/11, which uses bsdtar and reads ZIP files) are required.

## What it supports

- Finds nested `train`, `training`, `test`, `testing`, `val`, `valid`, and `validation` splits.
- Supports both `split/images + split/labels` and `images/split + labels/split` layouts.
- Shows a small, paginated image page and uses browser lazy-loading instead of loading the full dataset.
- Draws, moves, and resizes any number of boxes on a canvas.
- Opens images in a full-screen annotation reviewer with Previous/Next controls and continuous `Left Arrow` / `Right Arrow` keyboard navigation across gallery page boundaries.
- Auto-saves changed labels before keyboard/button navigation and prefetches adjacent images for faster review.
- Keeps up to 50 bounding-box edit snapshots for an Undo button and `Ctrl+Z`.
- Provides mouse-click 90° orientation controls while mapping edits back to the original YOLO coordinate space.
- Persists user-facing dataset names and confirms renames in the interface without renaming source folders.
- Uses numbered pagination with first/last controls, ellipses, range totals and direct page jump.
- Lets the user choose both the dashboard display name and the physical working-folder name before a ZIP upload starts.
- Suggests the next available working-folder name before upload when a requested import folder already exists.
- Detects and strips redundant ZIP wrapper directories, so a chosen import name becomes the dataset root instead of producing `import-name/dataset/archive-name/...` nesting.
- Refreshes the gallery automatically throughout ZIP validation/extraction; no manual re-index is required for imports.
- Loads image pixels and label data together behind an explicit animation, so bounding boxes never appear as an unexplained delayed second state.
- Shows only the splits that actually exist and supports an unsplit `images/` + `labels/` layout through an `All images` tab.
- Removes the temporary uploaded ZIP after extraction instead of retaining a `source.zip` copy.
- Keeps the newly selected dataset active while listing only dashboard-managed ZIP imports from `.signature-dashboard/imports` in the reusable history panel.
- Suggests an editable `<import name> - Updated Export` folder name before export.
- Imports from a Hugging Face dataset repository in two steps: **Find** scans the repository (repo ID or any `huggingface.co/datasets/...` repository, `tree` folder or `blob` file link), then **Choose & import** lists every ZIP archive and every YOLO `images/` + `labels/` folder with sizes, splits and label counts and recommends one.
- Hugging Face ZIP downloads retry automatically and resume from the last byte after a dropped connection; YOLO folders download file by file (6 in parallel, labels first) so images appear in the gallery while the download runs.
- Shows live download speed, size and time remaining, and lets you cancel a Hugging Face import; cancelling removes the partial working folder.
- Publishes a reviewed clean ZIP back to a user-selected Hugging Face dataset repository.
- Uses each user's request-scoped Hugging Face token without saving it in dashboard history, browser storage, jobs or configuration files.
- Validates ZIP imports and Hub exports as signature object-detection datasets: supported images, matching YOLO/Roboflow labels, valid boxes, and a signature class when `data.yaml` declares class names.
- Shows a dynamic Unlabeled tab containing only images whose matching `.txt` label file is missing.
- Displays a focused animated progress dialog throughout background dataset export.
- Recognizes normalized YOLO segmentation polygons, displays their enclosing boxes, and clearly warns before conversion to detection rows.
- Saves labels as canonical YOLO/Roboflow rows: `class_id x_center y_center width height`.
- Deleting an image moves it and its label into `.signature-dashboard/trash`. A toast offers **Undo** right away, and **Deleted images** in the sidebar restores any of them later or empties the trash for good. After every export the dashboard offers to empty that dataset's trash, and trash entries older than 30 days are removed automatically when the server starts and whenever the dashboard page is loaded or reloaded (change the period with `TRASH_RETENTION_DAYS`). The reviewer opens the next image after a delete.
- Images whose label file is missing *or contains no valid box* are listed in the Unlabeled tab, flagged "No label file" or "Empty label". The tab has a **Delete all unlabeled** action that moves every one of them (from every split) to the trash in one go, with Undo. Labeling an image there keeps it in the split it already belongs to.
- A ZIP upload or import can be cancelled from the activity card; the partly written working folder is removed. Unfinished import folders and stale Hub temp files are cleaned up when the server starts.
- `.signature-dashboard` and its `imports`, `exports`, `trash` and `huggingface-temp` folders are recreated automatically if they are missing.
- Uploads ZIPs as a raw stream, validates archive paths, then extracts in a background process. Images are indexed as extraction proceeds.
- Exports a reviewed copy to `.signature-dashboard/exports/<folder-name>` while preserving each item's train/valid/test split. Files whose names would clash (for example two sub-datasets that both contain `train/images/a.jpg`) are renamed `a__2.jpg` instead of overwritten, and `export-info.json` records counts and every rename.
- Uses no Ultralytics package; the only runtime dependency is `@huggingface/hub` for Hub listing and uploads.

## Opening a folder: working copy or original

**Open a folder in this project** first asks how to open it:

- **Make a working copy** (recommended, the default) copies the folder into `.signature-dashboard/imports/<name>`. Saved boxes and deletes only change the copy; the original dataset is never touched.
- **Edit the original folder** works on the real files. While such a dataset is open, a warning banner says so and offers **Make a working copy**.

Both kinds are listed in **Recent projects**, marked *Working copy* or *Original folder*, and are remembered in `dataset-history.json`.

## Needs fixing tab

Images whose label file has problems are listed in a **Needs fixing** tab, each flagged with its first problem: rows that are not valid YOLO (wrong value count, coordinates outside 0..1), segmentation polygons, class IDs that `data.yaml` does not list, or boxes whose class is not `signature` when the dataset also has other classes. Opening an image explains the problem; saving rewrites the label file in clean YOLO format, and fixed files leave the tab.

## Classes

Boxes can use any class listed in `data.yaml`. **Edit classes** (sidebar, or *Add or rename classes* in the reviewer) shows how many boxes use each class and lets you rename classes or add new ones; the change is written to the dataset's `data.yaml` while all other keys are kept. Renaming never touches label files, because they store class numbers. When no class is called `signature`, the dialog offers to rename the most-used class. In the reviewer, **New boxes** chooses the class that drawn and added boxes get.

## Publishing to Hugging Face

1. **Check token and repository** happens before anything is copied: the token is verified with Hugging Face (invalid, expired and read-only tokens are rejected), and the repository must exist or be creatable under your user or one of your organizations.
2. **Copy images and labels** and **Build the ZIP file** show how many files are done and how many are left.
3. **Prepare the upload** computes the ZIP's SHA-256, which Hugging Face requires before a large file is sent, then **Upload** shows the megabytes sent and **Create the commit** finishes it.
4. **Delete the local ZIP** removes the ZIP once the upload succeeded.

If publishing fails or the dashboard is closed, the ZIP stays in `.signature-dashboard/huggingface-temp/publish-cache` and is reused on the next attempt as long as the dataset has not changed (unused ZIPs are removed after 7 days). **Check connection** in the Hugging Face dialogs tests whether the dashboard server can reach the Hub and explains proxy, certificate, DNS or timeout problems.

## Class names and the signature check

Exports and Hugging Face publishing require a class named `signature`. Roboflow exports often name their classes differently (for example `'-'` and `'sign - v2 …'`). For such datasets **Save every box as one class: signature** is switched on automatically: the exported copy writes every box as class 0 and its `data.yaml` lists one class, `signature`. The dataset you are reviewing is not changed. Imports only warn about class names; they no longer fail because of them.

## Important behavior

For a ZIP import, the browser must first transfer the ZIP to the local service. It does **not** wait for the entire archive to extract: extraction and indexing happen in the background, and newly available images appear progressively. Direct folder datasets avoid upload and extraction entirely.

Deleting an item moves its image and label out of the dataset folder into the trash; nothing is removed for good until you empty the trash. The temporary uploaded ZIP is removed after extraction to avoid storing a duplicate archive. A clean exported dataset excludes deleted items and includes saved label corrections.

For Hugging Face import, enter `username/dataset-repo` or paste a dataset link and click **Find data**, then pick a ZIP or YOLO folder. Parquet-only repositories are detected and explained; export them as a YOLO ZIP first. Under *Advanced* you can still type a repository-relative ZIP path to skip the scan. Public repositories do not require a token. Private imports need a read token. Publishing needs a write token and can create a missing public or private dataset repository. Tokens are used only by the active request and are cleared from the form immediately afterward.

## Data safety

- The service binds to `127.0.0.1` by default, so it is not exposed to the network.
- Folder access and exports are restricted to this project directory.
- ZIP entries containing absolute paths or `..` traversal are rejected before extraction.
- Label coordinates are validated and constrained to `0..1` before saving.
- Deletion requires confirmation in the UI and can be undone from the trash.

## Configuration

Optional environment variables:

```powershell
$env:PORT = "4173"
$env:DASHBOARD_STATE_ROOT = "D:\path\to\dashboard-state"
$env:TRASH_RETENTION_DAYS = "30"     # days a deleted image stays in the trash
$env:HF_TOKEN = "hf_..."            # optional default token for private Hugging Face repos
$env:HF_ENDPOINT = "https://hf-mirror.example"  # optional Hub mirror
npm start
```

`DASHBOARD_STATE_ROOT` must still resolve inside the project unless the server safety policy is intentionally changed in code.

## Tests

```powershell
npm test
```

The tests cover split aliasing, both supported folder layouts, path containment, class-name parsing, YOLO parsing, validation, and serialization.

For a repeatable integrity summary of every dataset under `Dataset`, run:

```powershell
npm run analyze
```

## Interface font

The interface uses Schibsted Grotesk, bundled in `public/fonts` under the SIL Open Font License (see `public/fonts/OFL-schibsted-grotesk.txt`).

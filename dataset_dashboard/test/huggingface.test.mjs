import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeHubFiles, parseHubReference, selectFolderFiles, yoloRootOf } from "../lib/huggingface.mjs";

test("parses repository IDs and every common Hugging Face dataset link", () => {
  assert.deepEqual(parseHubReference("user/signs"), { repoId: "user/signs", revision: "main", path: "" });
  assert.deepEqual(parseHubReference("datasets/user/signs", "dev"), { repoId: "user/signs", revision: "dev", path: "" });
  assert.deepEqual(parseHubReference("https://huggingface.co/datasets/user/signs"), { repoId: "user/signs", revision: "main", path: "" });
  assert.deepEqual(parseHubReference("https://huggingface.co/datasets/user/signs/tree/v2/data/yolo"), { repoId: "user/signs", revision: "v2", path: "data/yolo" });
  assert.deepEqual(parseHubReference("https://huggingface.co/datasets/user/signs/blob/main/export.zip"), { repoId: "user/signs", revision: "main", path: "export.zip" });
  assert.throws(() => parseHubReference("https://huggingface.co/user/model"), /dataset/);
  assert.throws(() => parseHubReference("https://example.com/datasets/a/b"), /huggingface/);
  assert.throws(() => parseHubReference("just-a-name"), /username\/signatures/);
});

test("locates YOLO dataset roots in both supported layouts", () => {
  assert.deepEqual(yoloRootOf("train/images/a.jpg"), { root: "", split: "train", kind: "image" });
  assert.deepEqual(yoloRootOf("data/images/val/a.jpg"), { root: "data", split: "valid", kind: "image" });
  assert.deepEqual(yoloRootOf("set/labels/a.txt"), { root: "set", split: "all", kind: "label" });
  assert.equal(yoloRootOf("README.md"), null);
});

test("summarizes ZIP archives, YOLO folders and Parquet repositories", () => {
  const files = [
    { type: "file", path: "README.md", size: 10 },
    { type: "file", path: "yolo/data.yaml", size: 20 },
    { type: "file", path: "yolo/train/images/a.jpg", size: 100 },
    { type: "file", path: "yolo/train/labels/a.txt", size: 5 },
    { type: "file", path: "yolo/valid/images/b.jpg", size: 100 },
    { type: "file", path: "yolo/valid/labels/b.txt", size: 5 },
    { type: "file", path: "archive.zip", size: 999, lfs: { size: 5000 } },
  ];
  const summary = analyzeHubFiles(files);
  assert.equal(summary.zips[0].size, 5000);
  assert.equal(summary.folders[0].path, "yolo");
  assert.equal(summary.folders[0].images, 2);
  assert.equal(summary.folders[0].labels, 2);
  assert.deepEqual(summary.folders[0].splits, ["train", "valid"]);
  assert.equal(summary.folders[0].has_yaml, true);
  assert.deepEqual(summary.recommended, { mode: "zip", path: "archive.zip" });
  const parquet = analyzeHubFiles([{ type: "file", path: "data/train-0000.parquet", size: 1 }]);
  assert.equal(parquet.recommended, null);
  assert.match(parquet.notes[0], /Parquet/);
});

test("folder downloads include only the chosen root, labels before images", () => {
  const files = selectFolderFiles([
    { type: "file", path: "yolo/train/images/a.jpg", size: 1 },
    { type: "file", path: "yolo/train/labels/a.txt", size: 1 },
    { type: "file", path: "yolo/data.yaml", size: 1 },
    { type: "file", path: "yolo/notes.txt", size: 1 },
    { type: "file", path: "other/train/images/z.jpg", size: 1 },
  ], "yolo");
  assert.deepEqual(files.map((file) => file.relative), ["data.yaml", "train/labels/a.txt", "train/images/a.jpg"]);
});

// ---------------------------------------------------------------------------
// End-to-end: real dashboard server against a local mock of the Hub API.
// ---------------------------------------------------------------------------

const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

function mockHub(files, { failFirstLargeDownload = false } = {}) {
  let failed = false;
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://hub");
    const tree = url.pathname.match(/^\/api\/datasets\/([^/]+\/[^/]+)\/tree\/([^/]+)\/?(.*)$/);
    if (tree) {
      if (tree[1] !== "acme/signatures") {
        response.writeHead(404, { "content-type": "application/json" });
        return response.end(JSON.stringify({ error: "Repository not found" }));
      }
      const prefix = decodeURIComponent(tree[3] || "");
      const list = Object.keys(files)
        .filter((name) => !prefix || name.startsWith(`${prefix}/`))
        .map((name) => ({ type: "file", path: name, size: files[name].length }));
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify(list));
    }
    const resolve = url.pathname.match(/^\/datasets\/acme\/signatures\/resolve\/[^/]+\/(.+)$/);
    if (resolve) {
      const name = decodeURIComponent(resolve[1]);
      const content = files[name];
      if (!content) {
        response.writeHead(404);
        return response.end();
      }
      const range = request.headers.range?.match(/bytes=(\d+)-/);
      const start = range ? Number(range[1]) : 0;
      const body = content.subarray(start);
      response.writeHead(range ? 206 : 200, { "content-length": body.length, "content-type": "application/octet-stream" });
      if (failFirstLargeDownload && !failed && content.length > 1000) {
        failed = true;
        response.write(body.subarray(0, 400));
        return setTimeout(() => response.destroy(), 20);
      }
      return response.end(body);
    }
    response.writeHead(404);
    response.end();
  });
  return new Promise((resolveServer) => server.listen(0, "127.0.0.1", () => resolveServer(server)));
}

async function startDashboard(hubUrl, stateRoot) {
  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: appRoot,
    env: { ...process.env, PORT: String(port), HF_ENDPOINT: hubUrl, DASHBOARD_STATE_ROOT: stateRoot, HF_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => { if (String(chunk).includes("Signature Dataset Dashboard")) resolve(); });
    child.on("exit", (code) => reject(new Error(`dashboard exited ${code}`)));
  });
  return { child, base: `http://127.0.0.1:${port}` };
}

async function waitForJob(base, jobId) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const { job } = await (await fetch(`${base}/api/jobs/${jobId}`)).json();
    if (!["queued", "running"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("job timed out");
}

async function withEnvironment(files, options, run) {
  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const stateRoot = await mkdtemp(path.join(path.dirname(appRoot), ".hf-test-"));
  const hub = await mockHub(files, options);
  const dashboard = await startDashboard(`http://127.0.0.1:${hub.address().port}`, stateRoot);
  try {
    await run(dashboard.base, stateRoot);
  } finally {
    dashboard.child.kill();
    hub.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
}

const post = (base, route, body) => fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("inspects a Hub repository and imports a YOLO folder with progress", async () => {
  const files = {
    "yolo/data.yaml": Buffer.from("names:\n  - signature\n"),
    "yolo/train/images/a.png": PNG_1PX,
    "yolo/train/labels/a.txt": Buffer.from("0 0.5 0.5 0.2 0.1\n"),
    "yolo/valid/images/b.png": PNG_1PX,
    "yolo/valid/labels/b.txt": Buffer.from("0 0.4 0.4 0.2 0.1\n"),
    "README.md": Buffer.from("# demo"),
  };
  await withEnvironment(files, {}, async (base, stateRoot) => {
    const missing = await post(base, "/api/huggingface/inspect", { repo_id: "acme/missing" });
    assert.equal(missing.status, 404);
    assert.match((await missing.json()).error, /not found/);

    const inspected = await (await post(base, "/api/huggingface/inspect", { repo_id: "https://huggingface.co/datasets/acme/signatures" })).json();
    assert.equal(inspected.repository.folders[0].path, "yolo");
    assert.deepEqual(inspected.repository.recommended, { mode: "folder", path: "yolo" });

    const started = await (await post(base, "/api/huggingface/import", { repo_id: "acme/signatures", mode: "folder", folder_path: "yolo", folder_name: "hub-yolo" })).json();
    const job = await waitForJob(base, started.job.id);
    assert.equal(job.status, "completed", job.message);
    assert.equal(job.bytes_done > 0, true);
    const imported = await readdir(path.join(stateRoot, "imports", "hub-yolo", "train", "images"));
    assert.deepEqual(imported, ["a.png"]);
    const { datasets } = await (await fetch(`${base}/api/datasets`)).json();
    const dataset = datasets.find((candidate) => candidate.id === started.dataset.id);
    assert.equal(dataset.total, 2);
    assert.deepEqual(dataset.class_names, ["signature"]);
  });
});

async function tarReadsZip() {
  return new Promise((resolve) => {
    const child = spawn("tar", ["--version"]);
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.on("error", () => resolve(false));
    child.on("exit", () => resolve(/bsdtar|libarchive/i.test(output) || process.platform === "win32"));
  });
}

test("ZIP downloads resume after a dropped connection", async (t) => {
  if (!(await tarReadsZip()) && !process.env.ZIP_TAR_SHIM) return t.skip("system tar cannot read ZIP archives (bsdtar is used on Windows)");
  const work = await mkdtemp(path.join(tmpdir(), "hf-zip-"));
  await mkdir(path.join(work, "ds", "train", "images"), { recursive: true });
  await mkdir(path.join(work, "ds", "train", "labels"), { recursive: true });
  for (let index = 0; index < 20; index += 1) {
    await writeFile(path.join(work, "ds", "train", "images", `s${index}.png`), PNG_1PX);
    await writeFile(path.join(work, "ds", "train", "labels", `s${index}.txt`), `0 0.5 0.5 0.${(index % 8) + 1} 0.1\n`);
  }
  await writeFile(path.join(work, "ds", "data.yaml"), "names: [signature]\n");
  const zipPath = path.join(work, "export.zip");
  await new Promise((resolve, reject) => {
    const child = spawn("python3", ["-c", "import shutil,sys; shutil.make_archive(sys.argv[1][:-4], 'zip', sys.argv[2])", zipPath, path.join(work, "ds")]);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("zip failed"))));
  });
  const { readFile } = await import("node:fs/promises");
  const files = { "exports/export.zip": await readFile(zipPath) };
  await withEnvironment(files, { failFirstLargeDownload: true }, async (base) => {
    const started = await post(base, "/api/huggingface/import", { repo_id: "acme/signatures" });
    const body = await started.json();
    assert.equal(started.status, 202, body.error);
    const job = await waitForJob(base, body.job.id);
    assert.equal(job.status, "completed", job.message);
    const { datasets } = await (await fetch(`${base}/api/datasets`)).json();
    assert.equal(datasets.find((candidate) => candidate.id === body.dataset.id).total, 20);
  });
  await rm(work, { recursive: true, force: true });
});

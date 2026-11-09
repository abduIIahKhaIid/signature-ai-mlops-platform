import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function startDashboard(stateRoot) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: appRoot,
    env: { ...process.env, PORT: String(port), DASHBOARD_STATE_ROOT: stateRoot },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => { if (String(chunk).includes("Signature Dataset Dashboard")) resolve(); });
    child.on("exit", (code) => reject(new Error(`dashboard exited ${code}`)));
  });
  return { child, base: `http://127.0.0.1:${port}` };
}

const post = async (base, route, body = {}) => {
  const response = await fetch(`${base}${route}`, { method: "POST", body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
};

test("a folder can be opened as a working copy that never changes the original, and both kinds appear in history", async () => {
  const work = await mkdtemp(path.join(path.dirname(appRoot), ".copy-test-"));
  const original = path.join(work, "ds");
  await mkdir(path.join(original, "train", "images"), { recursive: true });
  await mkdir(path.join(original, "train", "labels"), { recursive: true });
  await writeFile(path.join(original, "train", "images", "a.png"), PNG_1PX);
  await writeFile(path.join(original, "train", "labels", "a.txt"), "0 0.5 0.5 0.2 0.2\n");
  await writeFile(path.join(original, "data.yaml"), "names:\n  - signature\n");
  const stateRoot = path.join(work, "state");
  const { child, base } = await startDashboard(stateRoot);
  try {
    const inspected = await post(base, "/api/folders/inspect", { path: original });
    assert.equal(inspected.body.folder.images, 1);
    assert.equal(inspected.body.folder.managed_import, false);
    assert.equal((await post(base, "/api/folders/inspect", { path: path.dirname(stateRoot) })).status, 400);

    const started = await post(base, "/api/datasets/open", { path: original, copy: true, folder_name: "ds-copy" });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    let job;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      ({ job } = await (await fetch(`${base}/api/jobs/${started.body.job.id}`)).json());
      if (!["queued", "running"].includes(job.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(job.status, "completed", job.message);
    const copyId = started.body.dataset.id;
    const items = await (await fetch(`${base}/api/datasets/${copyId}/items?split=train`)).json();
    assert.equal(items.total, 1);
    assert.equal(items.dataset.managed_import, true);

    await fetch(`${base}/api/datasets/${copyId}/items/${items.items[0].id}/labels`, { method: "PUT", body: JSON.stringify({ boxes: [] }) });
    await fetch(`${base}/api/datasets/${copyId}/items/${items.items[0].id}`, { method: "DELETE" });
    assert.equal(existsSync(path.join(original, "train", "images", "a.png")), true);
    assert.equal(await readFile(path.join(original, "train", "labels", "a.txt"), "utf8"), "0 0.5 0.5 0.2 0.2\n");

    const direct = await post(base, "/api/datasets/open", { path: original });
    assert.equal(direct.body.dataset.original_folder, true);
    const history = JSON.parse(await readFile(path.join(stateRoot, "dataset-history.json"), "utf8"));
    assert.deepEqual(history.map((entry) => entry.kind).sort(), ["original-folder", "working-copy"]);
  } finally {
    child.kill();
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
});

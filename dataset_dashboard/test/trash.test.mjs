import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from "node:fs/promises";
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

const json = async (response) => ({ status: response.status, body: await response.json() });

test("deleting moves files to the trash, empty labels count as unlabeled, and restore undoes the delete", async () => {
  const work = await mkdtemp(path.join(path.dirname(appRoot), ".trash-test-"));
  const dataset = path.join(work, "ds");
  await mkdir(path.join(dataset, "train", "images"), { recursive: true });
  await mkdir(path.join(dataset, "train", "labels"), { recursive: true });
  await writeFile(path.join(dataset, "train", "images", "a.png"), PNG_1PX);
  await writeFile(path.join(dataset, "train", "labels", "a.txt"), "0 0.5 0.5 0.2 0.2\n");
  await writeFile(path.join(dataset, "train", "images", "b.png"), PNG_1PX);
  await writeFile(path.join(dataset, "train", "labels", "b.txt"), "");
  const stateRoot = path.join(work, "state");
  const { child, base } = await startDashboard(stateRoot);
  try {
    const opened = await json(await fetch(`${base}/api/datasets/open`, { method: "POST", body: JSON.stringify({ path: dataset }) }));
    const id = opened.body.dataset.id;
    await new Promise((resolve) => setTimeout(resolve, 400));

    const unlabeled = await json(await fetch(`${base}/api/datasets/${id}/items?split=unlabeled`));
    assert.deepEqual(unlabeled.body.items.map((item) => [item.name, item.label_state]), [["b.png", "empty"]]);

    // "Delete all unlabeled" moves every image without boxes to the trash, and the batch can be restored.
    const bulk = await json(await fetch(`${base}/api/datasets/${id}/unlabeled/delete`, { method: "POST" }));
    assert.equal(bulk.body.deleted, 1);
    assert.equal(bulk.body.dataset.unlabeled, 0);
    assert.equal(existsSync(path.join(dataset, "train", "images", "b.png")), false);
    const batch = await json(await fetch(`${base}/api/trash/restore`, { method: "POST", body: JSON.stringify({ ids: bulk.body.trash_ids }) }));
    assert.equal(batch.body.restored, 1);
    assert.equal(existsSync(path.join(dataset, "train", "images", "b.png")), true);

    const train = await json(await fetch(`${base}/api/datasets/${id}/items?split=train`));
    const a = train.body.items.find((item) => item.name === "a.png");
    const deleted = await json(await fetch(`${base}/api/datasets/${id}/items/${a.id}`, { method: "DELETE" }));
    assert.equal(deleted.status, 200);
    assert.equal(existsSync(path.join(dataset, "train", "images", "a.png")), false);
    assert.equal(existsSync(path.join(dataset, "train", "labels", "a.txt")), false);

    const trash = await json(await fetch(`${base}/api/trash?dataset_id=${id}`));
    assert.equal(trash.body.total, 1);
    assert.equal(trash.body.entries[0].name, "a.png");

    const restored = await json(await fetch(`${base}/api/trash/${deleted.body.trash_id}/restore`, { method: "POST" }));
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal(existsSync(path.join(dataset, "train", "images", "a.png")), true);
    assert.equal(existsSync(path.join(dataset, "train", "labels", "a.txt")), true);
    const after = await json(await fetch(`${base}/api/datasets/${id}/items?split=train`));
    assert.equal(after.body.total, 2);
    assert.deepEqual(await readdir(path.join(stateRoot, "trash")), []);

    // The state folder is recreated on demand if someone deletes it while the server runs.
    await rm(stateRoot, { recursive: true, force: true });
    const exported = await json(await fetch(`${base}/api/datasets/${id}/export`, { method: "POST", body: JSON.stringify({ folder_name: "again" }) }));
    assert.equal(exported.status, 202, JSON.stringify(exported.body));
    assert.equal(existsSync(path.join(stateRoot, "exports", "again")), true);

    // Entries past the retention period are purged on page load (and at server start).
    const b = after.body.items.find((item) => item.name === "b.png");
    const trashedB = await json(await fetch(`${base}/api/datasets/${id}/items/${b.id}`, { method: "DELETE" }));
    const metaPath = path.join(stateRoot, "trash", trashedB.body.trash_id, "meta.json");
    const meta = JSON.parse(await readFile(metaPath, "utf8"));
    await writeFile(metaPath, JSON.stringify({ ...meta, deleted_at: "2020-01-01T00:00:00.000Z" }));
    const fresh = await json(await fetch(`${base}/api/datasets/${id}/items?split=train`));
    const a2 = fresh.body.items.find((item) => item.name === "a.png");
    await fetch(`${base}/api/datasets/${id}/items/${a2.id}`, { method: "DELETE" });
    const purged = await json(await fetch(`${base}/api/trash/purge-expired`, { method: "POST" }));
    assert.equal(purged.body.removed, 1);
    assert.equal((await json(await fetch(`${base}/api/trash?dataset_id=${id}`))).body.total, 1);
  } finally {
    child.kill();
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
});

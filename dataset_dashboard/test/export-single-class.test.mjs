import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("a dataset whose data.yaml has no signature class exports as one signature class on request", async () => {
  const work = await mkdtemp(path.join(path.dirname(appRoot), ".single-class-test-"));
  const dataset = path.join(work, "techies-like");
  await mkdir(path.join(dataset, "train", "images"), { recursive: true });
  await mkdir(path.join(dataset, "train", "labels"), { recursive: true });
  await writeFile(path.join(dataset, "train", "images", "a.png"), PNG_1PX);
  await writeFile(path.join(dataset, "train", "labels", "a.txt"), "0 0.5 0.5 0.2 0.2\n1 0.3 0.3 0.1 0.1\n");
  await writeFile(path.join(dataset, "data.yaml"), "names:\n- '-'\n- sign - v2 2023-05-18 5-37pm\nnc: 2\n");
  const stateRoot = path.join(work, "state");
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["server.mjs"], { cwd: appRoot, env: { ...process.env, PORT: String(port), DASHBOARD_STATE_ROOT: stateRoot }, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => { if (String(chunk).includes("Signature Dataset Dashboard")) resolve(); });
    child.on("exit", (code) => reject(new Error(`dashboard exited ${code}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  const post = async (route, body) => {
    const response = await fetch(`${base}${route}`, { method: "POST", body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  try {
    const opened = await post("/api/datasets/open", { path: dataset });
    const id = opened.body.dataset.id;
    assert.equal(opened.body.dataset.class_warning, true);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const refused = await post(`/api/datasets/${id}/export`, { folder_name: "plain" });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /Save every box as one signature class/);
    const after = await (await fetch(`${base}/api/datasets`)).json();
    assert.notEqual(after.datasets.find((candidate) => candidate.id === id).status, "error");

    const accepted = await post(`/api/datasets/${id}/export`, { folder_name: "single", single_class: true });
    assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
    let job;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      ({ job } = await (await fetch(`${base}/api/jobs/${accepted.body.job.id}`)).json());
      if (job.status !== "running" && job.status !== "queued") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(job.status, "completed", job.message);
    const exported = path.join(stateRoot, "exports", "single");
    assert.equal(await readFile(path.join(exported, "train", "labels", "a.txt"), "utf8"), "0 0.5 0.5 0.2 0.2\n0 0.3 0.3 0.1 0.1\n");
    assert.match(await readFile(path.join(exported, "data.yaml"), "utf8"), /nc: 1\nnames:\n {2}- "signature"/);
    assert.equal(await readFile(path.join(dataset, "train", "labels", "a.txt"), "utf8"), "0 0.5 0.5 0.2 0.2\n1 0.3 0.3 0.1 0.1\n");
  } finally {
    child.kill();
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
});

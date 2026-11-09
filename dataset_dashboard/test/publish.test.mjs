import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Minimal Hub: whoami, repo lookup and repo creation. Uploads fail on purpose. */
function mockHub() {
  const requests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://hub");
    requests.push(`${request.method} ${url.pathname}`);
    const auth = request.headers.authorization || "";
    const send = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === "/api/whoami-v2") {
      if (auth === "Bearer hf_write") return send(200, { type: "user", name: "ali", orgs: [{ type: "org", name: "netsol" }], auth: { type: "access_token", accessToken: { displayName: "w", role: "write" } } });
      if (auth === "Bearer hf_read") return send(200, { type: "user", name: "ali", orgs: [], auth: { type: "access_token", accessToken: { displayName: "reader", role: "read" } } });
      return send(401, { error: "Invalid credentials" });
    }
    if (url.pathname === "/api/datasets") return send(200, []);
    if (url.pathname === "/api/datasets/ali/existing") return send(200, { id: "ali/existing" });
    if (url.pathname.startsWith("/api/datasets/")) return send(404, { error: "Repository not found" });
    if (url.pathname === "/api/repos/create") return send(200, { url: "http://hub/datasets/ali/new" });
    return send(500, { error: "uploads are not supported by this mock" });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, requests })));
}

async function tarSupportsZip() {
  return new Promise((resolve) => {
    const child = spawn("tar", ["--version"]);
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.on("error", () => resolve(false));
    child.on("exit", () => resolve(/bsdtar|libarchive/i.test(output) || process.platform === "win32" || Boolean(process.env.ZIP_TAR_SHIM)));
  });
}

test("publishing checks the token and repository first, reports each stage, and reuses the ZIP after a failed upload", async () => {
  const work = await mkdtemp(path.join(path.dirname(appRoot), ".publish-test-"));
  const dataset = path.join(work, "ds");
  await mkdir(path.join(dataset, "train", "images"), { recursive: true });
  await mkdir(path.join(dataset, "train", "labels"), { recursive: true });
  for (const name of ["a", "b", "c"]) {
    await writeFile(path.join(dataset, "train", "images", `${name}.png`), PNG_1PX);
    await writeFile(path.join(dataset, "train", "labels", `${name}.txt`), "0 0.5 0.5 0.2 0.2\n");
  }
  await writeFile(path.join(dataset, "data.yaml"), "names:\n  - signature\n");
  const stateRoot = path.join(work, "state");
  const { server: hub } = await mockHub();
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: appRoot,
    env: { ...process.env, PORT: String(port), DASHBOARD_STATE_ROOT: stateRoot, HF_ENDPOINT: `http://127.0.0.1:${hub.address().port}`, HF_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => { if (String(chunk).includes("Signature Dataset Dashboard")) resolve(); });
    child.on("exit", (code) => reject(new Error(`dashboard exited ${code}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  const post = async (route, body) => {
    const response = await fetch(`${base}${route}`, { method: "POST", body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const waitJob = async (id) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const { job } = await (await fetch(`${base}/api/jobs/${id}`)).json();
      if (!["queued", "running"].includes(job.status)) return job;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("job timed out");
  };
  try {
    const status = await (await fetch(`${base}/api/huggingface/status`)).json();
    assert.equal(status.reachable, true);

    const opened = await post("/api/datasets/open", { path: dataset });
    const id = opened.body.dataset.id;
    await new Promise((resolve) => setTimeout(resolve, 400));
    const publish = (body) => post(`/api/datasets/${id}/huggingface-export`, { zip_name: "sigs.zip", ...body });

    const badToken = await publish({ repo_id: "ali/new", token: "hf_wrong" });
    assert.equal(badToken.status, 401);
    assert.match(badToken.body.error, /not valid or has expired/);

    const readOnly = await publish({ repo_id: "ali/new", token: "hf_read" });
    assert.equal(readOnly.status, 403);
    assert.match(readOnly.body.error, /can only read/);

    const missing = await publish({ repo_id: "ali/nothing", token: "hf_write", create_if_missing: false });
    assert.equal(missing.status, 404);
    assert.match(missing.body.error, /was not found/);

    const foreign = await publish({ repo_id: "someone/else", token: "hf_write" });
    assert.equal(foreign.status, 403);
    assert.match(foreign.body.error, /cannot create repositories under "someone"/);

    if (!(await tarSupportsZip())) return;

    const first = await publish({ repo_id: "ali/existing", token: "hf_write" });
    assert.equal(first.status, 202, JSON.stringify(first.body));
    assert.equal(first.body.job.stages[0].status, "done");
    const failed = await waitJob(first.body.job.id);
    assert.equal(failed.status, "failed");
    const stage = (job, stageId) => job.stages.find((entry) => entry.id === stageId);
    assert.equal(stage(failed, "copy").status, "done");
    assert.equal(stage(failed, "zip").status, "done");
    assert.equal(failed.zip_kept, true);
    assert.match(failed.message, /reused when you publish again/);
    const cache = path.join(stateRoot, "huggingface-temp", "publish-cache");
    assert.equal((await readdir(cache)).filter((name) => name.endsWith(".zip")).length, 1);

    const second = await publish({ repo_id: "ali/existing", token: "hf_write" });
    const again = await waitJob(second.body.job.id);
    assert.equal(stage(again, "copy").status, "skipped");
    assert.equal(stage(again, "zip").status, "skipped");
    assert.match(stage(again, "copy").detail, /Reused the ZIP/);
  } finally {
    child.kill();
    hub.close();
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
});

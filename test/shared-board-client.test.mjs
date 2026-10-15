import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { createSharedBoardClient } from "../skills/trackerboard/scripts/lib/shared-board-client.mjs";

function fakeChild({ failCount = 0, delay = 0 } = {}) {
  const child = new EventEmitter();
  child.connected = true;
  child.calls = 0;
  child.send = (message, callback) => {
    if (message.op === "shutdown") {
      queueMicrotask(() => {
        child.connected = false;
        child.emit("exit", 0, null);
      });
      callback?.();
      return true;
    }
    child.calls++;
    const response = () => child.emit("message", child.calls <= failCount
      ? { id: message.id, ok: false, error: { message: "simulated backend outage" } }
      : { id: message.id, ok: true, result: { board: { name: "test", title: "Test" }, revision: child.calls } });
    setTimeout(response, delay);
    callback?.();
    return true;
  };
  child.kill = () => {
    child.connected = false;
    child.emit("exit", null, "SIGTERM");
  };
  return child;
}

test("per-board client coalesces simultaneous snapshots and caps independent retry backoff", async () => {
  let now = 0;
  const child = fakeChild({ failCount: 7, delay: 20 });
  const client = createSharedBoardClient({
    boardName: "gh-board",
    targetIdentity: { backend: "github", projectId: "PVT_test" },
    spawnWorker: () => child,
    now: () => now,
    random: () => 0.5,
  });

  const [first, second] = [client.snapshot(), client.snapshot()];
  await assert.rejects(first, /simulated backend outage/);
  await assert.rejects(second, /simulated backend outage/);
  assert.equal(child.calls, 1, "one worker RPC serves concurrent snapshots");
  assert.equal(client.retryAt - now, 2_000, "the first retry delay is two seconds");

  const expectedDelays = [4_000, 8_000, 16_000, 32_000, 60_000, 60_000];
  for (const delay of expectedDelays) {
    now = client.retryAt;
    await assert.rejects(client.snapshot(), /simulated backend outage/);
    assert.equal(client.retryAt - now, delay);
  }
  now = client.retryAt;
  const recovered = await client.snapshot();
  assert.equal(recovered.board.title, "Test");
  assert.equal(client.retryAt, 0, "a successful retry resets the board's backoff");
  await client.close();
});

import assert from "node:assert/strict";
import test from "node:test";
import { EventParser } from "../dist/bridge/event-parser.js";

test("legacy event parser attaches target-relative image paths", () => {
  const events = [];
  const parser = new EventParser({
    runId: "run_legacy_images",
    targetPath: "/workspace/target",
    cwd: "/workspace/target",
    emit: (event) => events.push(event),
    now: () => "2026-07-22T00:00:00.000Z",
  });

  parser.pushStdout("Generated ./images/result.png\n");
  parser.pushStdout("Blocked ../outside.png\n");

  assert.deepEqual(events[0].message.attachments, [
    { path: "images/result.png", label: "result.png", slotKey: null },
  ]);
  assert.deepEqual(events[1].message.attachments, []);
});

test("legacy event parser recognizes a bare image filename", () => {
  const events = [];
  const parser = new EventParser({
    runId: "run_image_bare_name",
    targetPath: "/workspace/target",
    emit: (event) => events.push(event),
  });

  parser.pushStdout("Generated `cover.png`.\n");

  assert.deepEqual(events[0]?.message.attachments, [
    { path: "cover.png", label: "cover.png", slotKey: null },
  ]);
});

test("legacy event parser attaches local video paths and rejects escaped videos", () => {
  const events = [];
  const parser = new EventParser({
    runId: "run_video_output",
    targetPath: "/workspace/target",
    emit: (event) => events.push(event),
  });

  parser.pushStdout("Video ready: [episode](./output/episode.mp4)\n");
  parser.pushStdout("Blocked ../outside.webm\n");

  assert.deepEqual(events[0]?.message.attachments, [
    { path: "output/episode.mp4", label: "episode", slotKey: null },
  ]);
  assert.deepEqual(events[1]?.message.attachments, []);
});

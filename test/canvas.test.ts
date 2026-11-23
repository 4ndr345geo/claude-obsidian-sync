import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeCanvas, isMergeable, mergeFrontmatterGranular } from "../src/merge";

test("canvas ist mergeable", () => {
  assert.equal(isMergeable("Ideen/Mindmap.canvas"), true);
});

test("canvas 3-Wege-Merge: unabhängige Knoten von beiden Geräten werden kombiniert", () => {
  const base = JSON.stringify({
    nodes: [
      { id: "node1", x: 0, y: 0, width: 200, height: 100, text: "Zentrales Thema" }
    ],
    edges: []
  });

  const local = JSON.stringify({
    nodes: [
      { id: "node1", x: 0, y: 0, width: 200, height: 100, text: "Zentrales Thema" },
      { id: "node2", x: 300, y: 0, width: 200, height: 100, text: "Laptop Idee" }
    ],
    edges: [
      { id: "edge1", fromNode: "node1", toNode: "node2" }
    ]
  });

  const remote = JSON.stringify({
    nodes: [
      { id: "node1", x: 0, y: 0, width: 200, height: 100, text: "Zentrales Thema" },
      { id: "node3", x: 0, y: 200, width: 200, height: 100, text: "Handy Idee" }
    ],
    edges: [
      { id: "edge2", fromNode: "node1", toNode: "node3" }
    ]
  });

  const merged = mergeCanvas(local, base, remote, true);
  assert.ok(merged !== null);
  const data = JSON.parse(merged);

  assert.equal(data.nodes.length, 3, "alle drei Knoten erhalten");
  assert.equal(data.edges.length, 2, "beide Kanten erhalten");
  assert.ok(data.nodes.some((n: any) => n.id === "node2" && n.text === "Laptop Idee"));
  assert.ok(data.nodes.some((n: any) => n.id === "node3" && n.text === "Handy Idee"));
});

test("granularer Frontmatter-Merge: unterschiedliche Schlüssel ohne Konflikt kombiniert", () => {
  const base = "title: Notiz\ntags: original\nstatus: offen";
  const local = "title: Notiz\ntags: laptop, original\nstatus: offen";
  const remote = "title: Notiz\ntags: original\nstatus: erledigt\npriority: hoch";

  const res = mergeFrontmatterGranular(local, base, remote, true);
  assert.equal(res.clean, true);
  assert.equal(res.conflictKeys.length, 0);
  assert.ok(res.text.includes("tags: laptop, original"));
  assert.ok(res.text.includes("status: erledigt"));
  assert.ok(res.text.includes("priority: hoch"));
});

test("SyncEngine führt .canvas-Dateien als gültiges JSON zusammen (keine Markdown-Callouts)", async () => {
  const { FakeDrive, buf, device } = await import("./fakes");
  const drive = new FakeDrive();
  const a = device(drive, "Laptop");
  const b = device(drive, "Handy");

  const base = JSON.stringify({
    nodes: [{ id: "n1", x: 0, y: 0, width: 200, height: 100, text: "Start" }],
    edges: [],
  });
  a.vault.set("Ideen/Mindmap.canvas", buf(base));
  await a.sync();
  await b.sync();

  a.vault.set("Ideen/Mindmap.canvas", buf(JSON.stringify({
    nodes: [
      { id: "n1", x: 0, y: 0, width: 200, height: 100, text: "Start" },
      { id: "n2", x: 300, y: 0, width: 200, height: 100, text: "Laptop" },
    ],
    edges: [{ id: "e1", fromNode: "n1", toNode: "n2" }],
  })));
  b.vault.set("Ideen/Mindmap.canvas", buf(JSON.stringify({
    nodes: [
      { id: "n1", x: 0, y: 0, width: 200, height: 100, text: "Start" },
      { id: "n3", x: 0, y: 300, width: 200, height: 100, text: "Handy" },
    ],
    edges: [{ id: "e2", fromNode: "n1", toNode: "n3" }],
  })));

  await a.sync();
  const r = await b.sync();
  await a.sync();

  assert.equal(r.merged, 1);
  assert.equal(r.marked.length, 0);
  assert.equal(r.conflicts.length, 0);

  for (const d of [a, b]) {
    const parsed = JSON.parse(d.vault.text("Ideen/Mindmap.canvas")!);
    assert.equal(parsed.nodes.length, 3);
    assert.equal(parsed.edges.length, 2);
  }
});

test("SyncEngine legt bei ungültigem .canvas-JSON sicher eine Konfliktkopie an", async () => {
  const { FakeDrive, buf, device } = await import("./fakes");
  const drive = new FakeDrive();
  const a = device(drive, "Laptop");
  const b = device(drive, "Handy");

  a.vault.set("Kaputt.canvas", buf('{"nodes":[],"edges":[]}'));
  await a.sync();
  await b.sync();

  a.vault.set("Kaputt.canvas", buf("{kein gueltiges json"));
  b.vault.set("Kaputt.canvas", buf('{"nodes":[{"id":"x","x":0,"y":0,"width":10,"height":10}],"edges":[]}'));

  await a.sync();
  const r = await b.sync();
  assert.equal(r.conflicts.length, 1);
  assert.equal(b.vault.getFiles().length, 2);
});


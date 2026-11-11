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

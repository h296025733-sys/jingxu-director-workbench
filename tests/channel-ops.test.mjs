import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createChannelOpsStore,
  initializeChannelOpsSchema,
  OpsConflictError,
} from "../lib/channel-ops.ts";

function createFixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "jingxu-channel-ops-"));
  const databasePath = path.join(directory, "app.db");
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
  initializeChannelOpsSchema(database);
  const store = createChannelOpsStore(database);
  return {
    directory,
    databasePath,
    database,
    store,
    close() {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

const alice = { username: "alice", displayName: "Alice" };
const bob = { username: "bob", displayName: "Bob" };

test("initializes the original shared planning data once", () => {
  const fixture = createFixture();
  try {
    const workspace = fixture.store.workspace();
    assert.equal(workspace.stores.length, 1);
    assert.equal(workspace.accounts.length, 2);
    assert.equal(workspace.items.length, 10);
    assert.equal(fixture.store.history({}).total, 0);
    initializeChannelOpsSchema(fixture.database);
    assert.equal(fixture.store.workspace().items.length, 10);
  } finally {
    fixture.close();
  }
});

test("shares writes across database connections and records the actor", () => {
  const fixture = createFixture();
  const secondDatabase = new DatabaseSync(fixture.databasePath);
  secondDatabase.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  const secondStore = createChannelOpsStore(secondDatabase);
  try {
    const accountId = fixture.store.workspace().accounts[0].id;
    const created = fixture.store.createItem({
      accountId,
      contentCode: "A99",
      title: "Shared row",
      contentType: "FAQ",
      plannedDate: "2026-09-03",
      stage: "选题池",
      compliance: "未检查",
      owner: "Alice",
      hook: "Hook",
      cta: "CTA",
      views: 0,
      clicks: 0,
      ordersCount: 0,
    }, alice);
    assert.equal(secondStore.workspace().items.some((item) => item.id === created.value.id), true);
    const history = secondStore.history({ search: "Alice" });
    assert.equal(history.total, 1);
    assert.equal(history.logs[0].actorUsername, "alice");
    assert.equal(history.logs[0].action, "create");
  } finally {
    secondDatabase.close();
    fixture.close();
  }
});

test("merges non-overlapping stale edits and rejects overlapping edits", () => {
  const fixture = createFixture();
  try {
    const original = fixture.store.workspace().items[0];
    const base = {
      accountId: original.accountId,
      contentCode: original.contentCode,
      title: original.title,
      contentType: original.contentType,
      plannedDate: original.plannedDate,
      stage: original.stage,
      compliance: original.compliance,
      owner: original.owner,
      hook: original.hook,
      cta: original.cta,
      views: original.views,
      clicks: original.clicks,
      ordersCount: original.ordersCount,
    };
    const aliceEdit = fixture.store.updateItem(
      original.id,
      { ...base, stage: "剪辑中" },
      base,
      original.version,
      alice,
    );
    assert.equal(aliceEdit.value.stage, "剪辑中");

    const bobEdit = fixture.store.updateItem(
      original.id,
      { ...base, owner: "Bob" },
      base,
      original.version,
      bob,
    );
    assert.equal(bobEdit.merged, true);
    assert.equal(bobEdit.value.stage, "剪辑中");
    assert.equal(bobEdit.value.owner, "Bob");

    const latestBase = {
      ...base,
      stage: bobEdit.value.stage,
      owner: bobEdit.value.owner,
    };
    const firstTitle = fixture.store.updateItem(
      original.id,
      { ...latestBase, title: "Alice title" },
      latestBase,
      bobEdit.value.version,
      alice,
    );
    assert.throws(
      () => fixture.store.updateItem(
        original.id,
        { ...latestBase, title: "Bob title" },
        latestBase,
        bobEdit.value.version,
        bob,
      ),
      (error) => {
        assert.equal(error instanceof OpsConflictError, true);
        assert.deepEqual(error.fields, ["title"]);
        assert.equal(error.current.title, firstTitle.value.title);
        return true;
      },
    );
  } finally {
    fixture.close();
  }
});

test("prevents stale deletion and preserves deleted snapshots in history", () => {
  const fixture = createFixture();
  try {
    const original = fixture.store.workspace().stores[0];
    const updated = fixture.store.updateStore(
      original.id,
      { name: `${original.name} Updated` },
      { name: original.name },
      original.version,
      alice,
    );
    assert.throws(
      () => fixture.store.deleteEntity("store", original.id, original.version, bob),
      OpsConflictError,
    );
    fixture.store.deleteEntity("store", original.id, updated.value.version, bob);
    assert.equal(fixture.store.workspace().stores.length, 0);
    const deletion = fixture.store.history({ action: "delete" }).logs[0];
    assert.equal(deletion.actorUsername, "bob");
    assert.equal(Array.isArray(deletion.before?.accounts), true);
    assert.equal(Array.isArray(deletion.before?.contentItems), true);
  } finally {
    fixture.close();
  }
});

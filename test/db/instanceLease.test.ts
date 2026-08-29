import assert from "node:assert/strict";
import test from "node:test";
import { SqliteInstanceLeaseRepository } from "../../lib/db/repositories/instanceLeaseRepository.js";
import { withTestDatabase } from "../helpers/database.js";

test("only one unexpired Watchtower instance may hold the SQLite authority", async () => {
  await withTestDatabase(async (database) => {
    const repository = new SqliteInstanceLeaseRepository(database);
    assert.equal(await repository.acquire("first", "instance-a", 1_000, 30_000), true);
    assert.equal(await repository.acquire("second", "instance-b", 1_001, 30_000), false);
    assert.equal(await repository.renew("first", 2_000, 30_000), true);
    assert.equal(await repository.renew("second", 2_000, 30_000), false);
    await repository.release("first");
    assert.equal(await repository.acquire("second", "instance-b", 2_001, 30_000), true);
  });
});

test("an expired process lease can be taken over deterministically", async () => {
  await withTestDatabase(async (database) => {
    const repository = new SqliteInstanceLeaseRepository(database);
    assert.equal(await repository.acquire("first", "instance-a", 1_000, 100), true);
    assert.equal(await repository.acquire("second", "instance-b", 1_100, 100), true);
    assert.equal(await repository.renew("first", 1_101, 100), false);
    assert.equal(await repository.renew("second", 1_101, 100), true);
  });
});

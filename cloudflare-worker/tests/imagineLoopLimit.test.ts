import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_IMAGINE_INFINITE_BATCHES,
  resolveImagineBatchLimit,
} from "../src/routes/function";

test("function imagine defaults to a single batch when infinite mode is disabled", () => {
  assert.equal(
    resolveImagineBatchLimit({
      infinite_mode: false,
    }),
    1,
  );
});

test("function imagine caps infinite mode to ten batches", () => {
  assert.equal(MAX_IMAGINE_INFINITE_BATCHES, 10);
  assert.equal(
    resolveImagineBatchLimit({
      infinite_mode: true,
    }),
    10,
  );
});

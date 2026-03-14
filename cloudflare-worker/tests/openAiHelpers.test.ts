import assert from "node:assert/strict";
import test from "node:test";

import { mapLimit } from "../src/routes/openai";

test("mapLimit preserves input order even when tasks resolve out of order", async () => {
  const result = await mapLimit(
    [
      { label: "Image 1", delay: 40 },
      { label: "Image 2", delay: 0 },
      { label: "Image 3", delay: 10 },
    ],
    3,
    async (item) => {
      await new Promise((resolve) => setTimeout(resolve, item.delay));
      return item.label;
    },
  );

  assert.deepEqual(result, ["Image 1", "Image 2", "Image 3"]);
});

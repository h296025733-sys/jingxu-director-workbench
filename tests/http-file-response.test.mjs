import assert from "node:assert/strict";
import test from "node:test";
import {
  ifNoneMatchMatches,
  ifRangeAllowsPartial,
  parseSingleByteRange,
} from "../lib/http-file-response.ts";

test("If-None-Match accepts strong, weak, list, and wildcard validators", () => {
  const etag = '"abc-123"';
  assert.equal(ifNoneMatchMatches(etag, etag), true);
  assert.equal(ifNoneMatchMatches(`W/${etag}`, etag), true);
  assert.equal(ifNoneMatchMatches(`"other", W/${etag}`, etag), true);
  assert.equal(ifNoneMatchMatches("*", etag), true);
  assert.equal(ifNoneMatchMatches('"other"', etag), false);
});

test("single byte ranges include open and suffix forms", () => {
  assert.deepEqual(parseSingleByteRange("bytes=0-9", 100), {
    start: 0,
    end: 9,
  });
  assert.deepEqual(parseSingleByteRange("bytes=90-", 100), {
    start: 90,
    end: 99,
  });
  assert.deepEqual(parseSingleByteRange("bytes=-10", 100), {
    start: 90,
    end: 99,
  });
  assert.deepEqual(parseSingleByteRange("bytes=-1000", 100), {
    start: 0,
    end: 99,
  });
});

test("invalid or unsupported ranges are unsatisfiable", () => {
  assert.equal(parseSingleByteRange("bytes=100-101", 100), null);
  assert.equal(parseSingleByteRange("bytes=10-9", 100), null);
  assert.equal(parseSingleByteRange("bytes=-0", 100), null);
  assert.equal(parseSingleByteRange("bytes=0-1,5-6", 100), null);
});

test("If-Range requires a strong matching validator or fresh date", () => {
  const etag = '"abc-123"';
  const modifiedAt = Date.parse("2026-08-21T10:00:00.000Z");
  assert.equal(ifRangeAllowsPartial(etag, etag, modifiedAt), true);
  assert.equal(ifRangeAllowsPartial(`W/${etag}`, etag, modifiedAt), false);
  assert.equal(ifRangeAllowsPartial('"other"', etag, modifiedAt), false);
  assert.equal(
    ifRangeAllowsPartial("Fri, 21 Aug 2026 10:00:00 GMT", etag, modifiedAt),
    true,
  );
  assert.equal(
    ifRangeAllowsPartial("Fri, 21 Aug 2026 09:59:59 GMT", etag, modifiedAt),
    false,
  );
});

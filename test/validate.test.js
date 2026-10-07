/**
 * Validation Middleware Unit Tests
 *
 * Run: node test/validate.test.js
 */

const { validate, t, requireUUIDParam, sanitize } = require("../src/middleware/validate");

let passed = 0;
let failed = 0;
const suites = [];
let currentSuite = null;

function describe(name, fn) {
  currentSuite = { name, tests: [] };
  suites.push(currentSuite);
  fn();
  currentSuite = null;
}

function it(name, fn) {
  currentSuite.tests.push({ name, fn });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "Assertion failed");
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// Mock Express req/res/next
function mockReq(body = {}, params = {}, query = {}) {
  return { body, params, query };
}

function mockRes() {
  return {};
}

// ═══════════════════════════════════════════════

describe("t.string()", () => {
  it("accepts valid string", () => {
    const rule = t.string({ required: true, min: 2, max: 10 });
    assertEqual(rule.validate("hello"), null);
  });

  it("rejects too short", () => {
    const rule = t.string({ required: true, min: 3 });
    assert(rule.validate("ab") !== null);
  });

  it("rejects too long", () => {
    const rule = t.string({ max: 5 });
    assert(rule.validate("toolongstring") !== null);
  });

  it("rejects missing when required", () => {
    const rule = t.string({ required: true });
    assert(rule.validate("") !== null);
    assert(rule.validate(null) !== null);
    assert(rule.validate(undefined) !== null);
  });

  it("accepts missing when optional", () => {
    const rule = t.string();
    assertEqual(rule.validate(""), null);
    assertEqual(rule.validate(null), null);
  });

  it("validates pattern", () => {
    const rule = t.string({ pattern: /^[a-z]+$/, patternHint: "lowercase only" });
    assertEqual(rule.validate("abc"), null);
    const err = rule.validate("ABC123");
    assert(err !== null);
    assert(err.includes("lowercase"), err);
  });

  it("trims by default", () => {
    const rule = t.string({ required: true, min: 3 });
    // "  ab  " trims to "ab" which is 2 chars → fail
    assert(rule.validate("  ab  ") !== null);
    // "  abc  " trims to "abc" → pass
    assertEqual(rule.validate("  abc  "), null);
  });

  it("rejects non-string values", () => {
    const rule = t.string({ required: true });
    assert(rule.validate(123) !== null);
    assert(rule.validate(true) !== null);
  });
});

describe("t.uuid()", () => {
  it("accepts valid UUID", () => {
    const rule = t.uuid({ required: true });
    assertEqual(rule.validate("550e8400-e29b-41d4-a716-446655440000"), null);
  });

  it("rejects invalid UUID", () => {
    const rule = t.uuid({ required: true });
    assert(rule.validate("not-a-uuid") !== null);
    assert(rule.validate("550e8400-e29b-41d4") !== null);
  });

  it("rejects missing when required", () => {
    const rule = t.uuid({ required: true });
    assert(rule.validate(null) !== null);
  });

  it("accepts missing when optional", () => {
    const rule = t.uuid();
    assertEqual(rule.validate(null), null);
  });
});

describe("t.integer()", () => {
  it("accepts valid integer", () => {
    const rule = t.integer({ required: true, min: 0, max: 1000 });
    assertEqual(rule.validate(500), null);
    assertEqual(rule.validate(0), null);
  });

  it("rejects below min", () => {
    const rule = t.integer({ min: 0 });
    assert(rule.validate(-1) !== null);
  });

  it("rejects above max", () => {
    const rule = t.integer({ max: 100 });
    assert(rule.validate(101) !== null);
  });

  it("rejects non-integer", () => {
    const rule = t.integer({ required: true });
    assert(rule.validate(1.5) !== null);
    assert(rule.validate("abc") !== null);
  });
});

describe("t.oneOf()", () => {
  it("accepts valid value", () => {
    const rule = t.oneOf(["hot", "new", "top"]);
    assertEqual(rule.validate("hot"), null);
    assertEqual(rule.validate("new"), null);
  });

  it("rejects invalid value", () => {
    const rule = t.oneOf(["hot", "new", "top"]);
    assert(rule.validate("invalid") !== null);
  });

  it("accepts missing when optional", () => {
    const rule = t.oneOf(["hot", "new"], { required: false });
    assertEqual(rule.validate(undefined), null);
    assertEqual(rule.validate(null), null);
  });
});

describe("t.url()", () => {
  it("accepts valid URL", () => {
    const rule = t.url();
    assertEqual(rule.validate("https://example.com"), null);
    assertEqual(rule.validate("http://localhost:3000"), null);
  });

  it("rejects invalid URL", () => {
    const rule = t.url();
    assert(rule.validate("not a url") !== null);
  });

  it("rejects non-http URLs", () => {
    const rule = t.url();
    assert(rule.validate("ftp://files.example.com") !== null);
    assert(rule.validate("javascript:alert(1)") !== null);
  });
});

describe("t.color()", () => {
  it("accepts valid hex colors", () => {
    const rule = t.color();
    assertEqual(rule.validate("#fff"), null);
    assertEqual(rule.validate("#FF5500"), null);
    assertEqual(rule.validate("#aabbcc"), null);
  });

  it("rejects invalid colors", () => {
    const rule = t.color();
    assert(rule.validate("red") !== null);
    assert(rule.validate("fff") !== null);
    assert(rule.validate("#xyz") !== null);
  });
});

describe("t.object()", () => {
  it("accepts valid object", () => {
    const rule = t.object({ maxKeys: 10 });
    assertEqual(rule.validate({ key: "value" }), null);
  });

  it("rejects too many keys", () => {
    const rule = t.object({ maxKeys: 2 });
    assert(rule.validate({ a: 1, b: 2, c: 3 }) !== null);
  });

  it("rejects non-object", () => {
    const rule = t.object();
    assert(rule.validate("string") !== null);
    assert(rule.validate(42) !== null);
  });

  it("accepts missing when optional", () => {
    const rule = t.object();
    assertEqual(rule.validate(undefined), null);
  });
});

describe("sanitize()", () => {
  it("strips control characters", () => {
    const result = sanitize("hello\x00world\x08!");
    assertEqual(result, "helloworld!");
  });

  it("keeps tabs/newlines/carriage returns", () => {
    const result = sanitize("line1\nline2\ttab\rmore");
    assertEqual(result, "line1\nline2\ttab\rmore");
  });

  it("trims whitespace", () => {
    const result = sanitize("  hello  ");
    assertEqual(result, "hello");
  });

  it("passes through non-strings", () => {
    assertEqual(sanitize(42), 42);
    assertEqual(sanitize(null), null);
  });
});

describe("validate() middleware", () => {
  it("passes valid body through", () => {
    const mw = validate({
      body: { name: t.string({ required: true, min: 2 }) },
    });
    const req = mockReq({ name: "test" });
    let nextCalled = false;
    mw(req, mockRes(), () => { nextCalled = true; });
    assert(nextCalled, "next() should be called");
  });

  it("throws on invalid body", () => {
    const mw = validate({
      body: { name: t.string({ required: true, min: 5 }) },
    });
    const req = mockReq({ name: "ab" });
    let error;
    try {
      mw(req, mockRes(), (err) => { error = err; });
    } catch (e) {
      error = e;
    }
    assert(error, "Should throw or pass error to next");
  });

  it("validates query params", () => {
    const mw = validate({
      query: { sort: t.oneOf(["hot", "new"]) },
    });
    const req = mockReq({}, {}, { sort: "hot" });
    let nextCalled = false;
    mw(req, mockRes(), () => { nextCalled = true; });
    assert(nextCalled);
  });
});

describe("requireUUIDParam()", () => {
  it("passes valid UUID param", () => {
    const mw = requireUUIDParam("id");
    const req = mockReq({}, { id: "550e8400-e29b-41d4-a716-446655440000" });
    let nextCalled = false;
    mw(req, mockRes(), () => { nextCalled = true; });
    assert(nextCalled);
  });

  it("rejects invalid UUID param", () => {
    const mw = requireUUIDParam("id");
    const req = mockReq({}, { id: "not-a-uuid" });
    let error;
    try {
      mw(req, mockRes(), (err) => { error = err; });
    } catch (e) {
      error = e;
    }
    assert(error, "Should throw or pass error to next");
  });
});

// ──────────────────────────────────────────────
// Runner
// ──────────────────────────────────────────────
async function run() {
  console.log("\n  Validation Middleware Unit Tests\n");
  console.log("=".repeat(50));

  for (const suite of suites) {
    console.log(`\n  [${suite.name}]`);
    for (const t of suite.tests) {
      try {
        await t.fn();
        console.log(`    \x1b[32m✓\x1b[0m ${t.name}`);
        passed++;
      } catch (err) {
        console.log(`    \x1b[31m✗\x1b[0m ${t.name}`);
        console.log(`      Error: ${err.message}`);
        failed++;
      }
    }
  }

  console.log("\n" + "=".repeat(50));
  console.log(
    `\n  Results: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m\n`
  );
  process.exit(failed > 0 ? 1 : 0);
}

run();

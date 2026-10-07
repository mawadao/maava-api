/**
 * Product Orders — Integration Tests
 *
 * Tests the full order API against a live database:
 *   - Create order (POST /api/v1/seller/orders)
 *   - List orders (GET /api/v1/seller/orders)
 *   - Get order (GET /api/v1/seller/orders/:id)
 *   - Update order (PATCH /api/v1/seller/orders/:id)
 *   - Confirm payment (POST /api/v1/seller/orders/:id/confirm-payment)
 *   - Payment webhook (POST /api/v1/seller/orders/webhook/payment)
 *   - Auth enforcement
 *   - Cross-user isolation
 *
 * Run:  node test/orders.integration.test.js
 * Env:  DATABASE_URL must point to a live database with the product_orders table
 */

const http = require("http");
const crypto = require("crypto");
const app = require("../src/app");

// ──────────────────────────────────────────────
// Minimal test framework
// ──────────────────────────────────────────────
let passed = 0;
let failed = 0;
let skipped = 0;
const suites = [];
let currentSuite = null;

function describe(name, fn) {
  currentSuite = { name, tests: [] };
  suites.push(currentSuite);
  fn();
  currentSuite = null;
}

function it(name, fn) {
  if (!currentSuite) throw new Error("it() must be inside describe()");
  currentSuite.tests.push({ name, fn });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "Assertion failed");
}

function assertEqual(a, b, msg) {
  if (a !== b)
    throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// ──────────────────────────────────────────────
// HTTP helpers
// ──────────────────────────────────────────────
let BASE_URL;

function request(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: { "Content-Type": "application/json", ...headers },
    };
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = data;
        }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function get(p, h) { return request("GET", p, null, h); }
function post(p, b, h) { return request("POST", p, b, h); }
function patch(p, b, h) { return request("PATCH", p, b, h); }

function auth(apiKey) { return { Authorization: `Bearer ${apiKey}` }; }

// ──────────────────────────────────────────────
// Test state
// ──────────────────────────────────────────────
const TS = Date.now();
let pool;
let userA = {};  // { id, apiKey } — seller who owns a product
let userB = {};  // { id, apiKey } — another user
let productId;
let orderId;

// ──────────────────────────────────────────────
// Setup: create test users + seller profile + product directly in DB
// (User registration is waitlisted, so we bypass the API)
// ──────────────────────────────────────────────
async function setup() {
  const { getPool, tenantTransaction } = require("../src/config/database");
  const { hashToken, generateApiKey } = require("../src/utils/auth");

  pool = getPool();
  if (!pool) throw new Error("DATABASE_URL not configured — cannot run integration tests");

  const apiKeyA = generateApiKey();
  const apiKeyB = generateApiKey();

  // Create user A
  const userAResult = await pool.query(
    `INSERT INTO users (username, email, password_hash, api_key_hash, display_name, is_active, is_verified)
     VALUES ($1, $2, $3, $4, $5, true, true)
     RETURNING id`,
    [
      `test_seller_${TS}`,
      `test_seller_${TS}@test.local`,
      crypto.randomBytes(32).toString("hex"), // dummy hash
      hashToken(apiKeyA),
      `Test Seller ${TS}`,
    ]
  );
  userA.id = userAResult.rows[0].id;
  userA.apiKey = apiKeyA;

  // Create user B
  const userBResult = await pool.query(
    `INSERT INTO users (username, email, password_hash, api_key_hash, display_name, is_active, is_verified)
     VALUES ($1, $2, $3, $4, $5, true, true)
     RETURNING id`,
    [
      `test_buyer_${TS}`,
      `test_buyer_${TS}@test.local`,
      crypto.randomBytes(32).toString("hex"),
      hashToken(apiKeyB),
      `Test Buyer ${TS}`,
    ]
  );
  userB.id = userBResult.rows[0].id;
  userB.apiKey = apiKeyB;

  // Create seller profile for user A (needed for seller endpoints)
  await tenantTransaction(userA.id, async (client) => {
    await client.query(
      `INSERT INTO seller_profiles (user_id, business_name, timezone)
       VALUES ($1, $2, 'UTC')
       ON CONFLICT (user_id) DO NOTHING`,
      [userA.id, `Test Biz ${TS}`]
    );
  });

  // Create a product owned by user A
  const prodResult = await tenantTransaction(userA.id, async (client) => {
    return client.query(
      `INSERT INTO products (user_id, name, summary, price, currency, pricing_model, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        userA.id,
        `Test Product ${TS}`,
        "Integration test product",
        "19.99",
        "USDC",
        "one_time",
        "active",
      ]
    );
  });
  productId = prodResult.rows[0].id;

  console.log(`  [setup] User A: ${userA.id} (apiKey: ${apiKeyA.slice(0, 20)}...)`);
  console.log(`  [setup] User B: ${userB.id}`);
  console.log(`  [setup] Product: ${productId}`);
}

// ──────────────────────────────────────────────
// Cleanup: remove test data
// ──────────────────────────────────────────────
async function cleanup() {
  if (!pool) return;
  try {
    // Delete in FK order
    await pool.query(`DELETE FROM product_orders WHERE seller_user_id IN ($1, $2)`, [userA.id, userB.id]);
    await pool.query(`DELETE FROM publishing_targets WHERE user_id IN ($1, $2)`, [userA.id, userB.id]);
    await pool.query(`DELETE FROM connected_social_accounts WHERE user_id IN ($1, $2)`, [userA.id, userB.id]);
    await pool.query(`DELETE FROM product_assets WHERE user_id IN ($1, $2)`, [userA.id, userB.id]);
    await pool.query(`DELETE FROM listing_outputs WHERE product_id IN (SELECT id FROM products WHERE user_id IN ($1, $2))`, [userA.id, userB.id]);
    await pool.query(`DELETE FROM products WHERE user_id IN ($1, $2)`, [userA.id, userB.id]);
    await pool.query(`DELETE FROM seller_profiles WHERE user_id IN ($1, $2)`, [userA.id, userB.id]);
    await pool.query(`DELETE FROM users WHERE id IN ($1, $2)`, [userA.id, userB.id]);
    console.log("  [cleanup] Test data removed.");
  } catch (err) {
    console.error("  [cleanup] Warning:", err.message);
  }
}

// ═══════════════════════════════════════════════
// TEST SUITES
// ═══════════════════════════════════════════════

describe("Auth Enforcement", () => {
  it("rejects unauthenticated GET /seller/orders", async () => {
    const r = await get("/api/v1/seller/orders");
    assert(r.status >= 400, `Expected 4xx, got ${r.status}`);
  });

  it("rejects unauthenticated POST /seller/orders", async () => {
    const r = await post("/api/v1/seller/orders", { productId: "fake" });
    assert(r.status >= 400, `Expected 4xx, got ${r.status}`);
  });

  it("rejects invalid bearer token", async () => {
    const r = await get("/api/v1/seller/orders", auth("invalid_token"));
    assert(r.status >= 400, `Expected 4xx, got ${r.status}`);
  });
});

describe("Create Order (POST /seller/orders)", () => {
  it("creates an order for seller's own product", async () => {
    const r = await post(
      "/api/v1/seller/orders",
      {
        productId,
        amount: "19.99",
        currency: "USDC",
        buyerAgentId: "agent-test-123",
        paymentLinkId: `pay_test_${TS}`,
      },
      auth(userA.apiKey)
    );
    assertEqual(r.status, 201, `Create failed: ${JSON.stringify(r.body)}`);
    assert(r.body.data, "Response should have data");
    assert(r.body.data.id, "Order should have id");
    assertEqual(r.body.data.status, "created");
    assertEqual(r.body.data.payment_status, "pending");
    assertEqual(r.body.data.delivery_status, "pending");
    assertEqual(r.body.data.amount, "19.99");
    assertEqual(r.body.data.currency, "USDC");
    orderId = r.body.data.id;
  });

  it("rejects create without required productId", async () => {
    const r = await post(
      "/api/v1/seller/orders",
      { amount: "10" },
      auth(userA.apiKey)
    );
    assertEqual(r.status, 400, `Expected 400, got ${r.status}`);
  });

  it("rejects create with invalid UUID for productId", async () => {
    const r = await post(
      "/api/v1/seller/orders",
      { productId: "not-a-uuid", amount: "10" },
      auth(userA.apiKey)
    );
    assertEqual(r.status, 400, `Expected 400, got ${r.status}`);
  });

  it("returns 404 for non-existent product", async () => {
    const r = await post(
      "/api/v1/seller/orders",
      { productId: "00000000-0000-0000-0000-000000000000", amount: "10" },
      auth(userA.apiKey)
    );
    assertEqual(r.status, 404, `Expected 404, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it("user B cannot create order for user A's product", async () => {
    const r = await post(
      "/api/v1/seller/orders",
      { productId, amount: "10" },
      auth(userB.apiKey)
    );
    // Either 403 (ForbiddenError) or 404 (RLS hides it)
    assert(
      r.status === 403 || r.status === 404,
      `Expected 403 or 404, got ${r.status}: ${JSON.stringify(r.body)}`
    );
  });
});

describe("Get Order (GET /seller/orders/:id)", () => {
  it("returns order details with product info", async () => {
    const r = await get(`/api/v1/seller/orders/${orderId}`, auth(userA.apiKey));
    assertEqual(r.status, 200, `Get failed: ${JSON.stringify(r.body)}`);
    assertEqual(r.body.data.id, orderId);
    assert(r.body.data.product_name, "Should include product_name");
  });

  it("returns 404 for non-existent order", async () => {
    const r = await get(
      "/api/v1/seller/orders/00000000-0000-0000-0000-000000000000",
      auth(userA.apiKey)
    );
    assertEqual(r.status, 404, `Expected 404, got ${r.status}`);
  });

  it("returns 400 for invalid UUID param", async () => {
    const r = await get("/api/v1/seller/orders/not-a-uuid", auth(userA.apiKey));
    assertEqual(r.status, 400, `Expected 400, got ${r.status}`);
  });
});

describe("List Orders (GET /seller/orders)", () => {
  it("returns an array of orders for the seller", async () => {
    const r = await get("/api/v1/seller/orders", auth(userA.apiKey));
    assertEqual(r.status, 200, `List failed: ${JSON.stringify(r.body)}`);
    assert(Array.isArray(r.body.data), "data should be an array");
    assert(r.body.data.length >= 1, "Should have at least 1 order");
  });

  it("filters by status", async () => {
    const r = await get("/api/v1/seller/orders?status=created", auth(userA.apiKey));
    assertEqual(r.status, 200);
    for (const o of r.body.data) {
      assertEqual(o.status, "created", "All orders should have status=created");
    }
  });

  it("filters by productId", async () => {
    const r = await get(`/api/v1/seller/orders?productId=${productId}`, auth(userA.apiKey));
    assertEqual(r.status, 200);
    for (const o of r.body.data) {
      assertEqual(o.product_id, productId, "All orders should match productId");
    }
  });

  it("respects limit parameter", async () => {
    const r = await get("/api/v1/seller/orders?limit=1", auth(userA.apiKey));
    assertEqual(r.status, 200);
    assert(r.body.data.length <= 1, "Should respect limit=1");
  });

  it("user B sees no orders (isolation)", async () => {
    const r = await get("/api/v1/seller/orders", auth(userB.apiKey));
    assertEqual(r.status, 200);
    assertEqual(r.body.data.length, 0, "User B should have no orders");
  });
});

describe("Update Order (PATCH /seller/orders/:id)", () => {
  it("updates order status", async () => {
    const r = await patch(
      `/api/v1/seller/orders/${orderId}`,
      { status: "confirmed" },
      auth(userA.apiKey)
    );
    assertEqual(r.status, 200, `Update failed: ${JSON.stringify(r.body)}`);
    assertEqual(r.body.data.status, "confirmed");
  });

  it("updates delivery status to delivered", async () => {
    const r = await patch(
      `/api/v1/seller/orders/${orderId}`,
      { deliveryStatus: "delivered" },
      auth(userA.apiKey)
    );
    assertEqual(r.status, 200);
    assertEqual(r.body.data.delivery_status, "delivered");
    assert(r.body.data.delivered_at, "delivered_at should be set");
  });

  it("updates notes", async () => {
    const r = await patch(
      `/api/v1/seller/orders/${orderId}`,
      { notes: "Sent download link via email" },
      auth(userA.apiKey)
    );
    assertEqual(r.status, 200);
    assertEqual(r.body.data.notes, "Sent download link via email");
  });

  it("rejects invalid status value", async () => {
    const r = await patch(
      `/api/v1/seller/orders/${orderId}`,
      { status: "invalid_status_value" },
      auth(userA.apiKey)
    );
    assertEqual(r.status, 400, `Expected 400, got ${r.status}`);
  });

  it("rejects invalid deliveryStatus value", async () => {
    const r = await patch(
      `/api/v1/seller/orders/${orderId}`,
      { deliveryStatus: "shipped" },
      auth(userA.apiKey)
    );
    assertEqual(r.status, 400, `Expected 400, got ${r.status}`);
  });

  it("user B cannot update user A's order", async () => {
    const r = await patch(
      `/api/v1/seller/orders/${orderId}`,
      { status: "cancelled" },
      auth(userB.apiKey)
    );
    // 403 or 404 depending on RLS visibility
    assert(
      r.status === 403 || r.status === 404,
      `Expected 403 or 404, got ${r.status}`
    );
  });
});

describe("Confirm Payment (POST /seller/orders/:id/confirm-payment)", () => {
  it("confirms payment with tx hash and chain", async () => {
    // Reset the order to created/pending first
    await patch(
      `/api/v1/seller/orders/${orderId}`,
      { status: "created" },
      auth(userA.apiKey)
    );

    const r = await post(
      `/api/v1/seller/orders/${orderId}/confirm-payment`,
      { txHash: "0xabc123def456", chain: "solana" },
      auth(userA.apiKey)
    );
    assertEqual(r.status, 200, `Confirm failed: ${JSON.stringify(r.body)}`);
    assertEqual(r.body.data.payment_status, "paid");
    assertEqual(r.body.data.payment_tx_hash, "0xabc123def456");
    assertEqual(r.body.data.payment_chain, "solana");
    assertEqual(r.body.data.status, "confirmed");
    assert(r.body.data.paid_at, "paid_at should be set");
  });

  it("confirms payment without tx hash (manual)", async () => {
    // Create a second order for this test
    const createR = await post(
      "/api/v1/seller/orders",
      { productId, amount: "5.00" },
      auth(userA.apiKey)
    );
    assertEqual(createR.status, 201);
    const secondOrderId = createR.body.data.id;

    const r = await post(
      `/api/v1/seller/orders/${secondOrderId}/confirm-payment`,
      {},
      auth(userA.apiKey)
    );
    assertEqual(r.status, 200);
    assertEqual(r.body.data.payment_status, "paid");
    assertEqual(r.body.data.status, "confirmed");
  });

  it("user B cannot confirm user A's order payment", async () => {
    const r = await post(
      `/api/v1/seller/orders/${orderId}/confirm-payment`,
      { txHash: "0x111" },
      auth(userB.apiKey)
    );
    assert(
      r.status === 403 || r.status === 404,
      `Expected 403 or 404, got ${r.status}`
    );
  });

  it("returns 404 for non-existent order", async () => {
    const r = await post(
      "/api/v1/seller/orders/00000000-0000-0000-0000-000000000000/confirm-payment",
      { txHash: "0x1" },
      auth(userA.apiKey)
    );
    assertEqual(r.status, 404, `Expected 404, got ${r.status}`);
  });
});

describe("Payment Webhook (POST /seller/orders/webhook/payment)", () => {
  it("accepts webhook and updates order to paid", async () => {
    // Create a fresh order with a known payment_link_id
    const linkId = `pay_webhook_${TS}`;
    const createR = await post(
      "/api/v1/seller/orders",
      { productId, amount: "7.77", paymentLinkId: linkId },
      auth(userA.apiKey)
    );
    assertEqual(createR.status, 201);
    const webhookOrderId = createR.body.data.id;

    // Fire the webhook (no auth required)
    const r = await post("/api/v1/seller/orders/webhook/payment", {
      paymentLinkId: linkId,
      status: "paid",
      txHash: "0xwebhook_tx_hash",
      chain: "base",
    });
    assertEqual(r.status, 200, `Webhook failed: ${JSON.stringify(r.body)}`);
    assert(r.body.data, "Response should have data");
    assertEqual(r.body.data.received, true);
    assertEqual(r.body.data.orderId, webhookOrderId);

    // Verify the order was actually updated
    const check = await get(`/api/v1/seller/orders/${webhookOrderId}`, auth(userA.apiKey));
    assertEqual(check.status, 200);
    assertEqual(check.body.data.payment_status, "paid");
    assertEqual(check.body.data.payment_tx_hash, "0xwebhook_tx_hash");
    assertEqual(check.body.data.status, "confirmed");
  });

  it("handles 'completed' status the same as 'paid'", async () => {
    const linkId = `pay_completed_${TS}`;
    const createR = await post(
      "/api/v1/seller/orders",
      { productId, amount: "3.33", paymentLinkId: linkId },
      auth(userA.apiKey)
    );
    assertEqual(createR.status, 201);

    const r = await post("/api/v1/seller/orders/webhook/payment", {
      paymentLinkId: linkId,
      status: "completed",
      transactionHash: "0xcompleted_hash",
    });
    assertEqual(r.status, 200);
    assertEqual(r.body.data.received, true);
  });

  it("handles 'failed' status", async () => {
    const linkId = `pay_failed_${TS}`;
    const createR = await post(
      "/api/v1/seller/orders",
      { productId, amount: "2.22", paymentLinkId: linkId },
      auth(userA.apiKey)
    );
    assertEqual(createR.status, 201);
    const failOrderId = createR.body.data.id;

    const r = await post("/api/v1/seller/orders/webhook/payment", {
      paymentLinkId: linkId,
      status: "failed",
    });
    assertEqual(r.status, 200);

    // Verify
    const check = await get(`/api/v1/seller/orders/${failOrderId}`, auth(userA.apiKey));
    assertEqual(check.body.data.payment_status, "failed");
  });

  it("handles 'expired' status (cancels order)", async () => {
    const linkId = `pay_expired_${TS}`;
    const createR = await post(
      "/api/v1/seller/orders",
      { productId, amount: "1.11", paymentLinkId: linkId },
      auth(userA.apiKey)
    );
    assertEqual(createR.status, 201);
    const expiredOrderId = createR.body.data.id;

    const r = await post("/api/v1/seller/orders/webhook/payment", {
      paymentLinkId: linkId,
      status: "expired",
    });
    assertEqual(r.status, 200);

    // Verify
    const check = await get(`/api/v1/seller/orders/${expiredOrderId}`, auth(userA.apiKey));
    assertEqual(check.body.data.payment_status, "expired");
    assertEqual(check.body.data.status, "cancelled");
  });

  it("returns 400 when paymentLinkId is missing", async () => {
    const r = await post("/api/v1/seller/orders/webhook/payment", {
      status: "paid",
    });
    assertEqual(r.status, 400, `Expected 400, got ${r.status}`);
  });

  it("succeeds silently for unknown paymentLinkId", async () => {
    const r = await post("/api/v1/seller/orders/webhook/payment", {
      paymentLinkId: "pay_nonexistent_xyz",
      status: "paid",
    });
    assertEqual(r.status, 200);
    assertEqual(r.body.data.orderId, null);
  });

  it("does not require auth (open endpoint)", async () => {
    // This just verifies we don't get a 401
    const r = await post("/api/v1/seller/orders/webhook/payment", {
      paymentLinkId: "pay_noauth_test",
      status: "paid",
    });
    // Should NOT be 401
    assert(r.status !== 401, `Webhook should not require auth, got 401`);
  });
});

describe("Full Order Lifecycle", () => {
  it("create → confirm payment → deliver → complete", async () => {
    // 1. Create
    const linkId = `pay_lifecycle_${TS}`;
    const r1 = await post(
      "/api/v1/seller/orders",
      {
        productId,
        amount: "49.99",
        buyerAgentId: "agent-lifecycle",
        paymentLinkId: linkId,
      },
      auth(userA.apiKey)
    );
    assertEqual(r1.status, 201);
    const lcOrderId = r1.body.data.id;
    assertEqual(r1.body.data.status, "created");
    assertEqual(r1.body.data.payment_status, "pending");

    // 2. Webhook confirms payment
    const r2 = await post("/api/v1/seller/orders/webhook/payment", {
      paymentLinkId: linkId,
      status: "paid",
      txHash: "0xlifecycle_tx",
      chain: "solana",
    });
    assertEqual(r2.status, 200);

    // 3. Verify payment confirmed
    const r3 = await get(`/api/v1/seller/orders/${lcOrderId}`, auth(userA.apiKey));
    assertEqual(r3.body.data.payment_status, "paid");
    assertEqual(r3.body.data.status, "confirmed");

    // 4. Deliver
    const r4 = await patch(
      `/api/v1/seller/orders/${lcOrderId}`,
      {
        deliveryStatus: "delivered",
      },
      auth(userA.apiKey)
    );
    assertEqual(r4.status, 200);
    assertEqual(r4.body.data.delivery_status, "delivered");
    assert(r4.body.data.delivered_at, "delivered_at should be set");

    // 5. Complete
    const r5 = await patch(
      `/api/v1/seller/orders/${lcOrderId}`,
      { status: "completed" },
      auth(userA.apiKey)
    );
    assertEqual(r5.status, 200);
    assertEqual(r5.body.data.status, "completed");
  });
});

// ═══════════════════════════════════════════════
// Runner
// ═══════════════════════════════════════════════
async function run() {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  BASE_URL = `http://127.0.0.1:${port}`;

  console.log(`\n  Test server listening on ${BASE_URL}\n`);
  console.log("=".repeat(60));
  console.log("  Product Orders — Integration Tests");
  console.log("=".repeat(60));

  // Setup test data in DB
  try {
    await setup();
  } catch (err) {
    console.error(`\n  \x1b[31m✗ Setup failed: ${err.message}\x1b[0m`);
    console.error("    Ensure DATABASE_URL is set and the product_orders table exists.");
    console.error("    Run: db/migrations/023_marketplace_orders.sql\n");
    try { server.close(); } catch {}
    process.exit(1);
  }

  const startTime = Date.now();

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

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log("\n" + "=".repeat(60));
  console.log(
    `  Results: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m${skipped ? `, \x1b[33m${skipped} skipped\x1b[0m` : ""} (${elapsed}s)`
  );
  console.log("=".repeat(60) + "\n");

  // Cleanup
  try {
    await cleanup();
  } catch (err) {
    console.error("  Cleanup error:", err.message);
  }

  // Shutdown
  try { server.close(); } catch {}
  try {
    const { close } = require("../src/config/database");
    await close();
  } catch {}

  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

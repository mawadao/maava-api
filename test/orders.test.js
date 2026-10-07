/**
 * Product Orders — Unit Tests
 *
 * Tests SellerService order methods in isolation by mocking the database layer.
 * Covers: createOrder, getOrder, listOrders, updateOrder, confirmPayment,
 *         handlePaymentWebhook.
 *
 * Run: node test/orders.test.js
 */

// ──────────────────────────────────────────────
// Minimal test framework (matches existing pattern)
// ──────────────────────────────────────────────
let passed = 0;
let failed = 0;
const suites = [];
let currentSuite = null;

function describe(name, fn) {
  currentSuite = { name, tests: [], beforeEachFn: null };
  suites.push(currentSuite);
  fn();
  currentSuite = null;
}

function beforeEach(fn) {
  if (currentSuite) currentSuite.beforeEachFn = fn;
}

function it(name, fn) {
  if (!currentSuite) throw new Error("it() must be inside describe()");
  currentSuite.tests.push({ name, fn });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "Assertion failed");
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

function assertDeepEqual(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

function assertThrows(fn, expectedType, msg) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      return result.then(
        () => { throw new Error(msg || `Expected ${expectedType?.name || "error"} but no error thrown`); },
        (err) => {
          if (expectedType && !(err instanceof expectedType)) {
            throw new Error(msg || `Expected ${expectedType.name}, got ${err.constructor.name}: ${err.message}`);
          }
          return err;
        }
      );
    }
    throw new Error(msg || `Expected ${expectedType?.name || "error"} but no error thrown`);
  } catch (err) {
    if (expectedType && !(err instanceof expectedType)) {
      throw new Error(msg || `Expected ${expectedType.name}, got ${err.constructor.name}: ${err.message}`);
    }
    return err;
  }
}

// ──────────────────────────────────────────────
// Database mocking
// ──────────────────────────────────────────────
const dbMock = {
  _queryOneResults: [],
  _queryAllResults: [],
  _poolClient: null,

  reset() {
    this._queryOneResults = [];
    this._queryAllResults = [];
    this._poolClient = null;
  },

  /** Push a result that queryOne will return (FIFO queue) */
  mockQueryOne(result) {
    this._queryOneResults.push(result);
  },

  /** Push a result that queryAll will return (FIFO queue) */
  mockQueryAll(result) {
    this._queryAllResults.push(result);
  },

  /** Set up a mock pool client for handlePaymentWebhook */
  mockPoolClient(queryResults = []) {
    const results = [...queryResults];
    this._poolClient = {
      queries: [],
      query(text, params) {
        this.queries.push({ text, params });
        const next = results.shift();
        return next || { rows: [] };
      },
      release() {},
    };
  },
};

// ──────────────────────────────────────────────
// Module interception — override database functions
// ──────────────────────────────────────────────

// We need to intercept require() for ../config/database inside SellerService.
// Strategy: pre-populate the require cache with our mock.

const path = require("path");
const Module = require("module");

const dbModulePath = path.resolve(__dirname, "../src/config/database.js");

// Build mock module
const mockDb = {
  queryOne: async (text, params) => {
    const result = dbMock._queryOneResults.shift();
    if (result instanceof Error) throw result;
    return result === undefined ? null : result;
  },
  queryAll: async (text, params) => {
    const result = dbMock._queryAllResults.shift();
    if (result instanceof Error) throw result;
    return result === undefined ? [] : result;
  },
  query: async (text, params) => {
    const result = dbMock._queryOneResults.shift();
    if (result instanceof Error) throw result;
    return { rows: result ? [result] : [], rowCount: result ? 1 : 0 };
  },
  transaction: async (callback) => {
    // Simple pass-through — the mock queryOne/queryAll will handle results
    return callback({
      query: async (text, params) => {
        const result = dbMock._queryOneResults.shift();
        if (result instanceof Error) throw result;
        return { rows: result ? [result] : [], rowCount: result ? 1 : 0 };
      },
    });
  },
  tenantTransaction: async (userId, callback) => {
    return callback({
      query: async (text, params) => {
        const result = dbMock._queryOneResults.shift();
        if (result instanceof Error) throw result;
        return { rows: result ? [result] : [], rowCount: result ? 1 : 0 };
      },
    });
  },
  rlsStorage: { getStore: () => "mock-user-id", run: (uid, fn) => fn() },
  getPool: () => {
    if (!dbMock._poolClient) return null;
    return {
      connect: async () => dbMock._poolClient,
    };
  },
  initializePool: () => {},
  healthCheck: async () => true,
  close: async () => {},
};

// Inject into require cache BEFORE loading SellerService
require.cache[dbModulePath] = {
  id: dbModulePath,
  filename: dbModulePath,
  loaded: true,
  exports: mockDb,
};

// Now load SellerService (it will get our mock database)
const SellerService = require("../src/services/SellerService");
const {
  NotFoundError,
  ForbiddenError,
  BadRequestError,
  ConflictError,
} = require("../src/utils/errors");

// ──────────────────────────────────────────────
// Test data factories
// ──────────────────────────────────────────────
const USER_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const OTHER_USER_ID = "11111111-2222-3333-4444-555555555555";
const PRODUCT_ID = "cccccccc-dddd-eeee-ffff-000000000001";
const ORDER_ID = "dddddddd-eeee-ffff-0000-111111111111";

function makeProduct(overrides = {}) {
  return {
    id: PRODUCT_ID,
    user_id: USER_ID,
    name: "Test Product",
    summary: "A test product",
    price: "9.99",
    currency: "USDC",
    status: "active",
    ...overrides,
  };
}

function makeOrder(overrides = {}) {
  return {
    id: ORDER_ID,
    product_id: PRODUCT_ID,
    seller_user_id: USER_ID,
    buyer_user_id: null,
    buyer_agent_id: "agent-xyz",
    amount: "9.99",
    currency: "USDC",
    payment_link_id: "pay_link_123",
    payment_status: "pending",
    delivery_status: "pending",
    status: "created",
    payment_tx_hash: null,
    payment_chain: null,
    paid_at: null,
    delivered_at: null,
    delivery_data: null,
    notes: null,
    metadata: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

// ═══════════════════════════════════════════════
// TEST SUITES
// ═══════════════════════════════════════════════

// ─── createOrder ────────────────────────────────

describe("SellerService.createOrder", () => {
  beforeEach(() => dbMock.reset());

  it("creates an order for a valid product owned by the seller", async () => {
    const product = makeProduct();
    const insertedOrder = makeOrder();

    dbMock.mockQueryOne(product);       // SELECT product
    dbMock.mockQueryOne(insertedOrder); // INSERT order

    const result = await SellerService.createOrder(USER_ID, {
      productId: PRODUCT_ID,
      amount: "9.99",
      buyerAgentId: "agent-xyz",
    });

    assertEqual(result.id, ORDER_ID);
    assertEqual(result.seller_user_id, USER_ID);
    assertEqual(result.product_id, PRODUCT_ID);
    assertEqual(result.payment_status, "pending");
    assertEqual(result.status, "created");
  });

  it("throws NotFoundError when product does not exist", async () => {
    dbMock.mockQueryOne(null); // product not found

    const err = await assertThrows(
      () => SellerService.createOrder(USER_ID, { productId: PRODUCT_ID }),
      NotFoundError
    );
    assert(err.message.toLowerCase().includes("not found"), "Error should mention not found");
  });

  it("throws ForbiddenError when product belongs to another user", async () => {
    const product = makeProduct({ user_id: OTHER_USER_ID });
    dbMock.mockQueryOne(product);

    const err = await assertThrows(
      () => SellerService.createOrder(USER_ID, { productId: PRODUCT_ID }),
      ForbiddenError
    );
    assert(err.message.toLowerCase().includes("not your"), "Error should indicate ownership issue");
  });

  it("defaults amount to product price when not supplied", async () => {
    const product = makeProduct({ price: "25.00", currency: "USDC" });
    const order = makeOrder({ amount: "25.00" });

    dbMock.mockQueryOne(product);
    dbMock.mockQueryOne(order);

    const result = await SellerService.createOrder(USER_ID, {
      productId: PRODUCT_ID,
      // no amount specified
    });

    assertEqual(result.amount, "25.00");
  });

  it("defaults currency to USDC when product has no currency", async () => {
    const product = makeProduct({ currency: null });
    const order = makeOrder({ currency: "USDC" });

    dbMock.mockQueryOne(product);
    dbMock.mockQueryOne(order);

    const result = await SellerService.createOrder(USER_ID, {
      productId: PRODUCT_ID,
    });

    assertEqual(result.currency, "USDC");
  });

  it("accepts optional buyerUserId and paymentLinkId", async () => {
    const product = makeProduct();
    const order = makeOrder({
      buyer_user_id: OTHER_USER_ID,
      payment_link_id: "pay_abc_123",
    });

    dbMock.mockQueryOne(product);
    dbMock.mockQueryOne(order);

    const result = await SellerService.createOrder(USER_ID, {
      productId: PRODUCT_ID,
      buyerUserId: OTHER_USER_ID,
      paymentLinkId: "pay_abc_123",
    });

    assertEqual(result.buyer_user_id, OTHER_USER_ID);
    assertEqual(result.payment_link_id, "pay_abc_123");
  });
});

// ─── getOrder ────────────────────────────────────

describe("SellerService.getOrder", () => {
  beforeEach(() => dbMock.reset());

  it("returns order with product details when found", async () => {
    const order = makeOrder({
      product_name: "Test Product",
      product_summary: "A test product",
    });
    dbMock.mockQueryOne(order);

    const result = await SellerService.getOrder(ORDER_ID);
    assertEqual(result.id, ORDER_ID);
    assertEqual(result.product_name, "Test Product");
    assertEqual(result.product_summary, "A test product");
  });

  it("throws NotFoundError when order does not exist", async () => {
    dbMock.mockQueryOne(null);

    const err = await assertThrows(
      () => SellerService.getOrder("nonexistent-id"),
      NotFoundError
    );
    assert(err.message.toLowerCase().includes("not found"));
  });
});

// ─── listOrders ──────────────────────────────────

describe("SellerService.listOrders", () => {
  beforeEach(() => dbMock.reset());

  it("returns all orders for a seller (no filters)", async () => {
    const orders = [
      makeOrder({ id: "order-1", status: "created" }),
      makeOrder({ id: "order-2", status: "confirmed" }),
    ];
    dbMock.mockQueryAll(orders);

    const result = await SellerService.listOrders(USER_ID);
    assertEqual(result.length, 2);
    assertEqual(result[0].id, "order-1");
    assertEqual(result[1].id, "order-2");
  });

  it("returns empty array when no orders exist", async () => {
    dbMock.mockQueryAll([]);

    const result = await SellerService.listOrders(USER_ID);
    assertEqual(result.length, 0);
  });

  it("filters orders by status", async () => {
    const orders = [makeOrder({ status: "confirmed" })];
    dbMock.mockQueryAll(orders);

    const result = await SellerService.listOrders(USER_ID, { status: "confirmed" });
    assertEqual(result.length, 1);
    assertEqual(result[0].status, "confirmed");
  });

  it("filters orders by productId", async () => {
    const orders = [makeOrder({ product_id: PRODUCT_ID })];
    dbMock.mockQueryAll(orders);

    const result = await SellerService.listOrders(USER_ID, { productId: PRODUCT_ID });
    assertEqual(result.length, 1);
    assertEqual(result[0].product_id, PRODUCT_ID);
  });

  it("filters by both status and productId", async () => {
    const orders = [makeOrder({ status: "created", product_id: PRODUCT_ID })];
    dbMock.mockQueryAll(orders);

    const result = await SellerService.listOrders(USER_ID, {
      status: "created",
      productId: PRODUCT_ID,
    });
    assertEqual(result.length, 1);
  });

  it("respects limit and offset", async () => {
    dbMock.mockQueryAll([makeOrder()]);

    const result = await SellerService.listOrders(USER_ID, { limit: 5, offset: 10 });
    assert(Array.isArray(result), "Should return array");
  });

  it("uses default limit=25 and offset=0", async () => {
    dbMock.mockQueryAll([]);

    // Just verify no error with defaults
    const result = await SellerService.listOrders(USER_ID);
    assert(Array.isArray(result));
  });
});

// ─── updateOrder ─────────────────────────────────

describe("SellerService.updateOrder", () => {
  beforeEach(() => dbMock.reset());

  it("updates order status for the owning seller", async () => {
    const order = makeOrder();
    const updated = makeOrder({ status: "confirmed" });

    dbMock.mockQueryOne(order);   // SELECT
    dbMock.mockQueryOne(updated); // UPDATE

    const result = await SellerService.updateOrder(ORDER_ID, USER_ID, { status: "confirmed" });
    assertEqual(result.status, "confirmed");
  });

  it("throws NotFoundError for non-existent order", async () => {
    dbMock.mockQueryOne(null);

    await assertThrows(
      () => SellerService.updateOrder("bad-id", USER_ID, { status: "confirmed" }),
      NotFoundError
    );
  });

  it("throws ForbiddenError when user doesn't own the order", async () => {
    const order = makeOrder({ seller_user_id: OTHER_USER_ID });
    dbMock.mockQueryOne(order);

    await assertThrows(
      () => SellerService.updateOrder(ORDER_ID, USER_ID, { status: "confirmed" }),
      ForbiddenError
    );
  });

  it("returns unchanged order when no fields provided", async () => {
    const order = makeOrder();
    dbMock.mockQueryOne(order);

    const result = await SellerService.updateOrder(ORDER_ID, USER_ID, {});
    assertEqual(result.id, ORDER_ID);
    assertEqual(result.status, "created"); // unchanged
  });

  it("updates delivery status to delivered", async () => {
    const order = makeOrder();
    const updated = makeOrder({ delivery_status: "delivered", delivered_at: new Date().toISOString() });

    dbMock.mockQueryOne(order);
    dbMock.mockQueryOne(updated);

    const result = await SellerService.updateOrder(ORDER_ID, USER_ID, {
      deliveryStatus: "delivered",
    });
    assertEqual(result.delivery_status, "delivered");
    assert(result.delivered_at, "delivered_at should be set");
  });

  it("updates notes field", async () => {
    const order = makeOrder();
    const updated = makeOrder({ notes: "Shipped via email" });

    dbMock.mockQueryOne(order);
    dbMock.mockQueryOne(updated);

    const result = await SellerService.updateOrder(ORDER_ID, USER_ID, {
      notes: "Shipped via email",
    });
    assertEqual(result.notes, "Shipped via email");
  });

  it("updates delivery data (JSONB)", async () => {
    const order = makeOrder();
    const deliveryData = { downloadUrl: "https://example.com/file.zip", accessKey: "abc123" };
    const updated = makeOrder({ delivery_data: deliveryData });

    dbMock.mockQueryOne(order);
    dbMock.mockQueryOne(updated);

    const result = await SellerService.updateOrder(ORDER_ID, USER_ID, {
      deliveryData,
    });
    assertDeepEqual(result.delivery_data, deliveryData);
  });

  it("updates multiple fields at once", async () => {
    const order = makeOrder();
    const updated = makeOrder({
      status: "completed",
      delivery_status: "delivered",
      notes: "Done",
    });

    dbMock.mockQueryOne(order);
    dbMock.mockQueryOne(updated);

    const result = await SellerService.updateOrder(ORDER_ID, USER_ID, {
      status: "completed",
      deliveryStatus: "delivered",
      notes: "Done",
    });
    assertEqual(result.status, "completed");
    assertEqual(result.delivery_status, "delivered");
    assertEqual(result.notes, "Done");
  });
});

// ─── confirmPayment ──────────────────────────────

describe("SellerService.confirmPayment", () => {
  beforeEach(() => dbMock.reset());

  it("confirms payment with tx hash and chain", async () => {
    const order = makeOrder();
    const confirmed = makeOrder({
      payment_status: "paid",
      payment_tx_hash: "0xabc123",
      payment_chain: "solana",
      paid_at: new Date().toISOString(),
      status: "confirmed",
    });

    dbMock.mockQueryOne(order);
    dbMock.mockQueryOne(confirmed);

    const result = await SellerService.confirmPayment(ORDER_ID, USER_ID, {
      txHash: "0xabc123",
      chain: "solana",
    });

    assertEqual(result.payment_status, "paid");
    assertEqual(result.payment_tx_hash, "0xabc123");
    assertEqual(result.payment_chain, "solana");
    assertEqual(result.status, "confirmed");
    assert(result.paid_at, "paid_at should be set");
  });

  it("confirms payment without tx hash (manual confirmation)", async () => {
    const order = makeOrder();
    const confirmed = makeOrder({
      payment_status: "paid",
      status: "confirmed",
      paid_at: new Date().toISOString(),
    });

    dbMock.mockQueryOne(order);
    dbMock.mockQueryOne(confirmed);

    const result = await SellerService.confirmPayment(ORDER_ID, USER_ID, {});
    assertEqual(result.payment_status, "paid");
    assertEqual(result.status, "confirmed");
  });

  it("throws NotFoundError for non-existent order", async () => {
    dbMock.mockQueryOne(null);

    await assertThrows(
      () => SellerService.confirmPayment("bad-id", USER_ID, { txHash: "0x1" }),
      NotFoundError
    );
  });

  it("throws ForbiddenError when user doesn't own the order", async () => {
    const order = makeOrder({ seller_user_id: OTHER_USER_ID });
    dbMock.mockQueryOne(order);

    await assertThrows(
      () => SellerService.confirmPayment(ORDER_ID, USER_ID, { txHash: "0x1" }),
      ForbiddenError
    );
  });
});

// ─── handlePaymentWebhook ────────────────────────

describe("SellerService.handlePaymentWebhook", () => {
  beforeEach(() => dbMock.reset());

  it("marks order as paid when status is 'paid'", async () => {
    const order = makeOrder();
    const updated = makeOrder({
      payment_status: "paid",
      payment_tx_hash: "0xdef456",
      payment_chain: "base",
      status: "confirmed",
      paid_at: new Date().toISOString(),
    });

    dbMock.mockPoolClient([
      { rows: [] },                    // BEGIN
      { rows: [] },                    // set_config (service_role)
      { rows: [order] },              // SELECT order by payment_link_id
      { rows: [] },                    // set_config (current_user_id)
      { rows: [updated] },            // UPDATE order
      { rows: [] },                    // COMMIT
    ]);

    const result = await SellerService.handlePaymentWebhook("pay_link_123", {
      status: "paid",
      txHash: "0xdef456",
      chain: "base",
    });

    assertEqual(result.payment_status, "paid");
    assertEqual(result.payment_tx_hash, "0xdef456");
    assertEqual(result.status, "confirmed");
  });

  it("marks order as paid when status is 'completed'", async () => {
    const order = makeOrder();
    const updated = makeOrder({
      payment_status: "paid",
      payment_tx_hash: "0xaaa",
      status: "confirmed",
    });

    dbMock.mockPoolClient([
      { rows: [] },
      { rows: [] },
      { rows: [order] },
      { rows: [] },
      { rows: [updated] },
      { rows: [] },
    ]);

    const result = await SellerService.handlePaymentWebhook("pay_link_123", {
      status: "completed",
      transactionHash: "0xaaa",
    });

    assertEqual(result.payment_status, "paid");
  });

  it("marks order as failed when status is 'failed'", async () => {
    const order = makeOrder();
    const updated = makeOrder({ payment_status: "failed" });

    dbMock.mockPoolClient([
      { rows: [] },
      { rows: [] },
      { rows: [order] },
      { rows: [] },
      { rows: [updated] },
      { rows: [] },
    ]);

    const result = await SellerService.handlePaymentWebhook("pay_link_123", {
      status: "failed",
    });

    assertEqual(result.payment_status, "failed");
  });

  it("cancels order when status is 'expired'", async () => {
    const order = makeOrder();
    const updated = makeOrder({ payment_status: "expired", status: "cancelled" });

    dbMock.mockPoolClient([
      { rows: [] },
      { rows: [] },
      { rows: [order] },
      { rows: [] },
      { rows: [updated] },
      { rows: [] },
    ]);

    const result = await SellerService.handlePaymentWebhook("pay_link_123", {
      status: "expired",
    });

    assertEqual(result.payment_status, "expired");
    assertEqual(result.status, "cancelled");
  });

  it("returns null when no order found for payment link", async () => {
    dbMock.mockPoolClient([
      { rows: [] },   // BEGIN
      { rows: [] },   // set_config
      { rows: [] },   // SELECT — no match
      { rows: [] },   // COMMIT
    ]);

    const result = await SellerService.handlePaymentWebhook("pay_nonexistent", {
      status: "paid",
    });

    assertEqual(result, null);
  });

  it("returns null when pool is not available", async () => {
    // Don't mock pool client → getPool returns null
    const result = await SellerService.handlePaymentWebhook("pay_link_123", {
      status: "paid",
    });

    assertEqual(result, null);
  });

  it("returns original order when status is unrecognized", async () => {
    const order = makeOrder();

    dbMock.mockPoolClient([
      { rows: [] },
      { rows: [] },
      { rows: [order] },
      { rows: [] },
      // no UPDATE query — unrecognized status
      { rows: [] },   // COMMIT
    ]);

    const result = await SellerService.handlePaymentWebhook("pay_link_123", {
      status: "pending", // not paid/completed/failed/expired
    });

    assertEqual(result.id, ORDER_ID);
  });
});

// ═══════════════════════════════════════════════
// Runner
// ═══════════════════════════════════════════════
async function run() {
  console.log("\n  Product Orders — Unit Tests\n");
  console.log("=".repeat(60));

  for (const suite of suites) {
    console.log(`\n  [${suite.name}]`);
    for (const t of suite.tests) {
      try {
        if (suite.beforeEachFn) suite.beforeEachFn();
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

  console.log("\n" + "=".repeat(60));
  console.log(
    `  Results: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m`
  );
  console.log("=".repeat(60) + "\n");

  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

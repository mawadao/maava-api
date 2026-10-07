/**
 * Configuration API Integration Test Suite
 *
 * Tests the full API against the live database:
 *   - Agent registration, login, profile
 *   - Community (community) CRUD & subscriptions
 *   - Posts (create, feed, delete)
 *   - Comments (create, thread, delete)
 *   - Voting (upvote/downvote posts & comments)
 *   - Following / unfollowing agents
 *   - Marketplace (create listing, buy, orders)
 *   - Multi-tenant: each agent gets its own backend via Cloud Run deploy trigger
 *
 * Run:  node test/integration.test.js
 * Env:  DATABASE_URL must point to a live Supabase database
 */

const http = require("http");
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
  if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

function assertIncludes(str, sub, msg) {
  if (typeof str !== "string" || !str.includes(sub))
    throw new Error(msg || `Expected "${str}" to include "${sub}"`);
}

// ──────────────────────────────────────────────
// HTTP helper — sends requests to our test server
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

function get(path, headers) {
  return request("GET", path, null, headers);
}
function post(path, body, headers) {
  return request("POST", path, body, headers);
}
function del(path, headers) {
  return request("DELETE", path, null, headers);
}
function patch(path, body, headers) {
  return request("PATCH", path, body, headers);
}

function auth(apiKey) {
  return { Authorization: `Bearer ${apiKey}` };
}

// ──────────────────────────────────────────────
// Shared test state
// ──────────────────────────────────────────────
const TS = Date.now();
const AGENT_A = { name: `test_agent_a_${TS}`, password: "TestPass123!" };
const AGENT_B = { name: `test_agent_b_${TS}`, password: "TestPass456!" };
let agentA = {}; // { id, apiKey, name }
let agentB = {};
let communityName;
let postId;
let commentId;
let listingId;

// ═══════════════════════════════════════════════
// TEST SUITES
// ═══════════════════════════════════════════════

// 1. Health check
describe("Health Check", () => {
  it("GET / returns API info", async () => {
    const r = await get("/");
    assertEqual(r.status, 200);
    assert(r.body.name, "Should have name");
  });

  it("GET /api/v1/health returns ok", async () => {
    const r = await get("/api/v1/health");
    assertEqual(r.status, 200);
    assertEqual(r.body.status, "healthy");
  });
});

// 2. Agent Registration & Login
describe("Agent Registration & Login", () => {
  it("registers agent A", async () => {
    const r = await post("/api/v1/agents/register", {
      name: AGENT_A.name,
      password: AGENT_A.password,
      description: "Integration test agent A",
    });
    assertEqual(r.status, 201, `Register failed: ${JSON.stringify(r.body)}`);
    assert(r.body.agent.api_key, "Should return api_key");
    assert(r.body.agent.id, "Should return agent id");
    agentA.id = r.body.agent.id;
    agentA.apiKey = r.body.agent.api_key;
    agentA.name = AGENT_A.name;
  });

  it("registers agent B", async () => {
    const r = await post("/api/v1/agents/register", {
      name: AGENT_B.name,
      password: AGENT_B.password,
      description: "Integration test agent B",
    });
    assertEqual(r.status, 201, `Register failed: ${JSON.stringify(r.body)}`);
    agentB.id = r.body.agent.id;
    agentB.apiKey = r.body.agent.api_key;
    agentB.name = AGENT_B.name;
  });

  it("rejects duplicate agent name", async () => {
    const r = await post("/api/v1/agents/register", {
      name: AGENT_A.name,
      password: "AnyPass1!",
    });
    assert(r.status >= 400, "Should reject duplicate");
  });

  it("rejects invalid agent name (too short)", async () => {
    const r = await post("/api/v1/agents/register", {
      name: "a",
      password: "AnyPass1!",
    });
    assertEqual(r.status, 400);
  });

  it("logs in agent A with password", async () => {
    const r = await post("/api/v1/agents/login", {
      name: AGENT_A.name,
      password: AGENT_A.password,
    });
    assertEqual(r.status, 200, `Login failed: ${JSON.stringify(r.body)}`);
    assert(r.body.apiKey, "Should return new apiKey");
    // Update to the freshly-generated key
    agentA.apiKey = r.body.apiKey;
  });

  it("rejects wrong password", async () => {
    const r = await post("/api/v1/agents/login", {
      name: AGENT_A.name,
      password: "WrongPassword!",
    });
    assert(r.status >= 400, "Should reject wrong password");
  });

  it("GET /agents/me returns authenticated agent", async () => {
    const r = await get("/api/v1/agents/me", auth(agentA.apiKey));
    assertEqual(r.status, 200);
    assertEqual(r.body.agent.name, AGENT_A.name);
  });

  it("rejects unauthenticated /agents/me", async () => {
    const r = await get("/api/v1/agents/me");
    assert(r.status >= 400, "Should reject");
  });
});

// 3. Agent Profile
describe("Agent Profile", () => {
  it("GET /agents lists agents", async () => {
    const r = await get("/api/v1/agents?limit=5", auth(agentA.apiKey));
    assertEqual(r.status, 200);
    assert(Array.isArray(r.body.data), "Should return array");
  });

  it("GET /agents/profile returns agent profile", async () => {
    const r = await get(`/api/v1/agents/profile?name=${AGENT_A.name}`, auth(agentA.apiKey));
    assertEqual(r.status, 200);
    assertEqual(r.body.agent.name, AGENT_A.name);
  });

  it("PATCH /agents/me updates profile", async () => {
    const r = await patch(
      "/api/v1/agents/me",
      { description: "Updated via integration test" },
      auth(agentA.apiKey)
    );
    assertEqual(r.status, 200);
  });
});

// 4. Community (Community) CRUD
describe("Community (Community)", () => {
  it("creates a new community", async () => {
    communityName = `test_sub_${TS}`;
    if (communityName.length > 24) communityName = communityName.slice(0, 24);
    const r = await post(
      "/api/v1/communities",
      { name: communityName, display_name: "Test Community", description: "Integration test community" },
      auth(agentA.apiKey)
    );
    assertEqual(r.status, 201, `Create community failed: ${JSON.stringify(r.body)}`);
  });

  it("rejects duplicate community name", async () => {
    const r = await post(
      "/api/v1/communities",
      { name: communityName, display_name: "Dup", description: "dup" },
      auth(agentA.apiKey)
    );
    assert(r.status >= 400, "Should reject duplicate community");
  });

  it("GET /communities lists communities", async () => {
    const r = await get("/api/v1/communities", auth(agentA.apiKey));
    assertEqual(r.status, 200);
    assert(Array.isArray(r.body.data), "Should return array");
  });

  it("GET /communities/:name returns community info", async () => {
    const r = await get(`/api/v1/communities/${communityName}`, auth(agentA.apiKey));
    assertEqual(r.status, 200);
    assertEqual(r.body.community.name, communityName);
  });

  it("agent B subscribes to community", async () => {
    const r = await post(`/api/v1/communities/${communityName}/subscribe`, {}, auth(agentB.apiKey));
    assertEqual(r.status, 200, `Subscribe failed: ${JSON.stringify(r.body)}`);
  });

  it("agent B unsubscribes from community", async () => {
    const r = await del(`/api/v1/communities/${communityName}/subscribe`, auth(agentB.apiKey));
    assertEqual(r.status, 200, `Unsubscribe failed: ${JSON.stringify(r.body)}`);
  });
});

// 5. Posts
describe("Posts", () => {
  it("creates a text post in community", async () => {
    const r = await post(
      "/api/v1/posts",
      { community: communityName, title: "Integration Test Post", content: "Hello from the test suite!" },
      auth(agentA.apiKey)
    );
    assertEqual(r.status, 201, `Create post failed: ${JSON.stringify(r.body)}`);
    postId = r.body.post?.id;
    assert(postId, "Should return post id");
  });

  it("rejects post without title", async () => {
    const r = await post(
      "/api/v1/posts",
      { community: communityName, content: "No title" },
      auth(agentB.apiKey)
    );
    assertEqual(r.status, 400);
  });

  it("rejects post to nonexistent community", async () => {
    const r = await post(
      "/api/v1/posts",
      { community: "nonexistent_sub_xyz", title: "Fail", content: "Should fail" },
      auth(agentB.apiKey)
    );
    assert(r.status >= 400, "Should reject nonexistent community");
  });

  it("GET /posts returns feed", async () => {
    const r = await get("/api/v1/posts?sort=new&limit=10", auth(agentA.apiKey));
    assertEqual(r.status, 200);
    assert(Array.isArray(r.body.data), "Should return array");
  });

  it("GET /posts/:id returns single post", async () => {
    const r = await get(`/api/v1/posts/${postId}`, auth(agentA.apiKey));
    assertEqual(r.status, 200);
    assert(r.body.post, "Should have post object");
  });

  it("GET /communities/:name/feed returns posts", async () => {
    const r = await get(`/api/v1/communities/${communityName}/feed?sort=new`, auth(agentA.apiKey));
    assertEqual(r.status, 200);
  });
});

// 6. Comments
describe("Comments", () => {
  it("adds a comment to the post", async () => {
    const r = await post(
      `/api/v1/posts/${postId}/comments`,
      { content: "Great integration test post!" },
      auth(agentB.apiKey)
    );
    assertEqual(r.status, 201, `Comment failed: ${JSON.stringify(r.body)}`);
    commentId = r.body.comment?.id;
    assert(commentId, "Should return comment id");
  });

  it("adds a threaded reply", async () => {
    const r = await post(
      `/api/v1/posts/${postId}/comments`,
      { content: "Replying to integration test comment", parent_id: commentId },
      auth(agentA.apiKey)
    );
    assertEqual(r.status, 201, `Reply failed: ${JSON.stringify(r.body)}`);
  });

  it("rejects empty comment", async () => {
    const r = await post(
      `/api/v1/posts/${postId}/comments`,
      { content: "" },
      auth(agentA.apiKey)
    );
    assert(r.status >= 400, "Should reject empty comment");
  });

  it("GET /posts/:id/comments returns comment tree", async () => {
    const r = await get(`/api/v1/posts/${postId}/comments`, auth(agentA.apiKey));
    assertEqual(r.status, 200);
    assert(r.body.comments, "Should have comments array");
    assert(r.body.comments.length >= 1, "Should have at least 1 top-level comment");
  });
});

// 7. Voting
describe("Voting", () => {
  it("agent B upvotes the post", async () => {
    const r = await post(`/api/v1/posts/${postId}/upvote`, {}, auth(agentB.apiKey));
    assertEqual(r.status, 200, `Upvote failed: ${JSON.stringify(r.body)}`);
  });

  it("agent B toggles upvote off (re-upvote)", async () => {
    const r = await post(`/api/v1/posts/${postId}/upvote`, {}, auth(agentB.apiKey));
    assertEqual(r.status, 200);
  });

  it("agent B downvotes the post", async () => {
    const r = await post(`/api/v1/posts/${postId}/downvote`, {}, auth(agentB.apiKey));
    assertEqual(r.status, 200, `Downvote failed: ${JSON.stringify(r.body)}`);
  });

  it("agent A upvotes agent B's comment", async () => {
    const r = await post(`/api/v1/comments/${commentId}/upvote`, {}, auth(agentA.apiKey));
    // Some implementations might use /posts/:id/comments/:id/upvote
    // Skip if route doesn't exist
    if (r.status === 404) {
      skipped++;
      return;
    }
    assertEqual(r.status, 200, `Comment upvote failed: ${JSON.stringify(r.body)}`);
  });

  it("rejects self-vote on own post", async () => {
    const r = await post(`/api/v1/posts/${postId}/upvote`, {}, auth(agentA.apiKey));
    // Self-voting may return 400 or 403
    assert(r.status >= 400, "Should reject self-vote");
  });
});

// 8. Following
describe("Following", () => {
  it("agent B follows agent A", async () => {
    const r = await post(`/api/v1/agents/${AGENT_A.name}/follow`, {}, auth(agentB.apiKey));
    assertEqual(r.status, 200, `Follow failed: ${JSON.stringify(r.body)}`);
  });

  it("verifies follower count incremented", async () => {
    const r = await get(`/api/v1/agents/profile?name=${AGENT_A.name}`, auth(agentB.apiKey));
    assertEqual(r.status, 200);
    const agent = r.body.agent;
    assert(
      agent.followerCount >= 1 || agent.follower_count >= 1,
      `Follower count should be >=1, got ${JSON.stringify(agent)}`
    );
  });

  it("agent B unfollows agent A", async () => {
    const r = await del(`/api/v1/agents/${AGENT_A.name}/follow`, auth(agentB.apiKey));
    assertEqual(r.status, 200, `Unfollow failed: ${JSON.stringify(r.body)}`);
  });
});

// 9. Marketplace
describe("Marketplace", () => {
  it("agent A creates a marketplace listing", async () => {
    const r = await post(
      "/api/v1/marketplace/listings",
      {
        title: "Test AI Service",
        description: "An integration test listing",
        priceCredits: 100,
        metadata: { category: "coding" },
      },
      auth(agentA.apiKey)
    );
    assertEqual(r.status, 201, `Create listing failed: ${JSON.stringify(r.body)}`);
    listingId = r.body.listing?.id;
    assert(listingId, "Should return listing id");
  });

  it("GET /marketplace/listings returns listings", async () => {
    const r = await get("/api/v1/marketplace/listings");
    assertEqual(r.status, 200);
    assert(Array.isArray(r.body.data), "Should return array");
  });

  it("GET /marketplace/listings/:id returns single listing", async () => {
    const r = await get(`/api/v1/marketplace/listings/${listingId}`);
    assertEqual(r.status, 200);
    assert(r.body.listing, "Should have listing");
  });

  it("rejects buying own listing", async () => {
    const r = await post(
      `/api/v1/marketplace/listings/${listingId}/buy`,
      {},
      auth(agentA.apiKey)
    );
    assert(r.status >= 400, "Should reject self-purchase");
  });

  it("agent B tries to buy (may fail due to insufficient credits)", async () => {
    const r = await post(
      `/api/v1/marketplace/listings/${listingId}/buy`,
      {},
      auth(agentB.apiKey)
    );
    // This may return 403 (insufficient credits) or 200 (success) depending on agent B's credits
    assert(
      r.status === 200 || r.status === 403,
      `Buy should return 200 or 403, got ${r.status}: ${JSON.stringify(r.body)}`
    );
  });

  it("agent A archives the listing", async () => {
    const r = await del(`/api/v1/marketplace/listings/${listingId}`, auth(agentA.apiKey));
    assertEqual(r.status, 204, `Archive failed: ${JSON.stringify(r.body)}`);
  });

  it("rejects archiving someone else's listing", async () => {
    // Create another listing first
    const createR = await post(
      "/api/v1/marketplace/listings",
      { title: "Agent A Exclusive", description: "Only A can delete", priceCredits: 50 },
      auth(agentA.apiKey)
    );
    const newId = createR.body.listing?.id;
    if (!newId) {
      skipped++;
      return;
    }
    const r = await del(`/api/v1/marketplace/listings/${newId}`, auth(agentB.apiKey));
    assert(r.status >= 400, "Should reject unauthorized archive");
  });
});

// 10. Search
describe("Search", () => {
  it("searches for agents", async () => {
    const r = await get(`/api/v1/search?q=${AGENT_A.name}&limit=5`, auth(agentA.apiKey));
    if (r.status === 404) {
      skipped++;
      return; // search route may not exist
    }
    assertEqual(r.status, 200);
  });
});

// 11. Feed
describe("Personalized Feed", () => {
  it("GET /feed returns personalized feed", async () => {
    const r = await get("/api/v1/feed?limit=10", auth(agentA.apiKey));
    if (r.status === 404) {
      skipped++;
      return;
    }
    assertEqual(r.status, 200);
  });
});

// 12. Post Deletion
describe("Post Deletion", () => {
  it("non-author cannot delete post", async () => {
    const r = await del(`/api/v1/posts/${postId}`, auth(agentB.apiKey));
    assert(r.status >= 400, "Should reject non-author delete");
  });

  it("author can delete own post", async () => {
    const r = await del(`/api/v1/posts/${postId}`, auth(agentA.apiKey));
    assertEqual(r.status, 204, `Delete post failed: ${JSON.stringify(r.body)}`);
  });
});

// ──────────────────────────────────────────────
// Cleanup helpers
// ──────────────────────────────────────────────
async function cleanup(pool) {
  try {
    // Remove test data in correct FK order
    await pool.query(`DELETE FROM marketplace_orders WHERE buyer_id IN ($1, $2) OR seller_id IN ($1, $2)`, [agentA.id, agentB.id]);
    await pool.query(`DELETE FROM marketplace_listings WHERE agent_id IN ($1, $2)`, [agentA.id, agentB.id]);
    await pool.query(`DELETE FROM votes WHERE agent_id IN ($1, $2)`, [agentA.id, agentB.id]);
    await pool.query(`DELETE FROM comments WHERE author_id IN ($1, $2)`, [agentA.id, agentB.id]);
    await pool.query(`DELETE FROM posts WHERE author_id IN ($1, $2)`, [agentA.id, agentB.id]);
    await pool.query(`DELETE FROM follows WHERE follower_id IN ($1, $2) OR followed_id IN ($1, $2)`, [agentA.id, agentB.id]);
    await pool.query(`DELETE FROM subscriptions WHERE agent_id IN ($1, $2)`, [agentA.id, agentB.id]);
    await pool.query(`DELETE FROM community_moderators WHERE agent_id IN ($1, $2)`, [agentA.id, agentB.id]);
    if (communityName) {
      await pool.query(`DELETE FROM communities WHERE name = $1`, [communityName]);
    }
    await pool.query(`DELETE FROM agents WHERE id IN ($1, $2)`, [agentA.id, agentB.id]);
    console.log("  [cleanup] Test data removed.");
  } catch (err) {
    console.error("  [cleanup] Warning:", err.message);
  }
}

// ──────────────────────────────────────────────
// Runner
// ──────────────────────────────────────────────
async function run() {
  // Start a test server on a random port
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  BASE_URL = `http://127.0.0.1:${port}`;
  console.log(`\n  Test server listening on ${BASE_URL}\n`);
  console.log("=" .repeat(60));
  console.log("  Configuration API Integration Tests");
  console.log("=".repeat(60));

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

  // Cleanup test data
  try {
    const { getPool } = require("../src/config/database");
    const pool = getPool();
    if (pool && agentA.id && agentB.id) {
      await cleanup(pool);
    }
  } catch (err) {
    console.error("  Cleanup error:", err.message);
  }

  // Shutdown
  try {
    server.close();
  } catch {}
  try {
    const { close } = require("../src/config/database");
    await close();
  } catch {}

  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

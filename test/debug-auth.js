const http = require("http");
const app = require("../src/app");
const s = http.createServer(app);

s.listen(0, async () => {
  const port = s.address().port;
  const ts = Date.now();

  function req(method, path, body, headers = {}) {
    return new Promise((ok) => {
      const opts = {
        hostname: "127.0.0.1", port, path, method,
        headers: { "Content-Type": "application/json", ...headers },
      };
      const r = http.request(opts, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          let p; try { p = JSON.parse(d); } catch { p = d; }
          ok({ status: res.statusCode, body: p });
        });
      });
      if (body) r.write(JSON.stringify(body));
      r.end();
    });
  }

  // 1. Register
  const regRes = await req("POST", "/api/v1/agents/register", {
    name: "dbg_" + ts, password: "TestPass123!", description: "dbg"
  });
  console.log("=== REGISTER ===");
  console.log("Status:", regRes.status);
  console.log("Body keys:", Object.keys(regRes.body));
  console.log("agent keys:", regRes.body.agent ? Object.keys(regRes.body.agent) : "NO AGENT");
  console.log("api_key:", regRes.body.agent?.api_key?.substring(0, 20), "...");
  console.log("api_key length:", regRes.body.agent?.api_key?.length);

  const apiKey = regRes.body.agent?.api_key;

  // 2. Use the key
  console.log("\n=== AUTH TEST (GET /agents/me) ===");
  console.log("Using token:", apiKey?.substring(0, 20), "...");
  const meRes = await req("GET", "/api/v1/agents/me", null, {
    Authorization: `Bearer ${apiKey}`,
  });
  console.log("Status:", meRes.status);
  console.log("Body:", JSON.stringify(meRes.body).substring(0, 200));

  // 3. Login
  console.log("\n=== LOGIN ===");
  const loginRes = await req("POST", "/api/v1/agents/login", {
    name: "dbg_" + ts, password: "TestPass123!"
  });
  console.log("Status:", loginRes.status);
  console.log("Body keys:", Object.keys(loginRes.body));
  console.log("apiKey:", loginRes.body.apiKey?.substring(0, 20), "...");
  console.log("apiKey length:", loginRes.body.apiKey?.length);

  const newKey = loginRes.body.apiKey;

  // 4. Auth with new key
  console.log("\n=== AUTH TEST 2 (new key) ===");
  const me2 = await req("GET", "/api/v1/agents/me", null, {
    Authorization: `Bearer ${newKey}`,
  });
  console.log("Status:", me2.status);
  console.log("Body:", JSON.stringify(me2.body).substring(0, 200));

  s.close();
  try { const { close } = require("../src/config/database"); await close(); } catch {}
  process.exit(0);
});

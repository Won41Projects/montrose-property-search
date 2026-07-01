import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3847);
const BASE = "https://eagleweb.montrosecounty.net/eagleassessor";
const APP_VERSION = "2026-07-01-levy";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  store(response) {
    const setCookies =
      typeof response.headers?.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [];

    for (const raw of setCookies) {
      this.storeRawCookie(raw);
    }
  }

  storeFromNodeResponse(response) {
    const header = response.headers["set-cookie"];
    if (!header) return;
    const cookies = Array.isArray(header) ? header : [header];
    for (const raw of cookies) {
      this.storeRawCookie(raw);
    }
  }

  storeRawCookie(raw) {
    const [pair] = raw.split(";");
    const eq = pair.indexOf("=");
    if (eq === -1) return;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    this.cookies.set(name, value);
  }

  header() {
    return [...this.cookies.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }
}

function decodeHtml(text) {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

function stripTags(html) {
  return decodeHtml(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function emptySearchForm() {
  return {
    AllTypes: "ALL",
    docTypeTotal: "4",
    AccountNumID: "",
    ParcelNumberID: "",
    OwnerIDSearchString: "",
    OwnerIDSearchType: "Normal",
    BusinessIDSearchString: "",
    BusinessIDSearchType: "Normal",
    SitusIDHouseNumber: "",
    SitusIDExtent: "",
    SitusIDDirectionSuffix: "",
    SitusIDStreetName: "",
    SitusIDDesignation: "",
    SitusIDDirection: "",
    SitusIDSuffix: "",
    SitusIDUnitNumber: "",
  };
}

function formatOwnerName(name) {
  return name.replace(/,/g, " ").replace(/\s+/g, " ").trim();
}

function ownerVariants(name) {
  const cleaned = formatOwnerName(name);
  const parts = cleaned.split(" ").filter(Boolean);
  const variants = [cleaned];

  if (parts.length === 2) {
    variants.push(`${parts[1]} ${parts[0]}`);
  }

  return [...new Set(variants)];
}

function normalizeAccount(value) {
  const trimmed = value.trim().toUpperCase();
  if (/^R\d+$/.test(trimmed)) return trimmed;
  if (/^[RMU]\d+$/.test(trimmed)) return trimmed;
  if (/^\d+$/.test(trimmed)) {
    const digits = trimmed.replace(/^0+/, "") || "0";
    return `R${digits.padStart(7, "0")}`;
  }
  return trimmed;
}

function buildSearchAttempts(query) {
  const trimmed = query.trim();
  const attempts = [];

  if (/^\d{4}-\d{3}-\d{2}-\d{3}(?:-\d+)?$/i.test(trimmed)) {
    attempts.push({
      matchType: "Parcel",
      fields: { ParcelNumberID: trimmed },
    });
  }

  if (/^[A-Za-z]?\d{4,}$/.test(trimmed) || /^[RMU]\d+$/i.test(trimmed)) {
    attempts.push({
      matchType: "Account",
      fields: { AccountNumID: normalizeAccount(trimmed) },
    });
  }

  const addressMatch = trimmed.match(/^(\d+[A-Za-z]?)\s+(.+)$/);
  if (addressMatch) {
    attempts.push({
      matchType: "Address",
      fields: {
        SitusIDHouseNumber: addressMatch[1],
        SitusIDStreetName: addressMatch[2].toUpperCase(),
      },
    });
    attempts.push({
      matchType: "Address",
      fields: {
        SitusIDStreetName: trimmed.toUpperCase(),
      },
    });
  }

  for (const owner of ownerVariants(trimmed)) {
    attempts.push({
      matchType: "Owner",
      fields: { OwnerIDSearchString: owner },
    });
  }

  if (!addressMatch) {
    attempts.push({
      matchType: "Address",
      fields: { SitusIDStreetName: trimmed.toUpperCase() },
    });
  }

  const seen = new Set();
  return attempts.filter((attempt) => {
    const key = JSON.stringify(attempt.fields);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseResults(html) {
  const results = [];
  const seen = new Set();
  const rowPattern = /<tr[^>]*class="tableRow\d+"[^>]*>([\s\S]*?)<\/tr>/gi;

  let rowMatch;
  while ((rowMatch = rowPattern.exec(html)) !== null) {
    const rowHtml = rowMatch[1];
    const accountMatch = rowHtml.match(
      /<a[^>]+href="([^"]*account\.jsp\?accountNum=([^"&]+)[^"]*)"[^>]*>\s*([^<]+)\s*<\/a>/i,
    );
    if (!accountMatch) continue;

    const [, href, accountNumber, accountLabel] = accountMatch;
    if (seen.has(accountNumber)) continue;
    seen.add(accountNumber);

    const summary = stripTags(rowHtml);
    const parcel =
      summary.match(/\d{4}-\d{3}-\d{2}-\d{3}(?:\s*-\s*\d+)?/)?.[0] ?? "";

    results.push({
      accountNumber: stripTags(accountLabel || accountNumber),
      parcel,
      summary,
      detailUrl: href.startsWith("http")
        ? href
        : new URL(href, `${BASE}/taxweb/`).toString(),
    });
  }

  return results;
}

function parseMoney(value) {
  if (value == null) return null;
  const cleaned = String(value).replace(/[^0-9.-]/g, "");
  if (!cleaned) return null;
  const amount = Number(cleaned);
  return Number.isFinite(amount) ? amount : null;
}

function parseAssessmentTable(html) {
  const normalized = html
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/t[dh][^>]*>/gi, "\t")
    .replace(/<tr[^>]*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n");
  const text = stripTags(normalized);

  const headerMatch = text.match(
    /Value Summary[\s\S]*?Type\s+([0-9]{4}(?:\s+[0-9]{4})*)/i,
  );
  const assessmentYear = headerMatch?.[1]?.trim().split(/\s+/)[0] ?? null;

  function readRow(label) {
    const pattern = new RegExp(
      `${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+([^\\n]+)`,
      "i",
    );
    const match = text.match(pattern);
    if (!match) return null;
    const firstValue = match[1].trim().split(/\s+/)[0];
    return parseMoney(firstValue);
  }

  let nonSchoolAssessedValue = readRow("Total Non-School Assessed Value");
  let nonSchoolActualValue = readRow("Total Non-School Actual Value");

  if (nonSchoolAssessedValue == null) {
    const summaryMatch =
      text.match(/Non-School Assessed[:\s]+\$?\s*([\d,]+)/i) ??
      html.match(/Non-School Assessed[^$]{0,40}\$?\s*([\d,]+)/i);
    nonSchoolAssessedValue = parseMoney(summaryMatch?.[1]);
  }

  if (nonSchoolActualValue == null) {
    const actualMatch =
      text.match(/Actual\s*\(?\s*(\d{4})\s*\)?[:\s]+\$?\s*([\d,]+)/i) ??
      text.match(/Total Non-School Actual Value\s+\$?\s*([\d,]+)/i);
    nonSchoolActualValue = parseMoney(actualMatch?.[2] ?? actualMatch?.[1]);
  }

  return {
    assessmentYear,
    nonSchoolAssessedValue,
    nonSchoolActualValue,
  };
}

function loadLevyConfig() {
  const configPath = path.join(__dirname, "levy.config.json");
  if (!fs.existsSync(configPath)) {
    return {
      label: "Proposed mill levy",
      millLevy: null,
      assessmentYear: null,
      notes: "",
      calibration: {},
    };
  }

  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function deriveMillLevy(annualIncrease, nonSchoolAssessedValue) {
  if (!annualIncrease || !nonSchoolAssessedValue) return null;
  return (annualIncrease * 1000) / nonSchoolAssessedValue;
}

function resolveMillLevy(config) {
  if (typeof config.millLevy === "number" && config.millLevy > 0) {
    return config.millLevy;
  }

  const { sampleAnnualIncrease, sampleNonSchoolAssessedValue } =
    config.calibration ?? {};

  return deriveMillLevy(sampleAnnualIncrease, sampleNonSchoolAssessedValue);
}

function estimateAnnualIncrease(nonSchoolAssessedValue, millLevy) {
  if (!nonSchoolAssessedValue || !millLevy) return null;
  return (nonSchoolAssessedValue * millLevy) / 1000;
}

async function fetchAccountAssessment(jar, accountNumber) {
  const urls = [
    `${BASE}/taxweb/account.jsp?accountNum=${encodeURIComponent(accountNumber)}&doc=AccountValue`,
    `${BASE}/taxweb/account.jsp?accountNum=${encodeURIComponent(accountNumber)}`,
  ];

  let lastError = null;

  for (const url of urls) {
    try {
      const { body } = await eagleFetch(jar, url);

      if (
        body.includes("please login") ||
        body.includes("session is no longer active")
      ) {
        throw new Error("EagleWeb session expired while loading assessment.");
      }

      const assessment = parseAssessmentTable(body);
      if (assessment.nonSchoolAssessedValue != null) {
        return assessment;
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) throw lastError;

  return {
    assessmentYear: null,
    nonSchoolAssessedValue: null,
    nonSchoolActualValue: null,
  };
}

async function enrichResultsWithLevy(jar, results) {
  const levyConfig = loadLevyConfig();
  const millLevy = resolveMillLevy(levyConfig);

  const enriched = await Promise.all(
    results.map(async (result) => {
      let assessment = {
        assessmentYear: null,
        nonSchoolAssessedValue: null,
        nonSchoolActualValue: null,
      };

      try {
        assessment = await fetchAccountAssessment(jar, result.accountNumber);
      } catch {
        // Keep search results even if one assessment lookup fails.
      }

      const annualIncrease =
        millLevy != null
          ? estimateAnnualIncrease(assessment.nonSchoolAssessedValue, millLevy)
          : null;

      return {
        ...result,
        assessment,
        levyImpact: {
          millLevy,
          annualIncrease,
          monthlyIncrease:
            annualIncrease != null ? Number((annualIncrease / 12).toFixed(2)) : null,
        },
      };
    }),
  );

  return {
    results: enriched,
    levy: {
      label: levyConfig.label,
      millLevy,
      configured: millLevy != null,
      assessmentYear: levyConfig.assessmentYear ?? null,
      formula: "annualIncrease = nonSchoolAssessedValue × millLevy ÷ 1000",
      notes: levyConfig.notes ?? "",
    },
  };
}

function parseResultMessage(html) {
  const text = stripTags(html);
  const query = text.match(/Query:\s*(.+?)(?:Showing|$)/i)?.[1]?.trim();
  const count = text.match(/Showing\s+(\d+)\s+result/i)?.[1];
  return {
    query,
    count: count ? Number(count) : 0,
  };
}

function formatFetchError(error) {
  if (!(error instanceof Error)) return "Unexpected server error.";

  const parts = [error.message];
  if (error.cause instanceof Error) {
    parts.push(error.cause.message);
  }
  return parts.join(": ");
}

function httpsRequest(jar, urlString, options = {}) {
  const {
    method = "GET",
    headers = {},
    body,
    redirect = "follow",
  } = options;

  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const requestHeaders = {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      Connection: "keep-alive",
      Host: url.host,
      ...headers,
    };

    const cookieHeader = jar.header();
    if (cookieHeader) requestHeaders.Cookie = cookieHeader;

    const req = https.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method,
        headers: requestHeaders,
        family: 4,
        servername: url.hostname,
      },
      (res) => {
        jar.storeFromNodeResponse(res);

        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const responseBody = Buffer.concat(chunks).toString("utf8");
          const statusCode = res.statusCode ?? 500;
          const location = res.headers.location;

          if (
            redirect === "follow" &&
            location &&
            [301, 302, 303, 307, 308].includes(statusCode)
          ) {
            const nextUrl = new URL(location, url).toString();
            const nextMethod =
              statusCode === 303 || statusCode === 302 ? "GET" : method;
            resolve(
              httpsRequest(jar, nextUrl, {
                ...options,
                method: nextMethod,
                body: nextMethod === "GET" ? undefined : body,
              }),
            );
            return;
          }

          resolve({
            statusCode,
            body: responseBody,
            headers: res.headers,
          });
        });
      },
    );

    req.on("error", (error) => {
      reject(
        new Error(
          `Could not reach EagleWeb at ${url.hostname}. Check your internet connection and try opening the county site in Safari.`,
          { cause: error },
        ),
      );
    });

    req.setTimeout(30_000, () => {
      req.destroy(new Error("EagleWeb request timed out after 30 seconds."));
    });

    if (body) req.write(body);
    req.end();
  });
}

async function eagleFetch(jar, url, options = {}) {
  const method = options.method || "GET";
  const body =
    options.body instanceof URLSearchParams
      ? options.body.toString()
      : options.body;

  const headers = {
    ...(options.headers || {}),
  };

  if (method === "POST") {
    headers.Referer = headers.Referer || `${BASE}/taxweb/search.jsp`;
    headers.Origin = headers.Origin || "https://eagleweb.montrosecounty.net";
  }

  const { statusCode, body: responseBody } = await httpsRequest(jar, url, {
    method,
    headers,
    body,
    redirect: options.redirect || "follow",
  });

  if (statusCode >= 400) {
    throw new Error(`EagleWeb returned HTTP ${statusCode}.`);
  }

  return {
    response: { statusCode },
    body: responseBody,
  };
}

async function ensurePublicSession(jar) {
  await eagleFetch(jar, `${BASE}/web/`);
  await eagleFetch(jar, `${BASE}/web/loginPOST.jsp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: `${BASE}/web/`,
    },
    body: new URLSearchParams({
      guest: "true",
      submit: "Enter EagleWeb",
    }),
  });
}

async function checkEagleWebConnection() {
  const jar = new CookieJar();
  const started = Date.now();

  await ensurePublicSession(jar);
  const { body } = await eagleFetch(jar, `${BASE}/taxweb/search.jsp`);

  return {
    ok: body.includes("AccountNumID") || body.includes("Account Search"),
    elapsedMs: Date.now() - started,
  };
}

async function runSearch(jar, fields) {
  const payload = {
    ...emptySearchForm(),
    ...fields,
  };

  const { body } = await eagleFetch(jar, `${BASE}/taxweb/results.jsp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(payload),
  });

  if (body.includes("please login") || body.includes("session is no longer active")) {
    throw new Error("EagleWeb session expired. Try again.");
  }

  return {
    results: parseResults(body),
    meta: parseResultMessage(body),
    html: body,
  };
}

async function searchProperties(query) {
  const jar = new CookieJar();
  await ensurePublicSession(jar);

  const attempts = buildSearchAttempts(query);
  let lastMeta = null;

  for (const attempt of attempts) {
    const { results, meta } = await runSearch(jar, attempt.fields);
    lastMeta = meta;

    if (results.length > 0) {
      const mapped = results.map((result) => ({
        ...result,
        matchType: attempt.matchType,
      }));
      const levyPayload = await enrichResultsWithLevy(jar, mapped);

      return {
        ...levyPayload,
        message: meta.count
          ? `Found ${meta.count} result${meta.count === 1 ? "" : "s"} via ${attempt.matchType.toLowerCase()} search.`
          : `Matched via ${attempt.matchType.toLowerCase()} search.`,
        query: meta.query,
      };
    }
  }

  return {
    results: [],
    message: "No matching properties found.",
    query: lastMeta?.query,
    levy: {
      ...loadLevyConfig(),
      millLevy: resolveMillLevy(loadLevyConfig()),
      configured: resolveMillLevy(loadLevyConfig()) != null,
    },
  };
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function serveStatic(req, res) {
  const requestPath = req.url === "/" ? "/index.html" : req.url;
  const filePath = path.join(__dirname, "public", requestPath);

  if (!filePath.startsWith(path.join(__dirname, "public"))) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const ext = path.extname(filePath);
  const type =
    ext === ".html"
      ? "text/html; charset=utf-8"
      : ext === ".css"
        ? "text/css; charset=utf-8"
        : ext === ".js"
          ? "text/javascript; charset=utf-8"
          : "application/octet-stream";

  res.writeHead(200, { "Content-Type": type });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/version") {
      const config = loadLevyConfig();
      const millLevy = resolveMillLevy(config);
      sendJson(res, 200, {
        version: APP_VERSION,
        millLevy,
        levyConfigured: millLevy != null,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/health") {
      const payload = await checkEagleWebConnection();
      sendJson(res, payload.ok ? 200 : 502, payload);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/levy") {
      const config = loadLevyConfig();
      const millLevy = resolveMillLevy(config);
      sendJson(res, 200, {
        ...config,
        millLevy,
        configured: millLevy != null,
        formula: "annualIncrease = nonSchoolAssessedValue × millLevy ÷ 1000",
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/search") {
      const query = url.searchParams.get("q")?.trim();
      if (!query) {
        sendJson(res, 400, { error: "Missing search query." });
        return;
      }

      const payload = await searchProperties(query);
      sendJson(res, 200, payload);
      return;
    }

    if (req.method === "GET") {
      serveStatic(req, res);
      return;
    }

    sendJson(res, 405, { error: "Method not allowed." });
  } catch (error) {
    sendJson(res, 500, { error: formatFetchError(error) });
  }
});

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const millLevy = resolveMillLevy(loadLevyConfig());
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Montrose property search running at http://localhost:${PORT}`);
    console.log(`Version: ${APP_VERSION}`);
    console.log(
      millLevy != null
        ? `Mill levy loaded: ${millLevy} mills`
        : "Mill levy not configured (edit levy.config.json)",
    );
  });
}

export {
  parseResults,
  parseAssessmentTable,
  buildSearchAttempts,
  normalizeAccount,
  searchProperties,
  checkEagleWebConnection,
  deriveMillLevy,
  estimateAnnualIncrease,
  resolveMillLevy,
};

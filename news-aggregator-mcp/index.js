#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import Parser from "rss-parser";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCES_PATH = path.join(__dirname, "sources.json");
const CACHE_DIR = path.join(__dirname, "cache");
const FRESHNESS_MS = 24 * 60 * 60 * 1000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(fn, retries = 2, delayMs = 2000) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries) throw err;
      await sleep(delayMs);
    }
  }
}

// Fetch one source, return articles sorted newest-first
async function fetchSource(parser, source) {
  try {
    const feed = await fetchWithRetry(() => parser.parseURL(source.url), 2, 2000);
    const cutoff = Date.now() - FRESHNESS_MS;
    const all = (feed.items || [])
      .filter((item) => item.title && item.link)
      .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate))
      .map((item) => ({
        title: item.title.trim(),
        link: item.link,
        pubDate: item.pubDate,
        fresh: new Date(item.pubDate).getTime() > cutoff,
        summary: (item.contentSnippet || item.summary || "").slice(0, 250).trim(),
        source: source.name,
      }));
    return all;
  } catch (err) {
    console.error(`[${source.name}] failed: ${err.message}`);
    return [];
  }
}

// For each category, fetch all its sources and return the single best article
async function fetchByCategory() {
  const parser = new Parser({
    timeout: 10000,
    headers: { "User-Agent": "Mozilla/5.0 (compatible; NewsDigestBot/1.0)" },
  });
  const { categories } = JSON.parse(await fs.readFile(SOURCES_PATH, "utf8"));

  const results = await Promise.all(
    categories.map(async (cat) => {
      const batches = await Promise.all(
        cat.sources.map((src) => fetchSource(parser, src))
      );
      const all = batches.flat().sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
      // Prefer fresh articles; fall back to most recent if none are within 24h
      const best = all.find((a) => a.fresh) || all[0] || null;

      return {
        category: cat.id,
        label: cat.label,
        emoji: cat.emoji,
        article: best,
        total_fetched: all.length,
      };
    })
  );

  return results;
}

const server = new Server(
  { name: "news-aggregator-mcp", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "fetch_news",
      description:
        "Fetch today's top news, one article per category. Returns 10 categories: 中国, 香港, 德国, 美国, 非洲, 东南亚, 日本, 科技, 金融, 文化. Each entry has: category, label, emoji, article (title/link/pubDate/summary/source), total_fetched.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;
  try {
    if (name === "fetch_news") {
      const data = await fetchByCategory();
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
    throw new Error(`Unknown tool: ${name}`);
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

async function main() {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("News Aggregator MCP Server v2 running...");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * 每日新闻日报 — 独立脚本，无需 Claude Code 运行
 * 用法: node daily-digest.mjs
 */
import { createRequire } from "module";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const Parser = require(path.join(__dirname, "news-aggregator-mcp/node_modules/rss-parser/index.js"));
const TelegramBot = require(path.join(__dirname, "telegram-push-mcp/node_modules/node-telegram-bot-api/src/telegram.js"));

const SOURCES_PATH = path.join(__dirname, "news-aggregator-mcp/sources.json");
const LOG_PATH = path.join(__dirname, "digest.log");
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("需要设置 TELEGRAM_BOT_TOKEN 和 TELEGRAM_CHAT_ID 环境变量");
  process.exit(1);
}
const FRESHNESS_MS = 24 * 60 * 60 * 1000;
const GERMAN_SOURCES = new Set(["Die Zeit", "Süddeutsche Zeitung"]);

async function translateFromGerman(title, summary) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { title, summary };
  try {
    const client = new Anthropic({ apiKey });
    const input = `Title: ${title}\nSummary: ${summary || ""}`;
    const res = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      messages: [{
        role: "user",
        content: `Translate this German news title and summary to English. Reply with exactly two lines:\nTitle: <translated title>\nSummary: <translated summary>\n\n${input}`,
      }],
    });
    const text = res.content[0].text;
    const t = text.match(/Title:\s*(.+)/)?.[1]?.trim() || title;
    const s = text.match(/Summary:\s*(.+)/)?.[1]?.trim() || summary;
    return { title: t, summary: s };
  } catch (e) {
    log(`⚠️  翻译失败: ${e.message}`);
    return { title, summary };
  }
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFile(LOG_PATH, line + "\n").catch(() => {});
}

async function fetchSource(parser, source) {
  try {
    const feed = await parser.parseURL(source.url);
    return (feed.items || [])
      .filter((i) => i.title && i.link)
      .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate))
      .map((i) => ({
        title: i.title.trim(),
        link: i.link,
        pubDate: i.pubDate,
        fresh: new Date(i.pubDate).getTime() > Date.now() - FRESHNESS_MS,
        summary: (i.contentSnippet || "").slice(0, 200).trim(),
        source: source.name,
      }));
  } catch (e) {
    log(`⚠️  ${source.name}: ${e.message}`);
    return [];
  }
}

async function main() {
  log("=== 开始生成日报 ===");

  const parser = new Parser({
    timeout: 10000,
    headers: { "User-Agent": "Mozilla/5.0 (compatible; NewsDigestBot/1.0)" },
  });
  const { categories } = JSON.parse(await fs.readFile(SOURCES_PATH, "utf8"));

  // 按分类抓取，每类取最新1条
  const results = await Promise.all(
    categories.map(async (cat) => {
      const batches = await Promise.all(cat.sources.map((s) => fetchSource(parser, s)));
      const allRaw = batches.flat().sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
      // 排除黑名单关键词（不区分大小写）
      const excludeRe = cat.exclude_keywords?.length
        ? new RegExp(cat.exclude_keywords.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i")
        : null;
      const all = excludeRe ? allRaw.filter(a => !excludeRe.test(a.title + " " + a.summary)) : allRaw;
      let best = all.find((a) => a.fresh) || all[0] || null;
      // 德文来源自动翻译
      if (best && GERMAN_SOURCES.has(best.source)) {
        const translated = await translateFromGerman(best.title, best.summary);
        best = { ...best, ...translated };
        log(`🔤 已翻译: "${best.title.slice(0, 50)}"`);
      }
      log(`${cat.emoji} ${cat.label}: ${best ? `"${best.title.slice(0, 50)}" [${best.source}]` : "无文章"}`);
      return { ...cat, article: best };
    })
  );

  // 生成日报
  const now = new Date();
  const dateStr = now.toLocaleDateString("zh-CN", {
    year: "numeric", month: "long", day: "numeric", weekday: "long",
    timeZone: "Europe/Berlin",
  });
  const timeStr = now.toLocaleTimeString("zh-CN", {
    hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin",
  });

  let msg = `📰 *每日新闻日报*\n_${dateStr} · 柏林${timeStr}_\n${"─".repeat(28)}\n\n`;
  for (const cat of results) {
    if (!cat.article) {
      msg += `${cat.emoji} _（今日暂无）_\n\n`;
      continue;
    }
    const { title, link, source, summary } = cat.article;
    const s = summary
      ? summary.replace(/([_*[\]()~>#+=|{}.!])/g, "\\$1").slice(0, 120)
      : "";
    msg += `${cat.emoji} [${title}](${link})\n_${source}_${s ? " · " + s + (s.length === 120 ? "…" : "") : ""}\n\n`;
  }
  msg += `${"─".repeat(28)}\n_共10条_`;

  // 发送 Telegram
  log(`发送Telegram（${msg.length}字）...`);
  const bot = new TelegramBot(BOT_TOKEN, { polling: false });
  await bot.sendMessage(CHAT_ID, msg, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  });
  log("✅ 发送成功");
}

main().catch((e) => {
  log(`❌ 失败: ${e.message}`);
  process.exit(1);
});

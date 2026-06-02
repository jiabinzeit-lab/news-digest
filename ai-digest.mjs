#!/usr/bin/env node
/**
 * AI & 半导体深度分析日报
 * 来源：SemiAnalysis、The Next Platform、Stratechery
 * 每次推送2篇未推过的文章，附中文详细总结
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

const SENT_PATH = path.join(__dirname, "ai-digest-sent.json");
const LOG_PATH  = path.join(__dirname, "ai-digest.log");
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("需要设置 TELEGRAM_BOT_TOKEN 和 TELEGRAM_CHAT_ID");
  process.exit(1);
}

const SOURCES = [
  { name: "SemiAnalysis",      url: "https://newsletter.semianalysis.com/feed" },
  { name: "The Next Platform", url: "https://www.nextplatform.com/feed/" },
  { name: "Stratechery",       url: "https://stratechery.com/feed/" },
];

// 关键词过滤：只取 AI / 半导体相关文章
const KEYWORDS_RE = /\b(AI|artificial intelligence|semiconductor|chip|GPU|CPU|NPU|TSMC|Nvidia|Intel|AMD|Qualcomm|Samsung|SK Hynix|HBM|DRAM|memory|data center|inference|training|LLM|large language model|foundation model|compute|foundry|wafer|fab|lithography|EUV|packaging|CoWoS|SoC|architecture|transformer|reasoning model|agentic|hyperscaler|cloud compute|Blackwell|Hopper|Gaudi|TPU|Apple Silicon)\b/i;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFile(LOG_PATH, line + "\n").catch(() => {});
}

async function loadSent() {
  try {
    return JSON.parse(await fs.readFile(SENT_PATH, "utf8"));
  } catch {
    return [];
  }
}

async function saveSent(urls) {
  // 只保留最近100条，防止文件无限增长
  const trimmed = urls.slice(-100);
  await fs.writeFile(SENT_PATH, JSON.stringify(trimmed, null, 2));
}

async function fetchArticleText(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; NewsDigestBot/1.0)" },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/\s+/g, " ").trim();
    return text.slice(0, 12000);
  } catch {
    return null;
  }
}

async function summarize(article, client) {
  const rawContent = article.fullText || article.summary || "";
  const context = rawContent.slice(0, 10000);
  const hasFullText = rawContent.length > 1500;

  const prompt = hasFullText
    ? `你是一位专业的科技与半导体行业翻译和分析师。请将以下英文文章完整翻译成中文，保留所有技术细节、数据和论述逻辑。翻译要流畅自然，专业术语保持准确。

来源：${article.source}
标题：${article.title}

原文：
${context}

要求：
1. 完整翻译全文，不要省略任何段落或数据
2. 专业术语（如 CoWoS、HBM、TSMC N2 等）保留英文原词并附中文说明
3. 直接输出译文正文，不加"翻译："等前缀`
    : `你是一位专业的科技与半导体行业分析师。以下是一篇文章的标题和摘要（原文可能需要付费订阅），请根据现有信息写一篇深度中文分析（600-800字）。

来源：${article.source}
标题：${article.title}
摘要：${context}

要求：
1. 结合摘要内容和你对该领域的专业知识，深入分析文章论点
2. 补充相关背景信息、行业数据和趋势
3. 指出技术或商业上的深层意义及对行业的影响
4. 语言专业流畅，适合中文科技读者
5. 直接输出分析正文，不加前缀`;

  const res = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 3000,
    messages: [{ role: "user", content: prompt }],
  });
  return res.content[0].text.trim();
}

function escapeMarkdown(text) {
  // 普通 Markdown 模式只需转义这几个字符
  return text.replace(/([_*`[\]])/g, "\\$1");
}

async function main() {
  log("=== AI日报开始 ===");

  const sentUrls = await loadSent();
  const sentSet  = new Set(sentUrls);

  const parser = new Parser({
    timeout: 12000,
    headers: { "User-Agent": "Mozilla/5.0 (compatible; NewsDigestBot/1.0)" },
    customFields: { item: ["content:encoded"] },
  });

  // 抓取所有文章
  const allItems = [];
  for (const src of SOURCES) {
    try {
      const feed = await parser.parseURL(src.url);
      const items = (feed.items || [])
        .filter(i => i.title && i.link)
        .filter(i => KEYWORDS_RE.test(i.title + " " + (i.contentSnippet || "")))
        .map(i => ({
          source:  src.name,
          title:   i.title.trim(),
          link:    i.link,
          pubDate: i.pubDate,
          summary: (i.contentSnippet || i["content:encoded"] || "").replace(/<[^>]+>/g, " ").slice(0, 2000).trim(),
        }));
      log(`${src.name}: ${items.length} 篇相关文章`);
      allItems.push(...items);
    } catch (e) {
      log(`⚠️  ${src.name} 抓取失败: ${e.message}`);
    }
  }

  if (allItems.length === 0) {
    log("❌ 无可用文章，退出");
    process.exit(0);
  }

  // 排序：最新优先
  allItems.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

  // 过滤已推送
  let candidates = allItems.filter(i => !sentSet.has(i.link));
  log(`未推送文章: ${candidates.length}/${allItems.length}`);

  // 如果不足2篇，扩大范围（允许复用30天前的文章）
  if (candidates.length < 2) {
    log("未推送文章不足2篇，重置已发送列表重新筛选");
    candidates = allItems;
  }

  const picks = candidates.slice(0, 2);
  if (picks.length === 0) {
    log("无文章可推送");
    process.exit(0);
  }

  // 尝试抓取全文
  const client = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;
  if (!client) {
    log("⚠️  无 ANTHROPIC_API_KEY，跳过总结");
    process.exit(1);
  }

  for (const p of picks) {
    log(`🔍 抓取全文: ${p.title.slice(0, 50)}`);
    p.fullText = await fetchArticleText(p.link);
    if (p.fullText) log(`   全文 ${p.fullText.length} 字符`);
    else log(`   全文抓取失败，使用RSS摘要`);
  }

  // 生成中文总结
  for (const p of picks) {
    log(`✍️  生成总结: ${p.title.slice(0, 50)}`);
    p.chineseSummary = await summarize(p, client);
  }

  // 格式化 Telegram 消息（MarkdownV2）
  const now = new Date();
  const dateStr = now.toLocaleDateString("zh-CN", {
    year: "numeric", month: "long", day: "numeric",
    timeZone: "Europe/Berlin",
  });

  let msg = `🤖 *AI & 芯片深度*\n_${dateStr}_\n${"─".repeat(28)}\n\n`;

  for (let i = 0; i < picks.length; i++) {
    const { title, link, source, chineseSummary } = picks[i];
    msg += `*${i + 1}. [${escapeMarkdown(title)}](${link})*\n`;
    msg += `_${source}_\n\n`;
    msg += `${chineseSummary}\n\n`;
    if (i < picks.length - 1) msg += `${"─".repeat(28)}\n\n`;
  }

  // 发送
  log(`发送 Telegram（${msg.length} 字）...`);
  const bot = new TelegramBot(BOT_TOKEN, { polling: false });

  // 长消息分割（4096字符限制）
  const chunks = [];
  let remaining = msg;
  while (remaining.length > 4096) {
    let at = remaining.lastIndexOf("\n\n", 4096);
    if (at <= 0) at = 4096;
    chunks.push(remaining.slice(0, at).trim());
    remaining = remaining.slice(at).trim();
  }
  chunks.push(remaining);

  for (const chunk of chunks.filter(Boolean)) {
    await bot.sendMessage(CHAT_ID, chunk, {
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    });
  }
  log("✅ 发送成功");

  // 更新已发送列表
  const newSent = [...sentUrls, ...picks.map(p => p.link)];
  await saveSent(newSent);
  log(`已记录 ${picks.length} 篇，总记录 ${newSent.slice(-100).length} 篇`);
}

main().catch(e => {
  log(`❌ 失败: ${e.message}`);
  process.exit(1);
});

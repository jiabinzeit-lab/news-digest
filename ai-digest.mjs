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

function translatePrompt(article, context) {
  return `你是一位专业的科技与半导体行业翻译和分析师。请将以下英文文章完整翻译成中文，保留所有技术细节、数据和论述逻辑。翻译要流畅自然，专业术语保持准确。

来源：${article.source}
标题：${article.title}

原文：
${context}

要求：
1. 完整翻译全文，不要省略任何段落或数据
2. 专业术语（如 CoWoS、HBM、TSMC N2 等）保留英文原词并附中文说明
3. 直接输出译文正文，不加"翻译："等前缀`;
}

function summaryPrompt(article, context) {
  return `你是一位专业的科技与半导体行业分析师。以下是一篇文章的标题和内容（可能为摘要），请写一篇深度中文分析（600-800字）。

来源：${article.source}
标题：${article.title}
内容：${context}

要求：
1. 结合内容和你对该领域的专业知识，深入分析文章论点
2. 补充相关背景信息、行业数据和趋势
3. 指出技术或商业上的深层意义及对行业的影响
4. 语言专业流畅，适合中文科技读者
5. 直接输出分析正文，不加前缀`;
}

// 单次流式生成（带 2 次重试）。流式保持连接活跃，缓解中间层提前关闭连接
// 导致的 "Premature close"。
async function generate(client, model, prompt, maxTokens) {
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const stream = client.messages.stream({
        model,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      });
      const final = await stream.finalMessage();
      const text = final.content[0].text.trim();
      if (text) return text;
      throw new Error("空回复");
    } catch (e) {
      lastErr = e;
      const cause = e.cause?.message || e.cause?.code || "";
      log(`   ⚠️  ${model} 第 ${attempt}/2 次失败: ${e.message}${cause ? ` (${cause})` : ""}`);
      if (attempt < 2) await new Promise(r => setTimeout(r, 3000));
    }
  }
  throw lastErr;
}

async function summarize(article, client) {
  const rawContent = article.fullText || article.summary || "";
  const context = rawContent.slice(0, 10000);
  const hasFullText = rawContent.length > 1500;

  // 有全文：先用 Sonnet 全文翻译；若长生成被掐断（Premature close），
  // 降级到更快的 Haiku 出一篇深度摘要，保证推送不被单篇文章卡死。
  if (hasFullText) {
    try {
      return await generate(client, "claude-sonnet-4-5", translatePrompt(article, context), 3000);
    } catch (e) {
      log(`   ↪️  Sonnet 全文翻译失败，降级 Haiku 摘要`);
      return await generate(client, "claude-haiku-4-5-20251001", summaryPrompt(article, context.slice(0, 4000)), 1500);
    }
  }

  // 仅摘要：直接用 Haiku 出深度分析（短生成，稳定）
  return await generate(client, "claude-haiku-4-5-20251001", summaryPrompt(article, context), 1500);
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
  const client = process.env.ANTHROPIC_API_KEY
    ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 4, timeout: 180000 })
    : null;
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

  // 生成中文总结：单篇失败不影响其它文章，避免一篇卡死整个推送
  for (const p of picks) {
    log(`✍️  生成总结: ${p.title.slice(0, 50)}`);
    try {
      p.chineseSummary = await summarize(p, client);
    } catch (e) {
      log(`   ❌ 该篇生成彻底失败，跳过: ${e.message}`);
      p.chineseSummary = null;
    }
  }

  // 只保留成功生成的文章
  const ready = picks.filter(p => p.chineseSummary);
  if (ready.length === 0) {
    // 全部失败也要把这些文章记为已发送，否则明天还会卡在同样的文章上
    log("❌ 所有文章生成失败，标记为已发送以避免卡死后退出");
    await saveSent([...sentUrls, ...picks.map(p => p.link)]);
    process.exit(1);
  }

  // 格式化 Telegram 消息（MarkdownV2）
  const now = new Date();
  const dateStr = now.toLocaleDateString("zh-CN", {
    year: "numeric", month: "long", day: "numeric",
    timeZone: "Europe/Berlin",
  });

  let msg = `🤖 *AI & 芯片深度*\n_${dateStr}_\n${"─".repeat(28)}\n\n`;

  for (let i = 0; i < ready.length; i++) {
    const { title, link, source, chineseSummary } = ready[i];
    msg += `*${i + 1}. [${escapeMarkdown(title)}](${link})*\n`;
    msg += `_${source}_\n\n`;
    msg += `${chineseSummary}\n\n`;
    if (i < ready.length - 1) msg += `${"─".repeat(28)}\n\n`;
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

  // 更新已发送列表：所有处理过的文章都记为已发送（含生成失败的），
  // 防止某篇一直失败把流水线永久卡死
  const newSent = [...sentUrls, ...picks.map(p => p.link)];
  await saveSent(newSent);
  log(`已发送 ${ready.length} 篇 / 处理 ${picks.length} 篇，总记录 ${newSent.slice(-100).length} 篇`);
}

main().catch(e => {
  log(`❌ 失败: ${e.message}`);
  process.exit(1);
});

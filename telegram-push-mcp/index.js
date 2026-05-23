#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import TelegramBot from "node-telegram-bot-api";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MAX_LENGTH = 4096;

if (!TELEGRAM_BOT_TOKEN) {
  console.error("Error: TELEGRAM_BOT_TOKEN is required");
  process.exit(1);
}
if (!TELEGRAM_CHAT_ID) {
  console.error("Error: TELEGRAM_CHAT_ID is required");
  process.exit(1);
}

// polling: false — send-only, no background polling loop
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

function splitMessage(text) {
  if (text.length <= MAX_LENGTH) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }
    let at = remaining.lastIndexOf("\n\n", MAX_LENGTH);
    if (at <= 0) at = remaining.lastIndexOf("\n", MAX_LENGTH);
    if (at <= 0) at = MAX_LENGTH; // hard split for lines longer than MAX_LENGTH
    chunks.push(remaining.slice(0, at).trim());
    remaining = remaining.slice(at).trim();
  }
  return chunks.filter(Boolean);
}

async function sendMessage(text) {
  const chunks = splitMessage(text);
  const messageIds = [];
  for (const chunk of chunks) {
    const result = await bot.sendMessage(TELEGRAM_CHAT_ID, chunk, {
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    });
    messageIds.push(result.message_id);
    if (chunks.length > 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return { success: true, message_ids: messageIds, chunks_sent: chunks.length };
}

const server = new Server(
  { name: "telegram-push-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "send_message",
      description:
        "Send a message to the configured Telegram chat. Automatically splits messages exceeding 4096 characters. Supports Markdown formatting.",
      inputSchema: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "Message text to send. Markdown is supported.",
          },
        },
        required: ["text"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    if (name === "send_message") {
      const result = await sendMessage(args.text);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
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
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Telegram Push MCP Server running (send-only, no polling)...");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

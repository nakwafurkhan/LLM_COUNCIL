import "dotenv/config";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import { config } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

if (!process.env.MESHAPI_KEY) {
  console.error("Missing MESHAPI_KEY. Add it to your .env file — see .env.example.");
  process.exit(1);
}

const client = new OpenAI({
  apiKey: process.env.MESHAPI_KEY,
  baseURL: "https://api.meshapi.ai/v1",
});

const MIME_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
};

const server = http.createServer(async (req, res) => {
  // --- API route: POST /api/chat ---
  if (req.url === "/api/chat" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { messages } = JSON.parse(body);

        const response = await client.chat.completions.create({
          model: "openai/gpt-4o",
          messages,
        });

        const reply = response.choices[0].message.content;

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ reply }));
      } catch (err) {
        console.error("API error:", err.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Something went wrong talking to the model." }));
      }
    });
    return;
  }

  // --- Static file serving ---
  let filePath = req.url === "/" ? "/index.html" : req.url;
  filePath = path.join(__dirname, "public", filePath);
  const ext = path.extname(filePath);

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("404 Not Found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(content);
  });
});

server.listen(PORT, () => {
  console.log(`Chatbot running at http://localhost:${PORT}`);
});
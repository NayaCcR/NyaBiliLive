import fs from "node:fs";
import path from "node:path";

const normalizeComparable = (value) => String(value || "")
  .normalize("NFKC")
  .toLowerCase()
  .replace(/[\s，。！？、,.!?：:；;~～—–_·…“”‘’'"()（）【】\[\]]+/g, "");

const bigrams = (value) => {
  if (value.length < 2) return [value];
  return Array.from({ length: value.length - 1 }, (_, index) => value.slice(index, index + 2));
};

function similarity(left, right) {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const leftPairs = bigrams(left);
  const rightPairs = bigrams(right);
  const remaining = [...rightPairs];
  let matches = 0;
  for (const pair of leftPairs) {
    const index = remaining.indexOf(pair);
    if (index >= 0) {
      matches += 1;
      remaining.splice(index, 1);
    }
  }
  return (2 * matches) / (leftPairs.length + rightPairs.length);
}

function cleanOcrLine(value) {
  return String(value || "")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .trim()
    .replace(/^(?:榜\s*[123]|榜[一二三]|[①②③])\s*/u, "")
    .trim();
}

export function parseOcrSupplementText(text) {
  const items = [];
  const ignoredLines = [];
  for (const sourceLine of String(text || "").split(/\r?\n/)) {
    const line = cleanOcrLine(sourceLine);
    if (!line) continue;
    if (/^(?:系统提示|可点击其他人的滚动弹幕|您\s*(?:和|刚刚|已))/u.test(line)) {
      ignoredLines.push(sourceLine);
      continue;
    }
    const separator = line.search(/[：:﹕]/u);
    if (separator <= 0) {
      ignoredLines.push(sourceLine);
      continue;
    }
    const username = line.slice(0, separator).trim().replace(/^[·•\-—]+|[·•\-—]+$/g, "").trim();
    const rawContent = line.slice(separator + 1).trim();
    if (!username || username.length > 100 || /^(?:系统|提示)$/u.test(username)) {
      ignoredLines.push(sourceLine);
      continue;
    }
    items.push({
      username,
      content: rawContent || "[图片/表情]",
      source_line: sourceLine,
    });
  }
  return { items, ignored_lines: ignoredLines };
}

function maskedNameScore(ocrName, xmlName) {
  const visible = normalizeComparable(String(xmlName || "").replace(/[＊*…]+/g, ""));
  if (!visible) return 0;
  const full = normalizeComparable(ocrName);
  if (!full) return 0;
  if (full === visible) return 0.2;
  if (full.startsWith(visible) || full.endsWith(visible)) return 0.14;
  return -0.08;
}

export function matchOcrWithXml(ocrItems, xmlEvents = []) {
  const candidates = xmlEvents.map((event, index) => ({
    index,
    username: String(event.username || "").trim(),
    content: String(event.content || "").trim(),
    occurred_at: event.occurred_at || null,
    offset_seconds: Number.isFinite(Number(event.offset_seconds)) ? Number(event.offset_seconds) : null,
    comparable: normalizeComparable(event.content),
  })).filter((event) => event.content && event.occurred_at);
  const used = new Set();
  let cursor = 0;
  return ocrItems.map((item) => {
    const comparable = normalizeComparable(item.content);
    let best = null;
    for (const candidate of candidates) {
      if (used.has(candidate.index)) continue;
      const contentScore = similarity(comparable, candidate.comparable);
      if (contentScore < 0.72) continue;
      const orderPenalty = candidate.index >= cursor ? Math.min((candidate.index - cursor) * 0.0001, 0.05) : 0.12;
      const score = contentScore + maskedNameScore(item.username, candidate.username) - orderPenalty;
      if (!best || score > best.score || (score === best.score && candidate.index < best.candidate.index)) {
        best = { candidate, score, contentScore };
      }
    }
    if (!best || best.contentScore < 0.72) {
      return { ...item, occurred_at: null, xml_username: "", xml_offset_seconds: null, source_kind: "ocr" };
    }
    used.add(best.candidate.index);
    cursor = Math.max(cursor, best.candidate.index + 1);
    return {
      ...item,
      occurred_at: best.candidate.occurred_at,
      xml_username: best.candidate.username,
      xml_offset_seconds: best.candidate.offset_seconds,
      source_kind: "ocr+xml",
    };
  });
}

export class OcrService {
  constructor({ recognizer = null, cachePath = path.resolve("data", "ocr-cache"), logger = console } = {}) {
    this.recognizer = recognizer;
    this.cachePath = path.resolve(cachePath);
    this.logger = logger;
    this.workerPromise = null;
    this.queue = Promise.resolve();
  }

  async worker() {
    if (!this.workerPromise) {
      fs.mkdirSync(this.cachePath, { recursive: true });
      this.workerPromise = import("tesseract.js").then(({ createWorker }) => createWorker("chi_sim+eng", undefined, {
        cachePath: this.cachePath,
        logger: (progress) => {
          if (progress.status === "recognizing text") this.logger.info?.(`[ocr] ${Math.round(Number(progress.progress || 0) * 100)}%`);
        },
      })).catch((error) => {
        this.workerPromise = null;
        throw error;
      });
    }
    return this.workerPromise;
  }

  recognize(image, mimeType = "image/png") {
    const task = this.queue.then(async () => {
      if (this.recognizer) return String(await this.recognizer(image, mimeType) || "").trim();
      const worker = await this.worker();
      const result = await worker.recognize(image);
      return String(result.data?.text || "").trim();
    });
    this.queue = task.catch(() => {});
    return task;
  }

  async close() {
    if (!this.workerPromise) return;
    const worker = await this.workerPromise.catch(() => null);
    this.workerPromise = null;
    if (worker) await worker.terminate();
  }
}

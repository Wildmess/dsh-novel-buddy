/**
 * fanqie.js — fanqienovel.com（番茄小说网页版）抓取与字体反爬解码。
 *
 * 零依赖纯函数模块，供 lib/index.js 的工具调用，也可以单独 node 测试。
 *
 * 反爬原理（2026-10-27 实测有效）：
 *   正文常用字被替换成 PUA 私有区码点（U+E000–U+F8FF），再由自定义字体
 *   （awesome-font/*.woff2）渲染回正常字形。DOM / SSR HTML 里拿到的是码点。
 *   解码：mode 0 区间 [58344, 58715]，bias = 码点 - 58344 → charset[0][bias]。
 *   码表来自社区项目 ying-ck/fanqienovel-downloader 的 src/charset.json，
 *   收录在 assets/charset.json；'?' / '' 表示未映射（保留为 □ 并计入统计）。
 *
 * 抓取端点（都是服务端渲染，普通 HTTP GET 即可，无需浏览器）：
 *   GET /page/{bookId}     书页：章节目录（a[href=/reader/{itemId}]）+ 书籍元信息
 *   GET /reader/{itemId}   章节页：__INITIAL_STATE__.reader.chapterData 含结构化正文
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const BASE = 'https://fanqienovel.com';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// mode 0 解码区间（0xE3E8 – 0xE55B），验证记录见工作区《小说陪读插件设计.md》
export const PUA_MIN = 58344;
export const PUA_MAX = 58715;

let charsetPromise = null;

/** 懒加载码表；失败时清空缓存以便下次重试。 */
function loadCharset() {
  charsetPromise ??= readFile(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'charset.json'),
    'utf8',
  )
    .then((raw) => JSON.parse(raw))
    .catch((error) => {
      charsetPromise = null;
      throw new Error(`码表 assets/charset.json 读取失败: ${error.message}`);
    });
  return charsetPromise;
}

/**
 * PUA 码点 → 汉字。返回 { text, puaTotal, unmapped }；
 * unmapped 越多说明码表越可能过期（coverage = 1 - unmapped/puaTotal）。
 */
export function decodeObfuscated(text, table) {
  let puaTotal = 0;
  let unmapped = 0;
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code < PUA_MIN || code > PUA_MAX) {
      out += ch;
      continue;
    }
    puaTotal += 1;
    const bias = code - PUA_MIN;
    const mapped = bias < table.length ? table[bias] : '?';
    if (!mapped || mapped === '?') {
      unmapped += 1;
      out += '□';
    } else {
      out += mapped;
    }
  }
  return { text: out, puaTotal, unmapped };
}

async function fetchText(url, retries = 1) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (error) {
      if (attempt >= retries) {
        throw new Error(`抓取失败 ${url}: ${error.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
  }
}

/** 从 URL 或纯数字里解析书 ID / 章节 ID。 */
export function parseBookId(input) {
  const m = String(input ?? '').match(/(?:fanqienovel\.com\/page\/)?(\d{15,25})/);
  return m ? m[1] : null;
}

export function parseChapterId(input) {
  const m = String(input ?? '').match(/(?:fanqienovel\.com\/reader\/)?(\d{15,25})/);
  return m ? m[1] : null;
}

const ENTITIES = {
  '&quot;': '"',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&#x27;': "'",
  '&#39;': "'",
  '&nbsp;': ' ',
};

function unescapeEntities(text) {
  return text.replace(/&(quot|amp|lt|gt|#x27|#39|nbsp);/g, (m) => ENTITIES[m] ?? m);
}

function stripTags(html) {
  return unescapeEntities(html.replace(/<[^>]+>/g, ''));
}

/**
 * 从 SSR HTML 里按括号配平抠出一个内嵌 JSON 对象（`"key":{` 之后的部分）。
 * 比正则截取稳：不受嵌套结构影响。
 */
function extractEmbeddedObject(html, key) {
  const marker = `"${key}":{`;
  const start = html.indexOf(marker);
  if (start < 0) return null;
  let i = start + marker.length;
  let depth = 1;
  let inString = false;
  let escaped = false;
  while (i < html.length && depth > 0) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
    }
    i += 1;
  }
  if (depth !== 0) return null;
  try {
    return JSON.parse(html.slice(start + marker.length - 1, i));
  } catch {
    return null;
  }
}

/** 读 `"key":"value"` 形式的字符串字段，做完反转义；不存在返回 undefined。 */
function readStringField(html, key) {
  const m = html.match(new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`));
  if (!m) return undefined;
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return m[1];
  }
}

function readNumberField(html, key) {
  const m = html.match(new RegExp(`"${key}":(\\d+)`));
  return m ? Number(m[1]) : undefined;
}

/**
 * 抓书籍目录。返回：
 * { meta: { bookId, bookName, author, chapterTotal, wordNumber, abstract },
 *   chapters: [{ index, itemId, title }] }
 */
export async function fetchToc(bookId) {
  const html = await fetchText(`${BASE}/page/${bookId}`);
  const meta = {
    bookId,
    bookName: readStringField(html, 'bookName') ?? '',
    author: readStringField(html, 'authorName') ?? readStringField(html, 'author') ?? '',
    chapterTotal: readNumberField(html, 'chapterTotal'),
    wordNumber: readNumberField(html, 'wordNumber'),
    abstract: readStringField(html, 'abstract') ?? '',
  };
  if (!meta.bookName) {
    const t = html.match(/<title>([^<]+?)完整版在线免费阅读/);
    meta.bookName = t ? t[1].trim() : '未知书名';
  }

  // 目录锚点；书页里「最近更新」「开始阅读」也指向 /reader/，按文字排除 + 按 id 去重
  const seen = new Set();
  const chapters = [];
  for (const m of html.matchAll(/<a[^>]+href="\/reader\/(\d+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const itemId = m[1];
    const title = stripTags(m[2]).trim();
    if (!title || /^(最近更新|开始阅读)/.test(title)) continue;
    if (seen.has(itemId)) continue;
    seen.add(itemId);
    chapters.push({ index: chapters.length + 1, itemId, title });
  }
  return { meta, chapters };
}

/**
 * 抓单章正文并解码。返回：
 * { ok: true, bookId, itemId, title, order, wordNumber, preItemId, nextItemId,
 *   locked, text, stats: { chars, puaTotal, unmapped, coverage } }
 * locked=true 时表示章节被锁（VIP/未上架），没有 text。
 */
export async function fetchChapter(chapterId) {
  const html = await fetchText(`${BASE}/reader/${chapterId}`);
  const data = extractEmbeddedObject(html, 'chapterData');
  if (!data || !data.content) {
    throw new Error('没解析到正文（chapterData），番茄可能改版了');
  }
  const table = (await loadCharset())[0];
  const { text: decoded, puaTotal, unmapped } = decodeObfuscated(data.content, table);

  // content 是 HTML：去掉章节头图，<p> 转空行，再去掉其余标签
  const text = decoded
    .replace(/<img[^>]*>/g, '')
    .replace(/<\/p>/g, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const chars = text.replace(/\s/g, '').length;
  return {
    ok: true,
    bookId: data.bookId,
    itemId: data.itemId ?? String(chapterId),
    title: data.title ?? '',
    order: Number(data.realChapterOrder ?? data.order ?? 0),
    wordNumber: Number(data.chapterWordNumber ?? 0),
    preItemId: data.preItemId ?? null,
    nextItemId: data.nextItemId ?? null,
    locked: Boolean(data.isChapterLock) || chars < 50,
    text,
    stats: {
      chars,
      puaTotal,
      unmapped,
      coverage: puaTotal > 0 ? 1 - unmapped / puaTotal : 1,
    },
  };
}

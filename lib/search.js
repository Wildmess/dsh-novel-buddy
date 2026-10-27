/**
 * search.js — 发现数据源。
 *
 * 1) searchBooks：番茄站内搜索 API（/api/author/search/search_book/v1）。
 *    实测（2026-10-27）：该接口校验浏览器安全 SDK 写入的 Cookie（x-web-secsdk-uid 等），
 *    纯匿名请求返回空；带真实登录会话的完整 Cookie 则可用、且不需要 msToken/a_bogus 签名。
 *    → 所以搜索依赖已导入的登录凭据（scripts/credential.js set）。
 *
 * 2) homepageCandidates：首页推荐榜（主编力荐/本周推荐/最近更新，SSR，匿名可用）。
 *    作为未配置凭据时的匿名探索数据源（配合关键词过滤）。
 */

import { BASE } from './fanqie.js';

const SEARCH_API = `${BASE}/api/author/search/search_book/v1`;

/**
 * 登录搜索。cookie 传完整 Cookie 串（来自用户导入的登录态）。
 * 返回 { ok, books: [{ bookId, bookName, author, abstract, category, tags }] }
 * 或 { ok: false, error }。
 */
export async function searchBooks(keyword, { cookie, page = 0, count = 10 } = {}) {
  const params = new URLSearchParams({
    filter: '127,127,127,127',
    page_count: String(count),
    page_index: String(page),
    query_type: '0',
    query_word: keyword,
  });
  const headers = {
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    accept: 'application/json',
    referer: `${BASE}/`,
  };
  if (cookie) headers.cookie = cookie;

  let res;
  try {
    res = await fetch(`${SEARCH_API}?${params}`, { headers });
  } catch (error) {
    return { ok: false, error: `请求失败: ${error.message}` };
  }
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  let json;
  try {
    json = await res.json();
  } catch {
    return { ok: false, error: '返回不是 JSON（可能 Cookie 已失效或被风控）' };
  }
  if (json.code !== 0 && json.status_code !== 0) {
    return { ok: false, error: `接口返回异常 code=${json.code ?? json.status_code}` };
  }
  const list = json?.data?.search_book_data_list ?? [];
  return {
    ok: true,
    books: list.map((b) => ({
      bookId: String(b.book_id ?? ''),
      bookName: b.book_name ?? '',
      author: b.author ?? '',
      abstract: b.abstract ?? '',
      category: b.category ?? '',
      tags: b.tags ?? '',
    })),
  };
}

/** 从 SSR 首页抓推荐榜候选（匿名）。 */
export async function homepageCandidates() {
  let html;
  try {
    const res = await fetch(`${BASE}/`, {
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    html = await res.text();
  } catch (error) {
    return { ok: false, error: `请求失败: ${error.message}` };
  }

  const state = extractEmbeddedObject(html, 'home');
  if (!state) return { ok: false, error: '首页数据解析失败（可能改版）' };
  const seen = new Set();
  const books = [];
  for (const listName of ['editorList', 'weekList', 'updateList']) {
    for (const b of state[listName] ?? []) {
      if (!b?.bookId || !b?.bookName) continue;
      if (seen.has(b.bookId)) continue;
      seen.add(b.bookId);
      books.push({
        bookId: String(b.bookId),
        bookName: b.bookName ?? '',
        author: b.author ?? '',
        abstract: b.abstract ?? '',
        category: b.category ?? '',
        tags: b.tags ?? '',
      });
    }
  }
  return { ok: true, books };
}

/** 从 HTML 里按括号配平抠内嵌 JSON 对象（与 fanqie.js 同款，独立复制避免耦合）。 */
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

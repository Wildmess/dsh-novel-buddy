/**
 * explore.js — 自主探索：收集候选书 + 电脑空闲检测。
 *
 * 职责边界（管道只做收集，判断交给鱼）：
 *   - gatherCandidates：按关键词从数据源（登录搜索 / 匿名首页榜）收集候选，
 *     过滤已知书目（档案/发现/追更里都有的不再推），按 name/abstract/category
 *     做关键词粗筛，截断到 maxBooks。
 *   - 剧情好不好看，是 followup 唤醒后鱼自己读第一章判断的事。
 *   - getIdleSeconds：GetLastInputInfo 查电脑空闲时长（"不使用电脑时才跑"）。
 */

import { execFile } from 'node:child_process';
import { homepageCandidates, searchBooks } from './search.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** 电脑空闲秒数；失败（非 Windows 等）返回 null 表示未知。 */
export function getIdleSeconds() {
  if (process.platform !== 'win32') return null;
  const script = [
    "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class IDLEQ { [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; } [DllImport(\"user32.dll\")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO p); }';",
    '$i = New-Object IDLEQ+LASTINPUTINFO;',
    '$i.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($i);',
    '[void][IDLEQ]::GetLastInputInfo([ref]$i);',
    '[Console]::Out.Write([string][Math]::Max(0, [Environment]::TickCount - [int]$i.dwTime) / 1000)',
  ].join(' ');
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 },
      (error, stdout) => {
        if (error) resolve(null);
        else {
          const n = Number(stdout.trim());
          resolve(Number.isFinite(n) ? n : null);
        }
      },
    );
  });
}

function matchesKeyword(book, keyword) {
  const k = keyword.toLowerCase();
  return (
    book.bookName?.toLowerCase().includes(k) ||
    book.abstract?.toLowerCase().includes(k) ||
    book.category?.toLowerCase().includes(k) ||
    book.tags?.toLowerCase().includes(k)
  );
}

/**
 * 收集候选。knownBookIds：档案/发现/追更里已出现过的书，不再推。
 * 返回 { ok, candidates: [{bookId, bookName, author, abstract, category}], source }
 */
export async function gatherCandidates({ keywords, knownBookIds, credential, maxBooks = 3 }) {
  const known = new Set(knownBookIds);
  const picked = [];
  const seen = new Set();
  let source = 'homepage';

  const consider = (books, keyword) => {
    for (const b of books) {
      if (picked.length >= maxBooks) return;
      if (!b.bookId || seen.has(b.bookId) || known.has(b.bookId)) continue;
      if (!matchesKeyword(b, keyword)) continue;
      seen.add(b.bookId);
      picked.push({
        bookId: b.bookId,
        bookName: b.bookName,
        author: b.author,
        abstract: String(b.abstract ?? '').slice(0, 120),
        category: b.category,
      });
    }
  };

  // 有凭据：登录搜索（接口校验真实浏览器 Cookie，匿名必空——已实测）
  if (credential?.cookie) {
    source = 'login-search';
    for (const keyword of keywords) {
      if (picked.length >= maxBooks) break;
      const r = await searchBooks(keyword, { cookie: credential.cookie, count: 10 });
      if (r.ok) consider(r.books, keyword);
    }
  }

  // 不够就用匿名首页榜补
  if (picked.length < maxBooks) {
    source = source === 'login-search' ? 'login-search+homepage' : 'homepage';
    const r = await homepageCandidates();
    if (r.ok) {
      for (const keyword of keywords) {
        if (picked.length >= maxBooks) break;
        consider(r.books, keyword);
      }
    }
  }

  return { ok: true, source, candidates: picked };
}

/** 组装给鱼的探索唤醒消息。 */
export function buildExploreMessage(result) {
  const lines = result.candidates.map(
    (b, i) =>
      `${i + 1}. 《${b.bookName}》${b.author || ''}（bookId: ${b.bookId}）[${b.category || '未分类'}] ${b.abstract || ''}`,
  );
  return (
    `[小说探索] 你按兴趣词自己逛了一圈，找到 ${result.candidates.length} 本候选（来源：${result.source}）：\n` +
    lines.join('\n') +
    '\n\n请逐本判断：调 fanqie_toc 拿第一章 itemId，再调 fanqie_chapter 读第一章，' +
    '凭剧情质量决定值不值得安利给主人。值得的调 novel_discovery_add 记录（reason 里引用第一章的具体情节说清为什么推荐），' +
    '平庸的直接放弃，不用记。全程不用问主人。'
  );
}

/**
 * dsh-novel-buddy — 小说陪读吐槽插件（DeepSeek Harness / Cordis）。
 *
 * 管道部分（本插件做的）：抓番茄小说目录和正文、破解字体反爬、读写剧情档案、
 * 可选的追更轮询。大脑部分（agent 做）：按 novel-buddy skill 整理剧情、吐槽、
 * 滚动压缩前情提要。
 *
 * 结构参照 dsh-whale-sense 的零依赖写法：
 *   - ctx.tools.register({ ... })   注册模型可见工具
 *   - ctx.agents.list()             找到主 agent，agent.followup() 主动开口
 *   - $DSH_HOME/storages/dsh-novel-buddy/   配置与剧情档案
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchToc, fetchChapter, parseBookId, parseChapterId } from './fanqie.js';
import { SKILL_NAME, SKILL_DESCRIPTION, SKILL_CONTENT } from './persona.js';

export const name = 'novel-buddy';
export const inject = ['tools'];

const PLUGIN_ID = 'dsh-novel-buddy';
const SOURCE = { kind: `plugin:${PLUGIN_ID}` };

const DEFAULT_CONFIG = {
  followCheck: {
    enabled: false, // 默认关：每条追更提醒都是一次模型调用，费 token
    intervalMinutes: 60,
    books: [], // { bookId, bookName, lastItemId }
  },
};

// ---------------------------------------------------------------- storage

function storageDir() {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(dshHome, 'storages', PLUGIN_ID);
}

function booksDir() {
  return path.join(storageDir(), 'books');
}

function ensureDirs() {
  fs.mkdirSync(booksDir(), { recursive: true });
}

function bookKey(input) {
  return String(input ?? '').trim().replace(/[^A-Za-z0-9_-]/g, '_') || 'default';
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function loadConfig() {
  return { ...DEFAULT_CONFIG, ...readJson(path.join(storageDir(), 'config.json'), {}) };
}

function saveConfig(config) {
  writeJson(path.join(storageDir(), 'config.json'), config);
}

function readArchive(key) {
  return readJson(path.join(booksDir(), `${key}.json`), null);
}

function writeArchive(key, archive) {
  writeJson(path.join(booksDir(), `${key}.json`), archive);
}

function emptyArchive(key, bookName) {
  return {
    bookKey: key,
    bookName: bookName ?? '',
    recap: '',
    lastReadItemId: '',
    lastReadOrder: 0,
    lastReadTitle: '',
    notes: '',
    updatedAt: null,
    chapters: {},
  };
}

// ---------------------------------------------------------------- followup

/** 参照 dsh-whale-sense：找主会话的 agent（跳过 subagent），拿不到就返回 null。 */
function resolveAgent(ctx) {
  try {
    const service = ctx.agents ?? (typeof ctx.get === 'function' ? ctx.get('agents') : undefined);
    const list = typeof service?.list === 'function' ? service.list() : [];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const agent = list[i];
      if (agent?.session?.header?.origin !== 'subagent') return agent;
    }
  } catch {
    /* 结构变了就算了 */
  }
  return null;
}

/** 追更轮询：每本书发现新章节就 followup 一条，只报名不剧透。 */
async function checkFollows(ctx) {
  const config = loadConfig();
  const fc = config.followCheck;
  if (!fc?.enabled || !Array.isArray(fc.books)) return;
  for (const book of fc.books) {
    try {
      const { chapters } = await fetchToc(book.bookId);
      const last = chapters[chapters.length - 1];
      if (!last || last.itemId === book.lastItemId) continue;
      book.lastItemId = last.itemId;
      book.lastChapterTitle = last.title;
      saveConfig(config);
      const agent = resolveAgent(ctx);
      if (typeof agent?.followup !== 'function') continue;
      agent.followup({
        id: crypto.randomUUID(),
        role: 'user',
        source: SOURCE,
        content: [
          {
            type: 'text',
            text: `[小说陪读] 《${book.bookName}》更新了：${last.title}（第 ${last.index} 章）。` +
              `想陪读的话：调 fanqie_chapter 抓 ${last.itemId}，按 novel-buddy 流程整理剧情、吐槽、更新档案。` +
              '不想现在读就不用回应这条。',
          },
        ],
      });
    } catch (error) {
      ctx.logger?.warn?.(`[novel-buddy] 追更检查失败 ${book.bookId}: ${error.message}`);
    }
  }
}

// ---------------------------------------------------------------- plugin

export function apply(ctx) {
  ensureDirs();
  const disposers = [];

  disposers.push(
    ctx.tools.register({
      name: 'fanqie_toc',
      description:
        '抓番茄小说书籍目录。参数 book 填书籍页 URL（fanqienovel.com/page/{bookId}）或纯数字 bookId。' +
        '返回书名/作者/总章数，以及 chapters 窗口（1 起始的 index、itemId、标题）；用 from/count 取片段，' +
        '看最新章节传 from = 总章数 - count + 1。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          book: { type: 'string', required: true, description: '书籍页 URL 或 bookId' },
          from: { type: 'number', description: '起始章 index（1 起始），默认 1' },
          count: { type: 'number', description: '返回条数，默认 30，最大 100' },
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true, required: ['ok'], properties: { ok: { type: 'boolean' } } },
        render: (_args, value) => [
          {
            type: 'text',
            text: value.ok
              ? `《${value.meta.bookName}》${value.meta.author || '佚名'} · 共 ${value.chapterTotal} 章 · ` +
                `${(value.meta.wordNumber / 10000).toFixed(1)} 万字\nbookId: ${value.meta.bookId}\n` +
                (value.meta.abstract ? `简介：${value.meta.abstract.slice(0, 120)}\n` : '') +
                `以下为第 ${value.returned.from}–${value.returned.to} 章（完整目录可用 from/count 分页）：\n` +
                value.chapters.map((c) => `${c.index}. ${c.title}（${c.itemId}）`).join('\n')
              : `抓取目录失败：${value.error}`,
          },
        ],
      },
      async execute(args) {
        try {
          const bookId = parseBookId(args.book);
          if (!bookId) return { ok: false, error: 'book 参数里解析不出 bookId' };
          const { meta, chapters } = await fetchToc(bookId);
          if (chapters.length === 0) return { ok: false, error: '目录为空，书可能已下架或改版' };
          const total = chapters.length;
          const from = Math.min(Math.max(1, Math.floor(args.from ?? 1)), total);
          const count = Math.min(Math.max(1, Math.floor(args.count ?? 30)), 100);
          return {
            ok: true,
            meta: { ...meta, chapterTotal: total },
            chapterTotal: total,
            returned: { from, to: Math.min(total, from + count - 1) },
            chapters: chapters.slice(from - 1, from - 1 + count),
          };
        } catch (error) {
          return { ok: false, error: error.message };
        }
      },
      presentCall() {
        return { card: 'generic', title: 'fanqie_toc', kind: 'search' };
      },
    }),
  );

  disposers.push(
    ctx.tools.register({
      name: 'fanqie_chapter',
      description:
        '抓番茄小说单章正文（已自动解码反爬字体，返回可读中文）。参数 chapter 填章节页 URL（fanqienovel.com/reader/{itemId}）' +
        '或纯数字 itemId（目录工具的返回里有）。返回含 preItemId/nextItemId（上一章/下一章）和 stats.coverage（解码覆盖率，' +
        '低于 0.95 提醒用户可能有乱码）。locked=true 表示章节被锁，拿不到正文。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          chapter: { type: 'string', required: true, description: '章节页 URL 或 itemId' },
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true, required: ['ok'], properties: { ok: { type: 'boolean' } } },
        render: (_args, value) => [
          {
            type: 'text',
            text: !value.ok
              ? `抓取正文失败：${value.error}`
              : value.locked
                ? `《第 ${value.order} 章 ${value.title}》被锁定（VIP/未上架），网页端拿不到正文，让用户去 App 看这章。`
                : `第 ${value.order} 章 ${value.title} ｜ 约 ${value.wordNumber} 字 ｜ 解码覆盖率 ${(value.stats.coverage * 100).toFixed(1)}%` +
                  (value.stats.unmapped > 0 ? `（${value.stats.unmapped} 字未解开，正文里是 □）` : '') +
                  `\n\n${value.text}`,
          },
        ],
      },
      async execute(args) {
        try {
          const itemId = parseChapterId(args.chapter);
          if (!itemId) return { ok: false, error: 'chapter 参数里解析不出 itemId' };
          return await fetchChapter(itemId);
        } catch (error) {
          return { ok: false, error: error.message };
        }
      },
      presentCall() {
        return { card: 'generic', title: 'fanqie_chapter', kind: 'read' };
      },
    }),
  );

  disposers.push(
    ctx.tools.register({
      name: 'novel_archive',
      description:
        '读一本书的剧情档案：前情提要 recap、阅读进度、每章的梗概与槽点。book 填 bookId（推荐，和番茄工具对齐）或自定义键名。' +
        'exists=false 表示还没开档（新书第一章读完后用 novel_archive_write 建档）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          book: { type: 'string', required: true, description: 'bookId 或自定义书键' },
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true, required: ['ok'], properties: { ok: { type: 'boolean' } } },
        render: (_args, value) => [
          {
            type: 'text',
            text: !value.exists
              ? `《${value.bookName || value.book}》还没有剧情档案，这是第一次陪读。`
              : `《${value.archive.bookName}》档案 · 更新于 ${value.archive.updatedAt}\n` +
                `进度：第 ${value.archive.lastReadOrder} 章 ${value.archive.lastReadTitle}\n` +
                `已记录 ${Object.keys(value.archive.chapters).length} 章\n前情提要：\n${value.archive.recap || '（空）'}`,
          },
        ],
      },
      async execute(args) {
        const key = bookKey(args.book);
        const archive = readArchive(key);
        return archive
          ? { ok: true, exists: true, book: key, archive }
          : { ok: true, exists: false, book: key, bookName: args.book, archive: null };
      },
      presentCall() {
        return { card: 'generic', title: 'novel_archive', kind: 'read' };
      },
    }),
  );

  disposers.push(
    ctx.tools.register({
      name: 'novel_archive_write',
      description:
        '写剧情档案（增量合并）。patch 常用字段：recap（滚动前情提要，≤800字）、bookName、lastReadItemId、lastReadOrder、' +
        'lastReadTitle、notes、chapters（按 itemId 合并，每章 { order, title, summary, roasts }）。' +
        '陪读每章必写：recap、进度、chapters 里这一章的记录。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          book: { type: 'string', required: true, description: 'bookId 或自定义书键' },
          patch: { type: 'object', required: true, description: '要合并的字段' },
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true, required: ['ok'], properties: { ok: { type: 'boolean' } } },
        render: (_args, value) => [
          {
            type: 'text',
            text: `已保存《${value.archive.bookName || value.book}》：第 ${value.archive.lastReadOrder || '?'} 章 ` +
              `${value.archive.lastReadTitle || ''}，前情提要 ${String(value.archive.recap || '').length} 字，` +
              `累计 ${Object.keys(value.archive.chapters).length} 章记录。`,
          },
        ],
      },
      async execute(args) {
        const key = bookKey(args.book);
        const patch = args.patch && typeof args.patch === 'object' ? args.patch : {};
        const archive = readArchive(key) ?? emptyArchive(key, patch.bookName);
        for (const [k, v] of Object.entries(patch)) {
          if (k === 'chapters' && v && typeof v === 'object') {
            archive.chapters = { ...archive.chapters, ...v };
          } else if (k !== 'bookKey' && k !== 'updatedAt') {
            archive[k] = v;
          }
        }
        archive.updatedAt = new Date().toISOString();
        writeArchive(key, archive);
        return { ok: true, book: key, archive };
      },
      presentCall() {
        return { card: 'generic', title: 'novel_archive_write', kind: 'write' };
      },
    }),
  );

  disposers.push(
    ctx.tools.register({
      name: 'novel_follow',
      description:
        '管理追更列表（实验性，默认轮询是关的）。action=list 查看；action=add 且 book=书页URL/ID 添加；action=remove 移除。' +
        '添加后要开轮询，用 action=set_interval 且 hours=数字，并把 enabled 开关交给 novel_follow_config 处理。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true, description: 'list / add / remove / set_enabled' },
          book: { type: 'string', description: 'add/remove 时：书页 URL 或 bookId' },
          title: { type: 'string', description: 'add 时可选：书名' },
          enabled: { type: 'boolean', description: 'set_enabled 时：是否开追更轮询' },
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true, required: ['ok'], properties: { ok: { type: 'boolean' } } },
        render: (_args, value) => [
          {
            type: 'text',
            text: value.message,
          },
        ],
      },
      async execute(args) {
        const config = loadConfig();
        const fc = { enabled: false, intervalMinutes: 60, books: [], ...config.followCheck };
        fc.books ??= [];
        const action = String(args.action ?? 'list');
        try {
          if (action === 'list') {
            const lines = fc.books.map((b) => `《${b.bookName || b.bookId}》 ${b.bookId} · 最近记录：${b.lastChapterTitle || '无'}`);
            return {
              ok: true,
              message: `追更轮询：${fc.enabled ? `开（每 ${fc.intervalMinutes} 分钟）` : '关'}\n` +
                (lines.length ? lines.join('\n') : '列表为空。'),
            };
          }
          if (action === 'add') {
            const bookId = parseBookId(args.book);
            if (!bookId) return { ok: false, message: 'book 参数解析不出 bookId' };
            if (!fc.books.some((b) => b.bookId === bookId)) {
              const { chapters } = await fetchToc(bookId);
              const last = chapters[chapters.length - 1];
              fc.books.push({ bookId, bookName: args.title || '', lastItemId: last?.itemId ?? '', lastChapterTitle: last?.title ?? '' });
            }
            config.followCheck = fc;
            saveConfig(config);
            return { ok: true, message: `已加入追更（当前轮询${fc.enabled ? '开着' : '关着，用 set_enabled 开'}）：${args.title || bookId}` };
          }
          if (action === 'remove') {
            const bookId = parseBookId(args.book);
            fc.books = fc.books.filter((b) => b.bookId !== bookId);
            config.followCheck = fc;
            saveConfig(config);
            return { ok: true, message: '已移除。' };
          }
          if (action === 'set_enabled') {
            fc.enabled = Boolean(args.enabled);
            config.followCheck = fc;
            saveConfig(config);
            return {
              ok: true,
              message: fc.enabled
                ? `追更轮询已开（每 ${fc.intervalMinutes} 分钟查一次，有更新会主动来报）。`
                : '追更轮询已关。',
            };
          }
          return { ok: false, message: `未知 action: ${action}` };
        } catch (error) {
          return { ok: false, message: `操作失败：${error.message}` };
        }
      },
      presentCall() {
        return { card: 'generic', title: 'novel_follow', kind: 'write' };
      },
    }),
  );

  // 陪读人格注册为 skill；skills 服务不在时静默跳过（工具描述里也有流程说明）
  try {
    ctx.skills?.register?.({
      name: SKILL_NAME,
      description: SKILL_DESCRIPTION,
      content: SKILL_CONTENT,
    });
  } catch (error) {
    ctx.logger?.warn?.(`[novel-buddy] skill 注册失败（不影响工具使用）: ${error.message}`);
  }

  // 追更轮询：启动后先等一个周期再查，避免开机就打扰
  const fc = loadConfig().followCheck;
  if (fc?.enabled && Array.isArray(fc.books) && fc.books.length > 0) {
    const ms = Math.max(10, Number(fc.intervalMinutes) || 60) * 60_000;
    const timer = setInterval(() => {
      checkFollows(ctx).catch((error) => {
        ctx.logger?.warn?.(`[novel-buddy] 追更轮询异常: ${error.message}`);
      });
    }, ms);
    if (typeof timer?.unref === 'function') timer.unref();
    disposers.push(() => clearInterval(timer));
  }

  return function dispose() {
    for (const d of disposers) {
      try {
        d();
      } catch {
        /* ignore */
      }
    }
  };
}

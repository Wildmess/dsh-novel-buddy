// novel-buddy 全链路自测：mock ctx + 真实站点（不写入真实 ~/.dsh）
// 运行：node test.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply } from './lib/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.DSH_HOME = path.join(here, '.test-home'); // 沙箱目录

const registered = [];
const ctx = {
  tools: { register: (t) => registered.push(t) },
  skills: { register: (s) => console.log('[skill]', s.name) },
  logger: { warn: (...a) => console.log('[warn]', ...a) },
};
apply(ctx);
console.log('[tools]', registered.map((t) => t.name).join(', '));
const tool = (name) => registered.find((t) => t.name === name);

// 换成你在追的书（bookId 或书页 URL）
const BOOK = '7077516958534470656'; // 凡骨

const toc = await tool('fanqie_toc').execute({ book: BOOK, from: 1, count: 3 });
console.log('[目录]', toc.ok, toc.meta?.bookName, '| 共', toc.chapterTotal, '章 | 首章:', toc.chapters?.[0]?.title);

const ch1 = await tool('fanqie_chapter').execute({ chapter: toc.chapters[0].itemId });
console.log('[正文]', ch1.title, '| 覆盖率', (ch1.stats?.coverage * 100).toFixed(1) + '%');
console.log('[正文] 开头:', ch1.text?.slice(0, 60).replaceAll('\n', '⏎'));

const last = await tool('fanqie_toc').execute({ book: BOOK, from: toc.chapterTotal, count: 1 });
const chN = await tool('fanqie_chapter').execute({ chapter: last.chapters[0].itemId });
console.log('[末章]', last.chapters[0].title, '| 覆盖率', (chN.stats?.coverage * 100).toFixed(1) + '%');

const w = await tool('novel_archive_write').execute({
  book: BOOK,
  patch: { bookName: toc.meta.bookName, recap: '自测前情提要', lastReadOrder: 1, lastReadTitle: ch1.title, lastReadItemId: ch1.itemId },
});
const r = await tool('novel_archive').execute({ book: BOOK });
console.log('[档案] 写:', w.ok, '读:', r.exists, '| recap:', r.archive.recap);

const f = await tool('novel_follow').execute({ action: 'list' });
console.log('[追更]', f.message);

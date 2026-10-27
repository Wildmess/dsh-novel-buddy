// novel-buddy 全链路自测：mock ctx + 真实站点（不写入真实 ~/.dsh，凭据用假数据）
// 运行：node test.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply } from './lib/index.js';
import { loadCredential, saveCredential, deleteCredential } from './lib/credential.js';
import { getIdleSeconds } from './lib/explore.js';

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.DSH_HOME = path.join(here, '.test-home'); // 沙箱目录

const registered = [];
const followups = [];
const ctx = {
  tools: { register: (t) => registered.push(t) },
  skills: { register: (s) => console.log('[skill]', s.name) },
  logger: { warn: (...a) => console.log('[warn]', ...a) },
  agents: { list: () => [{ session: { header: {} }, followup: (m) => followups.push(m) }] },
};
apply(ctx);
console.log('[tools]', registered.map((t) => t.name).join(', '));
const tool = (name) => registered.find((t) => t.name === name);

// 换成你在追的书
const BOOK = '7077516958534470656'; // 凡骨

// 1. 原有链路：目录 + 正文
const toc = await tool('fanqie_toc').execute({ book: BOOK, from: 1, count: 3 });
console.log('\n[目录]', toc.ok, toc.meta?.bookName, '| 共', toc.chapterTotal, '章');
const ch1 = await tool('fanqie_chapter').execute({ chapter: toc.chapters[0].itemId });
console.log('[正文]', ch1.title, '| 覆盖率', (ch1.stats?.coverage * 100).toFixed(1) + '%');

// 2. 凭据：写入（假数据）→ 脱敏检查 → 解密回读 → 删除
await saveCredential({ username: 'testUser123', cookie: 'a=1; b=2' });
const credState = await tool('novel_credential').execute({ action: 'check' });
console.log('\n[凭据] 工具视图:', credState); // 应只见 mask，不见 cookie
const credRaw = await loadCredential();
console.log('[凭据] 内部解密:', credRaw.cookie === 'a=1; b=2' ? 'OK（插件内部可用）' : 'FAIL');
const brokenSearch = await tool('novel_search').execute({ keyword: 'x' }); // 沙箱无真实登录态，接口应报非登录类错误或空
console.log('[搜索] 带假 Cookie 真实请求:', JSON.stringify(brokenSearch).slice(0, 120));
await deleteCredential();
console.log('[凭据] 删除后:', JSON.stringify(await tool('novel_credential').execute({ action: 'check' })));

// 3. 搜索未配置凭据的报错
const noCred = await tool('novel_search').execute({ keyword: '诡秘' });
console.log('[搜索] 无凭据:', noCred.ok ? '意外成功?' : noCred.error.slice(0, 50) + '…');

// 4. 发现记录回路
const add = await tool('novel_discovery_add').execute({
  bookId: '111', name: '测试书A', author: '某人', keyword: '诡秘', reason: '第一章的××情节很有钩子',
});
const addDup = await tool('novel_discovery_add').execute({ bookId: '111', name: '测试书A', reason: '重复' });
const unreported = await tool('novel_discoveries').execute({ action: 'list_unreported' });
const mark = await tool('novel_discoveries').execute({ action: 'mark_reported', ids: ['111'] });
const after = await tool('novel_discoveries').execute({ action: 'list_unreported' });
console.log('\n[发现] 添加:', add.ok, '| 去重:', addDup.duplicate, '| 待汇报:', unreported.list.length, '| 标记:', mark.marked, '| 之后待汇报:', after.list.length);

// 5. 探索配置 + 一轮真实采集（匿名路径，关键词大概率命中 0 本属正常）
const exList = await tool('novel_explore').execute({ action: 'list' });
console.log('\n[探索]', exList.message.split('\n')[0]);
await tool('novel_explore').execute({ action: 'add_keyword', keyword: '玄幻' });
const onceOff = await tool('novel_explore').execute({ action: 'run_once' });
console.log('[探索] 未启用时 run_once:', onceOff.message);
await tool('novel_explore').execute({ action: 'set_enabled', enabled: true });
const once = await tool('novel_explore').execute({ action: 'run_once' });
console.log('[探索] run_once(匿名):', once.message, '| followups:', followups.length);
await tool('novel_explore').execute({ action: 'set_enabled', enabled: false });

// 6. 空闲检测 + 旧功能回归
console.log('\n[空闲] 电脑空闲秒数:', await getIdleSeconds(), '秒');
const archive = await tool('novel_archive').execute({ book: BOOK });
console.log('[回归] 档案工具:', archive.ok, '| 追更:', (await tool('novel_follow').execute({ action: 'list' })).ok);

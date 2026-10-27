# dsh-novel-buddy · 小说陪读吐槽

给 DeepSeek Harness（DSH）里的鱼加一个"陪读"器官：你在番茄小说网页版追书，
鱼负责**整理剧情（滚动摘要）+ 毒舌吐槽（逻辑硬伤 / 人物降智 / 水字数 / 烂套路）**，
每章自动维护一份≤800 字的前情提要，追更轮询开着时还会主动来报"更新了"。

设计思路：**插件只做管道（抓正文、破解反爬字体、存档案），大脑由鱼自己当**
（整理和吐槽走 agent 本体，人格在 `lib/persona.js` 的 skill 里）。

## 安装（Windows / web profile）

```powershell
# 从 GitHub 安装（推荐，发布后可用）
dsh plugin --profile web add github:<owner>/dsh-novel-buddy

# 本地软链安装（改代码立即生效，目录不能移动；适合开发者）
dsh plugin --profile web add link:<插件目录的绝对路径>

# 验证
dsh --profile web --dump-config | Select-String novel-buddy
```

装完重启一次 DSH。零依赖，Node ^22.19（宿主自带 runtime 满足）。

## 工具

| 工具 | 作用 |
|------|------|
| `fanqie_toc` | 抓书籍目录（书页 URL 或 bookId），支持 from/count 分页 |
| `fanqie_chapter` | 抓单章正文，**自动解码反爬字体**，返回前后章 ID 和解码覆盖率 |
| `novel_archive` | 读剧情档案（前情提要 + 进度 + 每章梗概/槽点） |
| `novel_archive_write` | 写档案（增量合并：recap、进度、chapters[itemId]） |
| `novel_follow` | 追更列表管理（轮询默认关，费 token，想开再说） |

## 用法（对鱼说人话即可）

```text
陪我看《凡骨》，从第1章开始          → 鱼会建档案、抓正文、梗概+吐槽+更新前情提要
下一章                               → 按 nextItemId 继续，滚动摘要不断档
这几章跳了，直接看第100章            → 鱼会提醒前情缺失
追更《凡骨》                          → novel_follow add，之后有更新鱼主动来报
```

聊天档案存在 `$DSH_HOME/storages/dsh-novel-buddy/books/{bookId}.json`，随时可翻。

## 反爬字体说明

番茄网页版把正文常用字替换成 PUA 私有区码点，靠自定义 woff2 字体渲染回正常
字形（2026-10-27 实测）。本插件用社区码表（来源
[ying-ck/fanqienovel-downloader](https://github.com/ying-ck/fanqienovel-downloader)
的 `src/charset.json`，已收录 `assets/charset.json`）按 mode 0 区间
[58344, 58715] 查表还原，实测全章覆盖率 100%。

**如果哪天 `stats.coverage` 掉下来了**（工具返回里 □ 变多），说明番茄换码表了：
去上面的项目找新版 charset.json 替换 `assets/charset.json` 即可，不用改代码。

## 已知限制

- 番茄站内搜索没接（书要自己拿书页 URL / bookId 喂给 `fanqie_toc`）
- 锁章（VIP/未上架）拿不到正文，工具会返回 `locked: true`
- 抓的是网页公开内容，仅本地自用，**不要把带数据的服务公开部署或分发**
- 追更轮询每次提醒都是一次模型调用，默认关闭是故意的

## 自测

```sh
node test.mjs   # mock ctx + 真实站点，验证目录/正文/档案/追更全链路
```

## License

MIT

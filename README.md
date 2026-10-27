# dsh-novel-buddy · 小说陪读吐槽

给 DeepSeek Harness（DSH）里的鱼加一个"陪读"器官：你在番茄小说网页版追书，
鱼负责**整理剧情（滚动摘要）+ 毒舌点评（逻辑硬伤 / 人物降智 / 水字数 / 烂套路）**，
每章自动维护一份≤800 字的前情提要，追更轮询开着时主动来报"更新了"。

v0.2 新增**自主探索**：鱼在你不使用电脑时（空闲检测），按你设定的兴趣词自己逛番茄，
读候选书的第一章判断剧情，值得安利的记下来，**下次陪读时报书名和理由**。

设计思路：**插件只做管道（抓正文、破解反爬字体、存档案），大脑由鱼自己当**
（整理和吐槽走 agent 本体，人格在 `lib/persona.js` 的 skill 里）。

## 安装（Windows / web profile）

```powershell
# 从 GitHub 安装
dsh plugin --profile web add github:Wildmess/dsh-novel-buddy

# 本地软链安装（改代码立即生效；适合开发者）
dsh plugin --profile web add link:<插件目录的绝对路径>

# 验证
dsh --profile web --dump-config | Select-String novel-buddy
```

装完重启一次 DSH。零依赖，Node ^22.19（宿主自带 runtime 满足），Windows（凭据加密与空闲检测用了 DPAPI / GetLastInputInfo）。

## 工具

| 工具 | 作用 |
|------|------|
| `fanqie_toc` | 抓书籍目录（书页 URL 或 bookId），支持 from/count 分页 |
| `fanqie_chapter` | 抓单章正文，**自动解码反爬字体**，返回前后章 ID 和解码覆盖率 |
| `novel_archive` / `novel_archive_write` | 剧情档案（前情提要 + 进度 + 每章梗概/槽点） |
| `novel_follow` | 追更列表管理（轮询默认关） |
| `novel_credential` | 查登录凭据配置状态（**只返回脱敏用户名，永远不返回 Cookie 内容**） |
| `novel_search` | 番茄站内搜索（**需要登录凭据**，见下） |
| `novel_discovery_add` | 记录探索中发现的好书（书名/作者/推荐理由） |
| `novel_discoveries` | 发现清单（陪读开始时查"待汇报"，报完标记） |
| `novel_explore` | 探索配置：兴趣词、开关、间隔、立即跑一轮 |

## 登录与自主探索（v0.2）

### 为什么要导入 Cookie，而不是自动输密码

番茄网页端登录走字节系扫码/短信 + 盾验证码，**没有可编程的密码登录接口**；
自动提交密码既不可行也极易触发风控。等效方案：把你自己浏览器里的登录态
（Cookie）导入插件，鱼用它以你的身份请求。实测（2026-10-27）：番茄搜索接口
校验浏览器安全 Cookie，带真实登录 Cookie 即可用、无需伪造签名。

### 导入（30 秒，密码不进聊天）

```powershell
# 在插件目录下，自己的终端里跑（输入不回显，DPAPI 加密落盘）
node scripts\credential.js set
# 按提示粘贴 Cookie：浏览器登录 fanqienovel.com → F12 → Network → 任意请求
#   → Request Headers → Cookie: 后面的整串（或用 Cookie-Editor 扩展导出）
# 备注用户名可填昵称，方便确认是哪个号

node scripts\credential.js check   # 查看状态
node scripts\credential.js forget  # 删除
```

安全设计：凭据经 Windows DPAPI（CurrentUser）加密，只有你的 Windows 账户能解密；
解密只发生在插件发请求的进程内存里；**任何工具都不会把 Cookie 返回给模型**，
聊天里永远不要发密码。

### 探索怎么工作

```text
对鱼说：探索加个兴趣词「诡秘」 / 探索加个兴趣词「克苏鲁」 / 打开探索
     ↓（默认每 6 小时一轮，电脑空闲 15 分钟以上才跑）
插件按词搜书（无凭据则退化为首页推荐榜粗筛） → 过滤你档案/追更/已发现的书
     ↓ 有候选
followup 唤醒鱼 → 鱼自己读每本候选的第一章 → 凭剧情判断值不值得安利
     ↓ 值得的
记入发现清单 → 下次陪读开始时，鱼先报：书名、作者、为什么推荐（引用情节）
```

风险如实说：**自动化访问可能违反番茄服务条款，有账号被限制的风险**——
所以默认关闭、低频（默认 6 小时）、只在电脑空闲时跑、每轮最多 3 本。
是否开启自己权衡，账号是你自己的。

## 反爬字体说明

番茄网页版把正文常用字替换成 PUA 私有区码点，靠自定义 woff2 字体渲染回正常
字形（2026-10-27 实测）。本插件用社区码表（来源
[ying-ck/fanqienovel-downloader](https://github.com/ying-ck/fanqienovel-downloader)
的 `src/charset.json`，已收录 `assets/charset.json`）按 mode 0 区间
[58344, 58715] 查表还原，实测全章覆盖率 100%。

**如果哪天 `stats.coverage` 掉下来了**（工具返回里 □ 变多），说明番茄换码表了：
去上面的项目找新版 charset.json 替换 `assets/charset.json` 即可，不用改代码。

## 已知限制

- 搜索接口依赖真实浏览器会话 Cookie：换设备/过期后需重新 `credential.js set`（`novel_credential check` 会报失效）
- 锁章（VIP/未上架）拿不到正文，工具会返回 `locked: true`
- Cookie 属于敏感凭据：只存本地加密文件，**不要分享、不要提交到任何仓库**
- 抓的是网页公开内容，仅本地自用，不公开部署、不分发
- 追更/探索每轮都是模型调用，默认关闭是故意的

## 自测

```sh
node test.mjs   # mock ctx + 真实站点：目录/正文/凭据回路/发现回路/探索采集
```

## License

MIT

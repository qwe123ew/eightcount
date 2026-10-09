# 封面上线门禁

后续新增舞蹈必须有对应视频的真实封面。脚本只检查本地文件、图片解码和已声明的来源映射，不能自动判断图中是否是正确舞蹈或真实视频画面。发布前仍须逐条人工核对原视频、标题、作者和截图/缩略图证据。

## 发布前执行

从项目根目录运行：

```sh
node --test tests/*.test.cjs
node scripts/validate-cover-readiness.cjs
```

脚本同时支持本地 dist/ 布局和发布仓库的根目录布局。默认先选脚本所属项目下的 dist/（若存在），否则选项目根；在那里读取 app.js、catalog.js 和 assets/，无论当前工作目录在哪里。也可以明确指定静态目录，相对路径按命令运行目录解析：

```sh
# 本地开发目录
node scripts/validate-cover-readiness.cjs --dist-root dist
# 发布仓库：catalog.js、app.js、assets/ 在仓库根
node scripts/validate-cover-readiness.cjs --dist-root .
```

发布仓库至少同步 scripts/validate-cover-readiness.cjs、scripts/cover-readiness-legacy.json 和本说明，保持 scripts/ 目录相对于仓库根的位置。可同步 tests/cover-readiness.test.cjs 并单独运行 node --test tests/cover-readiness.test.cjs；这组测试也兼容两种布局。选择静态目录不会选择或扩大其他基线。

默认是过渡模式：

- 所有**新增歌曲**至少有一个合格的本地视频封面。
- 每个**新增视频来源**也必须有自己的合格封面；同歌其他版本的封面不能使新来源过关。
- 原有 298 首歌曲、431 条来源保持可见，不因为旧记录还在补图而阻断新增就绪检查。
- 删除旧歌、删除旧来源或把旧 URL 移给另一首歌会失败，不能靠减少原曲库来过关。

补齐全部旧歌后，发布必须使用严格模式：

```sh
node scripts/validate-cover-readiness.cjs --strict
```

严格模式要求**每首歌曲**至少一个合格封面，不要求每个旧版本都有图；新增来源始终逐条检查。过渡模式的 PASS 不代表全库已补齐。脚本会显示真实覆盖数。

机器可读完整结果，包括不合格原因、缺图 songId、封面尺寸及 SHA-256：

```sh
node scripts/validate-cover-readiness.cjs --strict --json > cover-readiness-report.json
```

退出码：0 = 此模式校验通过；1 = 内容未达到就绪条件；2 = 无法完成校验（依赖/数据/基线错误）。非零一律不能当作通过。这里不添加 GitHub 工作流、自动部署或 git hook；发布者负责在发布步骤中运行门禁。脚本不下载图片、不打开浏览器、不修改 catalog 或基线。

## 支持的封面字段

当前逐条原视频截图格式（《爱你》正在使用的格式）：

```json
{
  "url": "https://www.bilibili.com/video/BV1gS4y1q7VE/",
  "sourceEvidenceUrl": "https://www.bilibili.com/video/BV1gS4y1q7VE/",
  "thumbnail": "assets/covers/bilibili-BV1gS4y1q7VE-frame.jpg",
  "thumbnailSourceUrl": "https://www.bilibili.com/video/BV1gS4y1q7VE/",
  "thumbnailProvenance": "2026-10-09：逐条打开原视频页面，核对标题及UP主，截图已暂停的真实播放器画面（00:17）；裁去黑边，非生成图。"
}
```

thumbnailSourceUrl 必须与这条记录的 url **完整一致**，包含版本、分 P 查询参数。thumbnailProvenance 必须是非空说明。不要把其他教学、镜面或翻跳版本的图片挂到当前来源。

兼容原有格式：localThumbnail 为本地 assets/ 路径，imageSource 为无凭据的 HTTPS 来源页，imageKind 为非空来源说明；sourceEvidenceUrl 也必须是无凭据的 HTTPS URL。图片若取自官方跨平台页面或明确引用该视频的文章，imageSource 可以不同于视频 url，这只是记录内的来源声明，仍需人工查看证据核对。若同时提供 thumbnailSourceUrl，则它必须与该视频 url 一致，不能用旧字段掩盖显式映射冲突。

为 localThumbnail 也可以提供精确 thumbnailSourceUrl + thumbnailProvenance。只有远程 thumbnail URL 不算本地封面。脚本会依次检查 localThumbnail 和 thumbnail，并接受其中至少一个符合契约的本地候选；不会拿同歌其他来源的文件来替代当前来源的缺失字段。

## 文件与身份检查

- 只接受所选静态目录的 assets/ 下的本地 jpg/jpeg/png/webp/gif/avif；不接受绝对路径、URL、查询串、路径穿越或逃出 assets 的符号链接。
- 文件必须存在、是非空常规文件、最多 20 MiB、最多 4000 万像素。
- 用 sharp 检查实际格式并解码像素，不只看扩展名或图片头。HTML 错误页、伪装 SVG、损坏/截断图片和解码警告都不通过。动图只检查首帧。
- 歌曲身份与应用一致，使用应用 normalize(artist) + '-' + normalize(song)。来源按 songId 与完整 url 联合识别；无效或重复来源不会被静默跳过。
- JSON 输出的哈希用于审核时精确指认被检查的文件，不代表内容真实性证明。文件被替换后须重新运行。

## 固定的过渡基线

scripts/cover-readiness-legacy.json 是 2026-10-09 已有 298 首、431 条来源的只读过渡快照；只包含 songId 和来源关系，不包括封面。

脚本校验固定数量和 SHA-256，不提供更新基线或忽略错误的选项。**不得把新内容加入白名单，不得从当前 catalog 重建基线。** 补旧图无需改基线；全部补齐后改用 --strict。若旧来源确实需要更正或移除，必须单独审核明确的目录变更和迁移策略，不能随手刷新白名单绕过门禁。

## 运行依赖与失败行为

需要 Node.js 及可由标准 require('sharp') 找到的 sharp；实现没有硬编码临时机器上的依赖绝对路径。本次在 Node v24.19.0 / sharp 0.35.4 的现有环境验证，未安装任何依赖。

本项目当前没有 package.json，现有托管环境通过 Node 的标准模块解析提供 sharp。换到其他发布环境时，应先明确提供这一依赖；没有 sharp、原生库不可加载或解析失败时，命令返回 2 并说明无法完成校验，**不会退化成只检查文件名或自动放行**。可先用 node -e "require('sharp')" 检查发布环境。测试也依赖相同 decoder。

## 人工审核仍必须做

检查图像能否解码不等于确认它来自该视频。即使字段齐全，可解码的专辑图、无关人物、纯色占位图或错误视频截图也可能通过技术校验。人工必须核对封面与精确视频、版本、作者和现场证据，并拒绝登录弹窗、错误页、无关画面、生成配图或不合适裁切。来源字段也是声明，不是防伪签名；不要把门禁 PASS 宣称为自动视觉鉴真、播放可用性验证或版权授权。

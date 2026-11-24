# syncaus 的 DSH 插件

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）用的三个插件，以及一份可以直接加进 DSH 的插件索引。

这个仓库是**开发工作区**：三个插件放在各自的版本目录里一起维护，另有一个独立发布仓库对应每个插件，装进 DSH 的包从发布仓库出。

## 插件

| 插件 | 做什么 | 发布仓库 | 文档 |
|---|---|---|---|
| 长任务接力 `dsh-longtask-relay` | 把一个长任务变成一条会话链：真理源落在工作区文件里，上下文逼近上限时自动收尾、开新会话并交接，新会话沿用权限预设、目标和计划模式。真理源在宿主侧封存，直接改文件会被拦下；功能是否通过由插件亲自跑验证命令判定，结束前由独立评审会话对照设计核验，最后由人确认。带一个监控和操作每条链的面板。 | [syncaus/dsh-longtask-relay](https://github.com/syncaus/dsh-longtask-relay) | [README](dsh-longtask-relay-1.6.1/package/README.md) · [详细说明](dsh-longtask-relay-1.6.1/package/docs/DETAIL.md) · [设计方案](dsh-longtask-relay-1.6.1/DESIGN.md) |
| 工作规则与开发流程 `@local/kadda-rules` | 把一份工作规则和六阶段开发流程注入系统提示词，提供 `/dev`、`/verify`、`/review` 命令，并用代码强制两条门禁：计划模式下不能改文件，改完没验证不让回合结束。 | [syncaus/local-kadda-rules](https://github.com/syncaus/local-kadda-rules) | [README](local-kadda-rules-2.0.0/package/README.md) |
| Playwright 浏览器 `@local/dsh-mcp-playwright` | 把 Playwright MCP 服务接进 DSH，用于网页端到端测试、截图和断言。只有一份配置，没有代码。 | [syncaus/dsh-mcp-playwright](https://github.com/syncaus/dsh-mcp-playwright) | [配置](dsh-mcp-playwright-1.0.0/package/cordis.patch.yml) |

各插件的当前版本见它自己的 `package.json`。

## 安装

### 通过插件索引

1. 在 DSH 里打开「插件」，在「实验性插件」下打开「自定义插件索引」。
2. 切到「发现」标签页，点「添加索引源」，填入：

   ```
   https://cdn.jsdelivr.net/gh/syncaus/dsh-longtask-relay@main/market/index.json
   ```

   `raw.githubusercontent.com` 的同类地址（`/syncaus/dsh-longtask-relay/main/market/index.json`）在部分网络里连不上，DSH 会报「无法读取此索引」，所以默认给镜像地址。镜像按 `@main` 缓存，发布新版本后可能延迟几分钟到几小时才生效；要立刻拿到最新索引，用 `https://ghproxy.net/https://raw.githubusercontent.com/syncaus/dsh-longtask-relay/main/market/index.json`（第三方转发，无缓存）。

3. 在列表里选插件，点「安装」。确认框会显示这个版本对应的仓库、提交和目录，核对后再确认。

索引里的每个版本都钉在一个具体的提交上，所以装到的是 `market/index.json` 里登记的那个版本，不一定是 `main` 分支上最新的代码。要用最新代码，从本地目录安装。

### 从本地目录

克隆本仓库后，把对应插件的 `package` 目录用 `file:` 加进 DSH 的 profile（路径用绝对路径）：

```sh
dsh plugin --profile <profile 名> add file:D:/path/to/dsh-longtask-relay/dsh-longtask-relay-1.6.1/package
dsh plugin --profile <profile 名> add file:D:/path/to/dsh-longtask-relay/local-kadda-rules-2.0.0/package
dsh plugin --profile <profile 名> add file:D:/path/to/dsh-longtask-relay/dsh-mcp-playwright-1.0.0/package
```

装进 profile 的是一份实体副本：改了源码之后要重新安装才生效。

### Playwright 插件要先改路径

`dsh-mcp-playwright-1.0.0/package/cordis.patch.yml` 里写的是某一台机器上的绝对路径（Node 可执行文件和全局安装的 `@playwright/mcp`）。安装前把 `command` 和 `args` 的第一项改成你自己机器上的路径，并先全局安装 `@playwright/mcp`。

## 目录结构

```
dsh-longtask-relay-1.6.1/      长任务接力（发布到 syncaus/dsh-longtask-relay）
├── DESIGN.md                  设计方案与实现状态
├── GATES-DESIGN.md            门禁与交付核验的设计、边界与残留
└── package/                   插件本体
    ├── index.js               Host 端入口
    ├── client.js              浏览器端：面板、两个会话标签页、配置卡
    ├── lib/                   链存储、监督与交接、工具、提示词、配置
    ├── locale/                插件列表里显示的标题和描述
    ├── docs/DETAIL.md         插件页里的详细说明
    └── test/                  测试
local-kadda-rules-2.0.0/package/   工作规则（发布到 syncaus/local-kadda-rules）
├── index.js                   注入规则、注册命令和门禁
└── rules/  flow/  guides/     规则正文、流程表、按需必读的指南
dsh-mcp-playwright-1.0.0/package/  Playwright MCP（发布到 syncaus/dsh-mcp-playwright）
└── cordis.patch.yml           MCP 服务配置
market/index.json              插件索引（随长任务发布仓库一起推）
```

目录名跟随其中 `package.json` 的 `version`，发版时一起改名。

## 开发

插件都是纯 JavaScript，没有依赖，也没有构建步骤。

长任务接力带测试，在 `dsh-longtask-relay-1.6.1/package` 目录下运行：

```sh
node test/smoke.mjs         # 链存储、监督判定、交接、工具和面板接口
node test/client-boot.mjs   # 浏览器端能加载并注册全部界面入口
node test/hooks-render.mjs  # 界面组件能渲染，hook 顺序稳定
```

这些测试用替身模拟 DSH 的服务，不需要启动 DSH；界面在真实 DSH 里的观感和交互要装上之后手动确认。

## 发布一个新版本

三个发布仓库的根就是插件包本身（`package.json` 在根），内容由本仓库按目录拆出来。发布一次要做的：

1. 改插件 `package.json` 的 `version`，目录名跟着改，在本仓库提交。
2. 用 `git subtree split` 拆出发布历史，得到一个新的提交哈希（发布仓库的根就是那个 `package` 目录的内容）：
   ```sh
   git subtree split --prefix=dsh-longtask-relay-1.6.1/package -b publish/relay
   ```
   长任务插件改过目录名（`1.1.0` → `1.6.1`），`--prefix` 只认当前路径，改名前的历史要用旧前缀拆一次再接到新分支上。
3. 把 `market/index.json` 放到发布分支的 `market/` 下（索引随长任务插件走；它是唯一带 `market/` 的发布仓库），补一个提交。
4. 推上去，并用第 2 步的哈希更新索引里该插件的 `versions[].source.commit`：
   ```sh
   git push --force-with-lease git@github.com:syncaus/<发布仓库>.git publish/relay:main
   ```
   索引里的 `source.path` **省略不写**，表示插件包就在发布仓库根。写成空串 `""` 会被索引校验拒绝（`path` 必须是非空的相对目录），整个索引都读不出来。

索引格式见 DSH 仓库的 `docs/user/guide/plugin-market.zh.md`。

## 许可

[Apache License 2.0](LICENSE)

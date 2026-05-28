# canvapie

语言：**简体中文** | [English](./README.en.md)

面向 Agent 和自动化管线的 Canva.cn Connect API CLI。它可以让 Agent 接收用户给出的 Canva 设计链接、设计 ID、临时编辑链接或标题关键词，解析出目标设计，读取设计元数据，导出 PPTX/PDF/图片，并检查导出的 PPTX 中哪些页面被隐藏。

当前仓库同时保留了一个本地 OAuth 调试服务 `server.mjs`，方便验证 Canva.cn OAuth 和 Connect API 调用链路。

## 快速安装

推荐全局安装：

```sh
npm install -g canvapie
canvapie help
```

如果想固定当前版本：

```sh
npm install -g canvapie@0.2.1
```

安装后按这个顺序完成首次授权：

```sh
canvapie init
canvapie auth login
canvapie doctor --json
```

## 快速示例

```sh
canvapie help
canvapie init
canvapie auth login
canvapie doctor --json
canvapie resolve "https://www.canva.cn/design/<design-id>/edit" --json
canvapie resolve "<title-keyword>" --json
canvapie pages <design-id> --json
canvapie export-formats <design-id> --json
canvapie profile get --json
canvapie folders list root --limit 10 --json
canvapie folders list uploads --item-types image --limit 10 --json
canvapie export "<title-keyword>" --format pptx --pages 1 --out cli-exports --inspect --json
canvapie inspect exports/<design-id>.pptx --json
canvapie resolve --input refs.txt --jsonl
canvapie export --input designs.jsonl --format pptx --inspect --jsonl
```

CLI 会优先读取当前目录下的 `.env` 和 `.tokens.json`。如果当前目录没有 `.tokens.json`，会回退到：

```text
~/.canvapie/tokens.json
```

## 首次使用

新用户第一次使用时需要安装、配置、授权三步：

```sh
npm install -g canvapie
canvapie init --help
canvapie init
canvapie auth login
```

`canvapie init` 会保存 Canva.cn integration 的 `client_id`、`client_secret`、redirect URL、API URL 和 scopes 到：

```text
~/.canvapie/config.json
```

如果 `~/.canvapie/config.json` 已经存在且包含 client ID / client secret，`canvapie init` 会直接复用现有配置，不会再次询问或覆盖。需要更新配置时使用：

```sh
canvapie init --force
```

配置本身没有本地过期时间；会过期的是 OAuth token。用下面命令查看 `token_expires_at`、`token_expires_in_seconds` 和 `token_expired`：

```sh
canvapie doctor --json
```

这些值来自 Canva.cn Developer Portal：

1. 打开 `https://www.canva.cn/developers/integrations`
2. 创建或打开一个 Connect API integration。
3. 在 Authentication 页面复制 client ID 和 client secret。
4. 在 Return navigation / redirect URLs 中添加：

   ```text
   http://127.0.0.1:3001/oauth/redirect
   ```

5. 在 Scopes 页面启用：

   ```text
   design:meta:read design:content:read folder:read asset:read profile:read
   ```

Scope 是两层配置：Canva Developer Portal 里必须先允许对应 scope；`canvapie init --scopes` 或保存到 config 的 scopes 只决定 CLI 在 OAuth 登录时请求哪些 scope，不能自动修改 Canva 后台勾选项。

如果 Agent 不知道 client ID 或 client secret，应该让用户先创建/打开 Canva.cn Connect API integration 并提供这两个值，不能猜。

如果是 Agent、脚本或 CI，不想走交互输入，可以直接传参：

```sh
canvapie init \
  --client-id <client_id> \
  --client-secret <client_secret> \
  --redirect-uri http://127.0.0.1:3001/oauth/redirect
```

也可以通过环境变量提供：

```sh
CANVA_CLIENT_ID=<client_id> CANVA_CLIENT_SECRET=<client_secret> canvapie init
```

## Canva 集成配置

在 Canva.cn Developer Portal 的 Connect API integration 页面中配置：

1. 添加本地重定向 URL：

   ```text
   http://127.0.0.1:3001/oauth/redirect
   ```

2. 为读取和导出启用这些 scopes：

   ```text
   design:meta:read design:content:read folder:read asset:read profile:read
   ```

   其中 `design:content:read` 是导出 PPTX/PDF/图片和查询可导出格式所需权限。

如果某个命令返回 `missing_scope`，先回到 Canva Developer Portal 的 Scopes 页面勾选返回的 `required_scopes`，保存集成，然后重新运行：

```sh
canvapie auth login
canvapie doctor --json
```

## 本地开发

复制环境变量模板：

```sh
cp .env.example .env
```

本仓库内调试时可以直接使用 npm script：

```sh
npm run canvapie -- doctor --json
```

如果使用 npm 包安装，就可以直接运行 `canvapie`。

然后在 `.env` 中填入 Canva.cn integration 的：

```text
CANVA_CLIENT_ID=
CANVA_CLIENT_SECRET=
```

不要把 `.env`、`.tokens.json`、导出的 PPTX 提交到版本管理。

## CLI 命令

### 帮助

```sh
canvapie help
canvapie help init
canvapie help export
canvapie -h
canvapie --help
```

`help` 是子命令，`-h` / `--help` 是 flag。`-v` / `--version` 可查看版本。

### 诊断

```sh
canvapie doctor --json
```

返回当前环境、登录状态、token 过期时间、已授权 scopes、缺失 scopes 等信息。

### 授权

```sh
canvapie auth login
canvapie auth status --json
canvapie auth logout
```

`auth login` 会打开浏览器完成 Canva.cn OAuth PKCE 授权，并把 token 保存到本地。

### 解析设计引用

```sh
canvapie resolve "<design-ref>" --json
canvapie resolve --stdin --jsonl
canvapie resolve --input refs.txt --jsonl
```

`design-ref` 可以是：

- Canva 设计 ID：`<design-id>`
- 标准设计链接：`https://www.canva.cn/design/<design-id>/edit`
- 临时 API edit/view URL
- 标题关键词：`<title-keyword>`

### 读取设计

```sh
canvapie list --limit 25 --json
canvapie search "<title-keyword>" --json
canvapie get "<title-keyword>" --json
canvapie pages <design-id> --json
canvapie export-formats <design-id> --json
```

资源分组形式也保留，可用于更接近 API 的脚本风格：

```sh
canvapie designs list --limit 25 --json
canvapie designs search "<title-keyword>" --json
canvapie designs get "<title-keyword>" --json
canvapie designs pages <design-id> --json
canvapie designs export-formats <design-id> --json
```

`pages` / `designs pages` 目前读取的是 Canva Connect API 的页面 metadata。Canva API 当前不直接返回页面是否 hidden。

`export-formats` / `designs export-formats` 用于查询某个具体设计当前可导出的格式。它不是新增导出格式，而是在导出前让 Agent 判断目标设计是否支持 `pptx`、`pdf`、`png` 等格式。

### 读取 Profile / Folder / Asset

```sh
canvapie profile get --json
canvapie folders get root --json
canvapie folders list root --limit 25 --json
canvapie folders list uploads --item-types image --limit 25 --json
canvapie assets get <asset-id> --json
```

这些命令分别需要：

```text
profile:read
folder:read
asset:read
```

`folders list` 默认读取 `root`。常用特殊 folder ID：

```text
root
uploads
```

为了避免输出临时访问 URL，folder item、asset 和 design 输出会默认归一化，只保留 ID、标题/名称、时间、缩略图是否存在等稳定字段。

### 导出设计

```sh
canvapie export "<title-keyword>" --format pptx --out cli-exports --inspect --json
canvapie export --stdin --format pptx --out cli-exports --inspect --jsonl
canvapie export --input designs.jsonl --format pptx --out cli-exports --inspect --jsonl
```

导出会创建 Canva export job，轮询直到成功，然后下载文件到：

```text
cli-exports/<design_id>/
```

如果带 `--inspect` 且格式为 `pptx`，CLI 会额外生成：

```text
manifest.json
slides.json
```

### 批处理

批处理支持纯文本、JSONL 和 JSON 数组。纯文本每行一个设计引用：

```text
https://www.canva.cn/design/<design-id>/edit
<title-keyword>
```

JSONL 每行可以是：

```json
{"ref":"https://www.canva.cn/design/<design-id>/edit"}
{"design_id":"<design-id>"}
{"title":"<title-keyword>"}
```

也可以直接串联 `resolve` 到 `export`：

```sh
canvapie resolve --input refs.txt --jsonl \
  | canvapie export --stdin --format pptx --out cli-exports --inspect --jsonl
```

批处理会逐行输出 JSONL；单条失败不会中断后续输入。如果有任意失败，进程退出码为 `10`。

### 检查 PPTX 隐藏页

```sh
canvapie inspect cli-exports/<design-id>/<design-id>.pptx --json
canvapie remove-hidden cli-exports/<design-id>/<design-id>.pptx --out cli-exports/<design-id>/<design-id>.visible.pptx --json
```

`canvapie ppt inspect <file.pptx>` 也保留为兼容别名。
`canvapie ppt remove-hidden <file.pptx>` 也保留为兼容别名。

PPTX 隐藏页标记位于：

```text
ppt/slides/slideN.xml
```

例如：

```xml
<p:sld show="false" ...>
```

CLI 会输出总页数、可见页数、隐藏页数和隐藏页索引。`remove-hidden` 会生成一份新的 PPTX，删除隐藏页，并保留原文件不变。

## 本地 OAuth 调试服务

如果想用浏览器手动验证 OAuth 和 API，可启动原型服务：

```sh
npm start
```

然后打开：

```text
http://127.0.0.1:3001/
```

可用端点：

- `/`：查看配置和授权状态
- `/oauth/start`：开始 Canva 授权
- `/oauth/redirect`：接收 OAuth 回调
- `/oauth/refresh`：刷新 token
- `/api/designs`：列出设计
- `/api/designs/:id`：读取单个设计元数据
- `/api/export?designId=...&format=pptx`：导出设计并下载结果

## Agent / 管线设计原则

`bin/canvapie.mjs` 的定位是 Agent-first：

- 默认输出 JSON。
- 非授权命令不交互。
- `stdout` 给机器读，`stderr` 放进度和警告。
- 设计引用解析由 CLI 统一处理，Agent 只需要把用户输入原样传给 CLI。
- 导出产物有稳定目录结构和 `manifest.json`。
- Agent 可以从 `canvapie help` 获取完整主路径：`doctor`、`init`、`auth login`、`export`、`inspect`。
- 不传 `--out` 时默认导出到当前工作目录的 `exports/<design_id>/`。

## 当前 V0 限制

- 暂未实现 `jobs status/resume`。
- 暂未实现 Canva 端写入能力，例如创建/修改设计、上传/删除素材、创建评论、修改权限等。
- 当前开源模式要求用户自带 Canva.cn integration，并把自己的 client secret 保存在本机。
- 项目不会内置或分发共享的 `client_secret`；用户应自行保护 `~/.canvapie/config.json` 和 `~/.canvapie/tokens.json`。

# Beautio

[English](README.md) | 简体中文

Beautio 是一个低摩擦、库存优先的个人美容用品管理系统。它的核心将库存与生命周期事实与任何单一 AI 提供商解耦，并通过 MCP、GPT Actions 和人工管理页面对外提供同一套规则。

## 项目状态、许可与隐私

Beautio 正在积极开发中。它尚非完成或稳定的产品；接口、数据模型和部署指南都可能随时变更。

源码公开是为了保持透明，但目前未授予任何开源许可。除非未来的 `LICENSE` 文件另有说明，否则保留一切权利。GitHub 服务条款仍允许用户在 GitHub 上查看和 fork 本仓库，但不应将公开发布理解为获得使用、修改、再分发或部署代码的许可。

Beautio 会处理个人库存、图片、备注，以及使用与生命周期数据。任何面向用户的发布版本都应让数据流向容易理解：收集或生成了什么、存储在哪里、哪个外部服务接收了哪些数据、使用目的、保留时间，以及如何更正、导出或删除数据。上传和持久化写入应在用户明确确认后进行，集成服务只应接收完成用户所请求操作必需的数据。

这是开发阶段声明，不是完整的隐私政策，也不表示每项规划中的控制都已实现。下文记录了当前行为与部署边界；在使用 Beautio 处理真实个人数据前，必须先审阅这些内容。

## 产品边界

- 优先使用库存中已有的产品。
- 将购买意图与日常护理选择分开。
- 让皮肤状态覆盖基于到期时间的消耗优先级。
- 将领域规则放在核心服务中，而不是提示词或客户端适配器中。
- 将核心数据库视为唯一真实来源。
- 只在用户确认结构化草稿后，才上传图片或创建库存。

## 仓库结构

```text
apps/
  web/                 需认证的库存与修正界面
services/
  core-api/            远程 MCP、GPT Action、Codex 与 Admin HTTP 适配器
  mcp-server/          生产薄客户端与本地开发 stdio MCP 适配器
packages/
  contracts/           严格的输入与输出 schema
  domain/              实体、值对象与生命周期政策
  application/         共享业务用例与端口
  database/            本地 SQLite 仓库与保留式迁移
  image-storage/       私有文件系统字节与栅格图像解码
```

每个生产入口最终都收敛到服务器唯一的 `InventoryApplicationService`。生产 stdio MCP 读取受控的本地文件，并通过固定 HTTPS 调用该边界；它自身从不打开 SQLite 或受管图片存储。显式的开发 stdio 入口使用临时本地存储构建相同的应用边界。MCP 传输、HTTP 路由和浏览器代码都不计算 PAO 截止日期、不直接写入 SQLite，也不自行编造持久 ID。

## 本地管理页面

使用 Node.js 24 和 pnpm 11。如果没有配置两把不同的 bearer key 以及 Action 文件主机白名单，HTTP 进程会失败并关闭。在本地界面开发中，如果不会调用 Action 上传路由，明确的虚构主机配置即可满足要求：

```sh
export BEAUTIO_ACTION_BEARER_TOKEN="$(openssl rand -hex 32)"
export BEAUTIO_ADMIN_BEARER_TOKEN="$(openssl rand -hex 32)"
export BEAUTIO_ACTION_FILE_HOST_ALLOWLIST="files.example.invalid"
pnpm install
pnpm dev
```

打开 <http://127.0.0.1:4173>，输入当前标签页的 Admin key 并解锁。该 key 只保留在 JavaScript 内存中；锁定或离开页面时会被清除。解锁前，浏览器不会读取库存或受管图片。

默认情况下，本地开发使用已忽略的路径：

```text
.local/beautio-validation.sqlite
.local/managed-images/
```

### 本地构建预览

要在本地检查生产服务路径时，请将已构建的管理页面和受管 Core API 作为同源进程使用：

```sh
pnpm local:preview
```

先激活仓库的 Node.js 24 运行时（例如使用 nvm 时执行 `nvm use`）；启动器会拒绝较旧或较新的主版本。

打开 <http://127.0.0.1:8787>，并使用 `111` 作为仅限本地的 Admin key。该命令每次启动前都会构建 Web 应用，通过 Core API 提供不可变构建，并复用上述已忽略的本地数据库和受管图片路径。它不会在 4173 端口启动 Vite 服务器。

启动器将监听地址固定为 loopback，使用明确的非生产 Action 配置，移除任何继承的公网 origin 或 Cloudflare Access 配置，并禁用远程 MCP 路由。8787 端口被占用时它会拒绝启动，因此请先停止 `pnpm dev`。本地覆盖项使用明确的本地名称 `BEAUTIO_LOCAL_ADMIN_TOKEN`、`BEAUTIO_LOCAL_ACTION_TOKEN`、`BEAUTIO_LOCAL_DB_PATH` 和 `BEAUTIO_LOCAL_IMAGE_STORAGE_ROOT`；请勿在其中放置生产凭据。

这条路径复现了生产应用入口形态和同源静态服务，但不复现容器操作系统、TLS、反向代理、Cloudflare Access 或公网链路。Docker 镜像仍是最终生产制品。

### 只读生产观察器

如需通过本地构建界面检查当前生产库存，但不复制 SQLite 数据库、也不将 Admin key 暴露给浏览器，请将生产 `URL` 和 `Admin Key` 放入已忽略的私有文件 `.local/beautio-production-credentials.txt`，把文件模式设为 `0600`，然后运行：

```sh
BEAUTIO_PROD_OBSERVE_EXPECTED_ORIGIN="https://your-production.example" pnpm prod:observe
```

打开 <http://127.0.0.1:8787>，并使用 `111` 作为本地只读 key。专用观察器从不打开本地或生产 SQLite 文件。它将生产 key 保留在 loopback 进程内，且只允许精确的库存和受保护图片 GET 路由；重定向、重试、写方法、Admin/Action 路由、MCP、OpenAPI、意外查询参数、响应类型和超大响应，都会在数据到达浏览器前被拒绝。界面同时移除所有编辑入口，并将会话标记为生产只读。

观察器构建隔离在已忽略的 `.local/production-observe-web/` 下；它从不覆盖由 `local:preview` 或生产镜像提供的常规 `apps/web/dist`。

必填的预期 origin 是独立的目标锁定。它必须与凭据文件中不带路径的 HTTPS `URL` 完全一致；不匹配时，程序会在 Admin key 附加到任何网络请求前停止启动。

这是实时视图，而非快照：每次刷新都会对生产 HTTPS API 执行新的有界读取。由于默认本地 key 被故意设计为易于记忆，它信任同一计算机上的其他进程。如果这项本地信任假设不合适，请用 `BEAUTIO_PROD_OBSERVE_LOCAL_TOKEN` 覆盖它。`BEAUTIO_PROD_OBSERVE_CREDENTIALS` 可选择其他私有文件，`BEAUTIO_PROD_OBSERVE_PORT` 可选择其他 loopback 端口。

页面为每个实体瓶子保留一张卡片。Product 名称、分类、规格、一张展示图、包装上已确认的成分文本与共享备注，由链接到该 Product 的所有瓶子共享。因此，Product 修改会出现在每张相关卡片上。每瓶有独立的自定义备注。库存事实编辑只接受直接生命周期事实；PAO 截止日期、最终可用日期、状态与警告均由共享核心重新计算，并在保存后重新读取。自定义备注使用独立的狭窄路由，在终结历史中仍可编辑。

开封日期保留 `exact`、`estimated` 或旧数据无证据语义。预估的开封日期及其派生 PAO 截止日期在更正前会始终明确标记为预估。终结状态 `finished` 和 `discarded` 的历史无法通过活跃库存编辑器改写。

受管 `image_asset_id` 图片使用 Admin key 获取，并通过可撤销的 Blob URL 显示。库存卡片请求私有 `card` 派生图，保守移除确定的近白色或透明外边距；低置信度或处理失败时，退回到未修改的原图。在读取原图前，会同时检查正向与保守负向结果；不同图片的原生渲染会串行化以限制内存。Product 详情保留显式的完整原图查看器。派生图是同一 ImageAsset 的版本化、可重建文件系统缓存，而不是另一个 Product 事实或资产 ID；清理图片时，它会与原图一起删除。当前文件系统 provider 假定每个图片存储根目录只有一个 Core API writer；未来的多进程部署必须添加共享锁与持久删除协调。没有受管图片时，现有 `image_ref` 行为保持不变。这部分不迁移、删除或重新解释旧图片引用。

### 生产同源页面

只构建一次管理页面，然后让 Core API 从绝对且受控的目录提供该不可变构建。不要把 Vite 开发服务器作为生产进程运行：

```sh
pnpm install --frozen-lockfile
pnpm build

export BEAUTIO_DB_PATH="/var/lib/beautio/beautio.sqlite"
export BEAUTIO_IMAGE_STORAGE_ROOT="/var/lib/beautio/managed-images"
export BEAUTIO_ACTION_BEARER_TOKEN="$(openssl rand -hex 32)"
export BEAUTIO_ADMIN_BEARER_TOKEN="$(openssl rand -hex 32)"
export BEAUTIO_ACTION_FILE_HOST_ALLOWLIST="oaiusercontent.com"
export BEAUTIO_WEB_ROOT="$PWD/apps/web/dist"
export BEAUTIO_PUBLIC_ORIGIN="https://beautio.example.com"
node services/core-api/src/http.ts
```

`BEAUTIO_WEB_ROOT` 在本地 API 测试中可选，但一旦设置，必须指向现有的绝对目录。`/` 与已构建资产是公开的；库存、图片、Action 和 OpenAPI 授权规则保持不变。`/api` 和 `/openapi` 是保留路径，永远不能被静态文件覆盖。根 HTML 会重新验证，Vite 的 `/assets/` 输出则以不可变方式缓存。

`BEAUTIO_PUBLIC_ORIGIN` 在本地同样可选。设置时，它必须是一个精确的 HTTPS origin，不带路径、查询、片段或凭据。Action OpenAPI 文档随后会在 `servers` 中包含该 origin。Node 进程默认监听 `127.0.0.1`，因此同机反向代理或出站隧道可以发布它，而无需暴露 origin 端口。

在隔离的 Docker Compose 网络中，设置 `BEAUTIO_API_HOST=0.0.0.0`，使同级 `cloudflared` 容器能够访问 Core API。不要在宿主机上发布 API 端口；`0.0.0.0` 是容器网络适配，不是绕过隧道的理由。配置的主机必须是非空 IPv4、IPv6 或 ASCII DNS 主机名；URL、端口、路径和格式错误的主机名都会导致启动失败。

本地界面示例使用明确虚构的 `files.example.invalid` 主机，因为它不会调用上传路由。生产示例明确信任 OpenAI 文件内容根域 `oaiusercontent.com`。其他配置项仍是精确 HTTPS 下载主机；配置该根域时，只接受它及其点边界子域，包括区域或多级名称。它不匹配伪装后缀、位于其他根域下的域名或带尾随点的变体。初始 URL 和每次重定向都使用相同的主机与公网地址检查。将数据库和受管图片目录放在可替换发布路径之外，并在启动迁移或升级前一起备份。

## 已确认的批量写入

共享核心提供两个写操作：

- `upload_product_images` 验证 JPEG、PNG 或静态 WebP 内容，并创建私有临时资产。一次调用接受 1–10 张图片，每张最多 20 MiB，总计最多 50 MiB，解码上限为 4000 万像素。
- `create_inventory_batch` 以原子方式创建已确认的 Product 记录以及每瓶一条 InventoryItem，或给现有 Product 增加瓶子。新 Product 可包含已确认的 `ingredient_list_text` 和 Product 级共享备注 `shared_notes`；每个新瓶子可独立包含 `custom_notes`。未知的可选事实保持为 `null`；派生字段从不作为输入接受。如果备注归属不清楚，调用方必须在写入前询问。

未关联的临时图片会在 24 小时后过期。Core API 和本地开发 stdio 服务会在启动时清理，且至少每小时清理一次；生产 stdio 薄客户端不拥有需清理的存储。已关联图片会保留；替换或清除 Product 图片会重新开始旧资产的 24 小时未关联窗口。

`create_inventory_batch` 不承诺请求幂等。在结果不明时，调用方不得静默重试。

### 只读远程 MCP

Core API 可以显式启用位于 `/mcp` 的独立 Streamable HTTP MCP 端点。它只暴露 `search_inventory` 和 `fetch_inventory_item`；两者都复用服务器现有的 `InventoryApplicationService`，且从不注册写入、图片内容、resource 或 prompt 界面。搜索返回紧凑的库存摘要。获取操作返回完整的 Product 成分文本、共享备注和单瓶自定义备注。图片被缩减为 `has_image`；不返回图片 ID、旧引用、URL、路径或字节。

可选的 `as_of` 会添加与日期相关的领域状态。省略时，`derived_status` 为 `null`；服务器从不自行代入时钟或时区。

该路由默认不存在。启用它需要完整、独立的 Cloudflare Access 配置：

```sh
export BEAUTIO_REMOTE_MCP_ENABLED=true
export BEAUTIO_REMOTE_MCP_HOST="mcp.beautio.example.com"
export BEAUTIO_ACCESS_TEAM_DOMAIN="https://team.cloudflareaccess.com"
export BEAUTIO_ACCESS_AUDIENCE="managed-oauth-application-audience"
```

公网主机名必须由使用 Managed OAuth 的 Cloudflare Access MCP 应用保护。Access 完成客户端 OAuth 流程并注入 `Cf-Access-Jwt-Assertion`；origin 端独立使用团队 JWKS、精确 issuer、精确应用 audience 和有效期窗口验证该 JWT。单用户 email allow 政策只存在于 Cloudflare Access，不在 origin 环境中重复配置。该端点从不接受 Action/Admin bearer key。它还会拒绝其他 Host 或浏览器 Origin 值，限制经认证请求体和并发请求，并为每次读操作应用截止时间。所有真实 Access 值都应放在部署 secrets 中，不得进入源代码或日志。

### 生产 stdio MCP

默认 Codex 适配器是已部署 Beautio 服务的薄客户端。它需要一个固定 HTTPS origin、一个仅包含 Action key 的受保护文件，以及一个供用户已选文件使用的绝对、受控本地目录：

```sh
export BEAUTIO_REMOTE_ORIGIN="https://beautio.example.com"
export BEAUTIO_ACTION_TOKEN_FILE="/absolute/private/path/beautio-action-token"
export BEAUTIO_MCP_UPLOAD_ROOT="$PWD/.local/confirmed-inputs"
node services/mcp-server/src/production-stdio.ts
```

token 文件必须是当前用户所有、非符号链接的普通文件，且模式为 `0600`。客户端固定了全部五个远程路由，拒绝重定向，不进行自动请求重试，应用 45 秒截止时间和 1 MiB 响应上限，并根据共享严格契约验证每个响应。它暴露现有四个工具以及 `set_product_display_image`；新工具只修改一个 Product 的共享受管图片，因此重新读取后，该 Product 的所有库存卡片会一起变化。

`upload_product_images` 仍会拒绝相对路径、URI、目录、设备、符号链接、路径遍历，以及位于 `BEAUTIO_MCP_UPLOAD_ROOT` 之外的文件。本地路径会在 HTTPS 上传前被删除，且从不进入远程数据库或成功输出。

生产 HTTP bridge 由 Action key 认证，但故意不出现在 GPT Actions OpenAPI 中。它将全部业务操作转发到与移动管理页面相同的服务器 `InventoryApplicationService`、Domain、Repository、SQLite 数据库和受管图片存储。

### 本地开发 stdio MCP

保留的开发适配器使用隔离的本地数据库和图片目录。在常规 Codex 配置中保持禁用，只在显式本地测试时启用：

```sh
mkdir -p .local/confirmed-inputs .local/managed-images
export BEAUTIO_DB_PATH="$PWD/.local/beautio-validation.sqlite"
export BEAUTIO_IMAGE_STORAGE_ROOT="$PWD/.local/managed-images"
export BEAUTIO_MCP_UPLOAD_ROOT="$PWD/.local/confirmed-inputs"
node services/mcp-server/src/stdio.ts
```

该开发入口保留原有的四工具本地 E2E，不会与生产环境同步 SQLite 或图片目录。

### GPT Actions HTTP

版本化 schema（当前 API 版本为 1.1）可从已配置的服务器上由 Action bearer key 访问：

```text
GET /openapi/beautio-actions-v1.json
```

它仅暴露：

```text
POST /api/actions/upload-product-images
POST /api/actions/create-inventory-batch
```

两者都需要 Action bearer key，并标记为 consequential。Action 文件下载需要 HTTPS 和已配置的可信源：普通白名单项为精确匹配，而显式的 `oaiusercontent.com` 根域也只接受其点边界子域。每次重定向都必须解析到公网 DNS 结果，最多重定向三次，每个文件限时 15 秒，整次上传限时 40 秒。短期上游文件 ID 和 URL 不会持久化。

在公网部署中，`BEAUTIO_PUBLIC_ORIGIN` 会把 Custom GPT 应调用的精确 HTTPS 服务器 URL 添加到 schema。省略该变量时，schema 保持本地测试形式，不包含 `servers` 项。

该仓库使用模拟上游文件传递来验证本地 Action 契约。它不声称公网域名、Custom GPT、TLS、DNS 或远程服务器部署已经上线。

## Admin HTTP 界面

只有健康检查是公开的。OpenAPI 文档、其中两个 GPT Action 写入和固定 Codex 自动化 bridge 需要 Action bearer key。库存、管理编辑、浏览器图片上传和私有图片读取需要独立的 Admin bearer key：

```text
GET  /api/health
GET  /api/inventory?as_of=YYYY-MM-DD
POST /api/admin/image-assets
PUT  /api/admin/products/:product_id
PUT  /api/admin/inventory-items/:inventory_item_id/facts
PUT  /api/admin/inventory-items/:inventory_item_id/custom-notes
GET  /api/image-assets/:image_asset_id/content
GET  /api/image-assets/:image_asset_id/content?variant=card
```

Codex 适配器路由是同一 Action-key scope 中的固定传输适配器；它们被故意排除在 GPT OpenAPI 之外：

```text
POST /api/actions/codex/record-product-opened
POST /api/actions/codex/get-inventory-item
POST /api/actions/codex/upload-product-images
POST /api/actions/codex/set-product-display-image
```

Action key 与 Admin key 不能交换使用。key 缺失、为空、相同、错误或超出作用域时，操作会失败，且不会产生数据库或文件系统副作用。

## 仅限本地的种子数据导入

要创建开发 fixture，请在已忽略的 `.local/` 下创建 JSON，然后显式导入：

```sh
pnpm import:local -- .local/example-inventory.json
```

```json
{
  "products": [
    {
      "id": "product-example",
      "name": "Example product",
      "category": "serum",
      "size_label": "30 ml",
      "image_ref": "/local-assets/product-example.webp"
    }
  ],
  "inventory_items": [
    {
      "id": "bottle-example-1",
      "product_id": "product-example",
      "lifecycle_status": "unopened",
      "opened_on": null,
      "opened_on_accuracy": null,
      "expires_on": "2027-01-01"
    }
  ]
}
```

导入功能仍然只是本地 fixture 辅助工具，不是 Agent 或 Admin API。它以追加且事务化的方式运行：标识符相同的数据保持不变，冲突标识符则中止操作，而不是覆盖数据。

## 开发基线

- Node.js 24
- pnpm 11
- TypeScript 严格模式

```sh
pnpm install
pnpm check
pnpm build
git diff --check
```

任何凭据、私有图片、库存数据库、备份、服务器配置或内部决策记录，都不应进入此公开仓库。

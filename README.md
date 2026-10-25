# dsh-session-user-id

给每条 DSH 会话分配一个**持久、唯一、随机**的 DeepSeek API `user_id`。

## 背景

DeepSeek API 的请求体支持 `user_id` 字段（`[a-zA-Z0-9\-_]+`，最长 512），用于内容安全隔离、KVCache 隔离、调度隔离。

官方明确要求：**不要在 `user_id` 中包含用户隐私信息** —— 所以本插件只用随机 UUID v4。

DSH 本身只有一个全局匿名 user id（`getOrCreateAnonymousUserId()`），没有会话概念。但 `deepseekLlmApiExtensions` 扩展点的 request 带 `sessionId`，而 provider 返回的 value 会 merge 成 request body 的顶层字段 —— 正好用来注入 `user_id`。

**不改 DSH 源码。**

## 行为

- 第一次见到某个 `sessionId` → 生成 UUID v4、写入映射文件、之后永久不变
- 没有 `sessionId` 的请求（例如某些内部调用）→ 不注入，保持默认
- compaction / session-title 等子请求沿用同一 `sessionId` ⇒ 同一个 `user_id`

## 映射文件

`$DSH_HOME/session-user-ids.json`

```json
{ "version": 1, "sessions": { "<sessionId>": "<uuid>" } }
```

写入用「先写临时文件再 rename」的原子方式，避免半截文件。

## 权衡

`user_id` 隔离 = **每条会话独立的 KVCache**。

会话之间不再共享缓存，共同前缀（system prompt、人设）要重新计算 → 命中率可能下降、成本上升。这是隔离的代价，换来的是会话之间不互相污染。

## 安装

### ① 通过插件市场（推荐）

在 [awesome-dsh-plugin](https://awesome-dsh-plugin.com) 的目录里找到本插件，
或在 dsh 的 **插件 → 发现** 里搜索 `dsh-session-user-id`，点安装。

### ② 手动安装

任选一种，**不要两种同时用**：

**A. 复制 + 手写 insert（适合本地开发）**

1. 把本目录复制到 `$DSH_HOME/profiles/web/node_modules/dsh-session-user-id/`
2. 在 `$DSH_HOME/profiles/web/cordis.patch.yml` 加：

   ```yaml
   - insert:
       - id: session-user-id
         name: 'dsh-session-user-id'
   ```

3. 重启 dsh，或让 Loader 重载配置

**B. `dsh plugin add`（需要包已发布到 npm）**

```sh
dsh plugin --profile web add dsh-session-user-id
```

> ⚠ 用 B 之后，包名会进 `dsh.profile.bundles`，bundles 层会读本包自带的
> `cordis.patch.yml`；此时**不要**再做 A 的第 2 步 —— 同一个 id 会被插两次，
> DSH 启动会直接失败。

## 依赖

`deepseekLlmApiExtensions`（DSH ≥ 0.2.1 自带）

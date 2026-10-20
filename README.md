# dsh-onebot-qq-opsgate

> `dsh-onebot-qq` 的配套**工具守卫**插件：把 QQ 会话里不该出现的全局工具（`ops_*`、agent-team、MCP 资源等）挡掉。
> 纯 JS、无外部依赖，Linux / Windows / macOS 通用。

不装也能正常聊天，只是 QQ 线会看到更多本不该有的主机工具（也费 token）。

## 安装

前提：已经装好 `dsh-onebot-qq`。

```bash
# GitHub
dsh plugin --profile web add github:YUsaltyfish/dsh-onebot-qq-opsgate

# 本地目录（改代码立刻生效）
dsh plugin --profile web add link:/abs/path/dsh-onebot-qq-opsgate
```

**顺序很重要**：本插件必须在 profile bundles 里排在 `dsh-onebot-qq` **之后**（后层覆盖前层，手工调过顺序的记得检查）。

重启 DSH 后，QQ 线**新建会话**生效。

## 验证

开一个 QQ 新会话，让它尝试 `ops_bash` / `spawn_teammate` 之类的工具 —— 它应该不知道这些工具存在。

## 说明

- 只影响 `qq-chat` preset 的 QQ 会话，不碰网页 / 工作线 / 其他 preset；
- **自动模式（默认）**：探测 DSH 当前所有全局工具，只放行 `mcp__qq__*`（及 `web_search` / `web_fetch`，如果它们是全局的），其余全挡 —— 不需要维护名单，新装的全局插件也会被挡住；
- 启动后每 500ms 复查一次，持续几秒补挡晚注册的工具，之后停止；
- `dsh-onebot-qq` 升级 preset 后，跑一次 `npm run sync:preset` 同步本插件里的 preset 副本；
- 卸载即恢复原状。

## 配置（一般不用改）

默认 auto 模式即可。要调整放行规则，在 profile 的 `cordis.patch.yml` 里覆盖 `preset-qq-chat`（整段替换）时给本插件加 config：

```yaml
- id: dsh-onebot-qq-opsgate
  name: 'dsh-onebot-qq-opsgate'
  config:
    allowedPrefixes: ['mcp__qq__', 'my_tool_']   # 按前缀放行
    keep: ['web_search', 'web_fetch']             # 精确放行
    # retryMs: 500        # 复查间隔
    # settleRounds: 8     # 连续几轮没新工具就停（默认 ~4 秒）
    # maxMs: 30000        # 最长运行时间
```

仍兼容旧配置：显式写 `deny: [...]` 或 `allow: [...]` 会退回固定名单模式。

## License

[MIT](LICENSE)

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
- 全局工具是异步注册的：插件先挡已注册的，未注册的每 500ms 重试（最多 90 秒）；
- 默认拦截名单在 `lib/gate.js` 的 `DEFAULT_DENY`，可在 preset 配置里覆盖；
- `dsh-onebot-qq` 升级 preset 后，跑一次 `npm run sync:preset` 同步本插件里的 preset 副本；
- 卸载即恢复原状。

## License

[MIT](LICENSE)

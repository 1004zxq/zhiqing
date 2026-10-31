# 枝下青云同步

这是单用户、端到端加密的 Cloudflare Worker 后端。

- 网页把完整数据加密后再上传。
- D1 只保存密文、随机 IV、版本号和同步时间，不保存日记明文。
- 同一个同步密钥可以在手机和电脑之间搬运数据。
- 网络断开时前端继续保存在本机，联网后再补上传。

## 部署

需要先登录一个 Cloudflare 账号：

```powershell
npm.cmd install
npx.cmd wrangler login
```

登录后创建 D1 数据库：

```powershell
npx.cmd wrangler d1 create zhiqing-sync
```

把输出里的 `database_id` 填进 `wrangler.jsonc`，执行迁移：

```powershell
npm.cmd run db:local
npx.cmd wrangler d1 execute zhiqing-sync --remote --file=migrations/0001_init.sql
```

设置同步密钥的 SHA-256 哈希，不要直接保存在仓库里：

```powershell
npx.cmd wrangler secret put SYNC_TOKEN_HASH
```

最后部署：

```powershell
npm.cmd run deploy
```

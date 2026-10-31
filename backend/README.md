# 后端目录

- `tencent-cloudbase/`：当前线上使用的腾讯云 CloudBase 后端。
- `cloudflare/`：最初的 Cloudflare 后端版本，保留作另一种部署方式。

两套后端都只保存客户端加密后的密文、随机 IV、版本号和同步时间，不保存日记明文。

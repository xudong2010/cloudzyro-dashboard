# 我的服务看板

一个给 Cloudzyro 免费 Launch 档做的单页状态看板：服务巡检 + AI 额度快照 + 快捷入口。

- 纯 Node.js，零依赖，无构建步骤，无数据库（状态存内存 + `data/state.json`）。
- 每 60 秒巡检一次，8 秒超时；任意 HTTP 响应即判为存活，只有超时 / DNS 失败 / 连接失败才判异常。
- 密钥只走环境变量（`TOKENLAB_API_KEY`、`GITHUB_READ_TOKEN`），服务端专用，
  绝不发给浏览器；仓库里没有任何密钥。
- 手机优先，中文界面，每 60 秒自动刷新。

运行：`npm start`（默认 `:3000`，平台注入 `PORT` 时自动用平台端口）。
接口：`GET /api/status`（看板数据）、`GET /api/health`（存活检查）。

部署见 [DEPLOY.md](./DEPLOY.md)。

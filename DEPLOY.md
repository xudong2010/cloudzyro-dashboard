# 部署到 Cloudzyro Launch（免费档）

目标：把这个看板放到 Cloudzyro 免费 Launch 档上，得到一个 `https://<名字>.cloudzyro.app` 地址。

## 前置条件

- 一个 Cloudzyro 账号（邮箱 / Google / GitHub 登录均可，**不用绑卡**）。
- 本项目不含任何密钥：TokenLab Key、GitHub 只读令牌都只走环境变量，
  不在代码和仓库里出现。

## 方式一：ZIP 上传（最快，不用建仓库）

1. 在本机把项目打成 zip，**排除 `node_modules/`**（本项目零依赖，
   实际上没有 `node_modules`；如果以后加了依赖，记得排除）：
   ```bash
   cd ~/workspace/cloudzyro-dashboard
   zip -r dashboard.zip . -x "node_modules/*" -x "data/state.json" -x ".git/*"
   ```
2. 打开 Cloudzyro 控制台 → 新建站点 → 选择 Launch（免费）→ 上传 zip。
3. 启动命令就是 `npm start`（即 `node server.js`），端口由平台注入
   的 `PORT` 环境变量决定，代码已处理，不用改。
4. （可选）想让看板显示 TokenLab 实时状态和 Muse 用量：
   控制台 → 站点 → 环境变量，加两条：
   - `TOKENLAB_API_KEY` = 你的 TokenLab Key（只在服务端用，绝不发给浏览器）
   - `GITHUB_READ_TOKEN` = 只读令牌（仅 `muse-usage-widget` 仓库的读权限）
   不加也可以，看板会显示静态快照和仓库链接。
5. 保存后等构建完成，访问分配的 `https://<名字>.cloudzyro.app` 即可。

## 方式二：连接 GitHub 自动部署

1. 在 GitHub 新建一个**私有**仓库（例如 `cloudzyro-dashboard`），把本项目
   推上去（不要推 `.env`，本项目本来就没有）。
2. Cloudzyro 控制台 → 新建站点 → 连接 GitHub → 选这个仓库 → 选 Launch。
3. 环境变量同方式一第 4 步，按需添加。
4. 以后改代码 push 到仓库即自动重新部署。

## 注意事项

- **Launch 档会休眠**：Node 应用 1 小时无访问就休息，访问时几秒唤醒；
  只有静态站才真正不睡。休眠期间后台巡检也会停，醒来后恢复。
  接受“打开才醒”，或用免费的外部 ping 服务（如 UptimeRobot 每 5 分钟
  ping 一次）保活；永不休眠要 Boost（$20/月/站点），没必要。
- **规格**：512MB 内存、1 核、每月 100GB 流量。看板是零依赖单进程，
  内存占用只有几十 MB，够用。流量超了只降速到 2Mbps，不下线、不收费。
- **只跑 Node.js**：这个项目本身就是纯 Node，没有 Python/Docker/系统服务，
  符合 Launch 的限制。
- **不要把密钥写进代码或提交到仓库**：Key 只放 Cloudzyro 控制台的环境变量里。

## 本地运行（测试用）

```bash
npm install   # 零依赖，装了个寂寞，但能验证 package.json 没问题
npm start     # 默认 http://localhost:3000
curl http://localhost:3000/api/status | python3 -m json.tool
```

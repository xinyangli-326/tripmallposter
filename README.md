# TripMALL 商品海报生成器（静态版 · 阿里云部署）

## 结构
- index.html：生成器页面（读 data/products.json，图片用 data/images/<id>.jpg）
- logo.png / qr.png：顶部横幅 + 二维码
- data/：后台数据（由 ingest 生成）

## 一、烤制后台数据（仅站长，需服务市场登录态）
在本机（已登录服务市场的那台）运行一次：
    node ingest.mjs
会生成 site/data/products.json 和 site/data/images/*.jpg（449 个商品，可断点续跑）。
> 说明：数据来自携程服务市场，需要你的账号登录才能抓；这一步只在你这侧跑，最终用户不接触。

## 二、部署到阿里云 ECS
方式 A：Docker（推荐）
    docker build -t tripmall .
    docker run -d -p 80:80 --name tripmall tripmall
方式 B：Nginx 静态
    把 site/ 里的 index.html、logo.png、qr.png、data/ 放到 /usr/share/nginx/html/（或用本文件 nginx.conf 作站点配置）。

## 三、对外访问
- 访问 http://<ECS公网IP或域名>/ 即可，填商品ID出图。
- 建议配置 HTTPS：在阿里云申请 SSL 证书，用 Nginx/SLB 配 443 反向代理。
- 如需自定义域名：在阿里云备案 + 解析 A 记录到 ECS 公网IP。

## 四、更新数据
重新在本机跑 node ingest.mjs（它会增量更新 data/），然后把 site/data/ 重新上传/重建镜像即可。

## 五、部署到 Vercel（免费）
1. 把本仓库推送到 GitHub（上方已初始化本地 Git）。
2. 登录 vercel.com → Add New… → Project → 选择该 GitHub 仓库 → Import。
3. Framework Preset 选「Other」，Build Command 留空，Output Directory 留空 → Deploy。
4. 完成后得到 https://<项目名>.vercel.app，自带 HTTPS。
5. 绑定自定义域名（可选，免费）：Vercel → 项目 → Settings → Domains → 添加你的域名并备案解析。
6. 更新数据：重跑 node ingest.mjs 生成新 data/，git push 后 Vercel 自动重新部署。

// TripMALL 数据更新器：扫描新品 + 刷新价格 + 生成变动报表 + 推送
// 用法：node tools/update.mjs  （由 检查更新.bat 调用）
// 依赖本机已登录的调试 Edge（端口 9333，profile: _edgeprofile）

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const PORT = 9333;                 // 调试 Edge
const PROGRESS_PORT = 8790;        // 本地进度服务（网页轮询这个）
const NEW_RANGE = Number(process.env.NEW_RANGE || 5000);   // 每次往后探测多少号
const CONC = 5;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const DB_PATH = path.join(ROOT, "data", "products.json");   // 站点实际加载的数据文件
const SP_PATH = path.join(ROOT, "data", "specs.json");
const META_PATH = path.join(ROOT, "data", "update-meta.json");
const TOKEN_PATH = path.join(ROOT, "_ghtoken.txt");

const progress = {
  state: "starting", phase: "", done: 0, total: 0,
  newProducts: 0, priceUp: 0, priceDown: 0, priceSame: 0,
  startedAt: Date.now(), finishedAt: null, message: "准备中…", error: "",
};
function setP(patch) { Object.assign(progress, patch); }

http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(progress));
}).listen(PROGRESS_PORT, "127.0.0.1", () => {
  console.log("进度服务已启动: http://127.0.0.1:" + PROGRESS_PORT + "/");
});

function makeClient(ws) {
  let id = 0; const p = new Map();
  ws.addEventListener("message", ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); }
  });
  return (me, pa = {}) => new Promise((res, rej) => {
    const i = ++id;
    p.set(i, m => m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result));
    ws.send(JSON.stringify({ id: i, method: me, params: pa }));
  });
}
const PARSE = `(t)=>{
  if(!t||t.indexOf('<code>200</code>')<0) return null;
  const nm=((t.match(/<name>([^<]*)<\\/name>/)||[])[1]||'').trim();
  if(!nm) return null;
  const cat=(t.match(/<category>([\\s\\S]*?)<\\/category>/)||[])[1]||'';
  const names=[...cat.matchAll(/<typeName>([^<]*)<\\/typeName>/g)].map(m=>m[1]).filter(Boolean);
  const props=[...t.matchAll(/<productPropertyList>([\\s\\S]*?)<\\/productPropertyList>/g)].map(m=>{
    const b=m[1]||'';
    const n=(b.match(/<propertyName>([^<]*)<\\/propertyName>/)||[])[1]||'';
    const v=(b.match(/<value>([^<]*)<\\/value>/)||[])[1]||'';
    return [n.trim(), v.trim()];
  }).filter(x=>x[0]);
  const pk=[...t.matchAll(/<packages>([\\s\\S]*?)<\\/packages>/g)].map(m=>{
    const b=m[1]||''; if(b.indexOf('<packageId>')<0) return null;
    const n=(b.match(/<name>([^<]*)<\\/name>/)||[])[1]||'';
    const p=(b.match(/<price>([^<]*)<\\/price>/)||[])[1]||'';
    const cp=(b.match(/<couponPrice>([^<]*)<\\/couponPrice>/)||[])[1]||'';
    const pic=(b.match(/<pic>([^<]*)<\\/pic>/)||[])[1]||'';
    return {n:n.trim(), p:p.replace(/[^0-9.]/g,''), cp:cp.replace(/[^0-9.]/g,''), pic, tr:''};
  }).filter(Boolean);
  const imgs=[...t.matchAll(/<url>([^<]*(?:dimg|\\.jpg|\\.png|\\.webp)[^<]*)<\\/url>/g)].map(m=>m[1]);
  const img=imgs.find(u=>/dimg/.test(u))||imgs[0]||(pk[0]&&pk[0].pic)||'';
  const sup=((t.match(/<supplierName>([^<]*)<\\/supplierName>/)||[])[1]||'').trim();
  const sales=((t.match(/<sales>([^<]*)<\\/sales>/)||[])[1]||'').replace(/[^0-9]/g,'');
  const LOW=/拿样|样品|试用|一分|样|免费/;
  const valid=pk.filter(x=>!LOW.test(x.n)).map(x=>parseFloat(x.p)).filter(n=>isFinite(n)&&n>0);
  const all=pk.map(x=>parseFloat(x.p)).filter(n=>isFinite(n)&&n>0);
  const use=valid.length?valid:all;
  return {n:nm, c:names, p:props, pk, s:((t.match(/<summary>([^<]*)<\\/summary>/)||[])[1]||'').trim(), img, sup, sales, price:use.length?String(Math.min.apply(null,use)):''};
}`;

async function waitPort(url, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(url); if (r.ok) return true; } catch { }
    await sleep(500);
  }
  return false;
}

async function ensureEdge() {
  if (await waitPort(`http://127.0.0.1:${PORT}/json/version`, 1500)) return true;
  setP({ state: "starting", message: "正在启动浏览器…" });
  const prof = "C:\\Users\\yuri0618\\Documents\\Codex\\2026-08-22\\zhe\\work\\browser-scrape\\_edgeprofile";
  const exe = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  try {
    spawn(exe, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, "--no-first-run", "--no-default-browser-check",
      "--disable-blink-features=AutomationControlled", "https://ebooking.ctrip.com/hmall/list"], { detached: true, stdio: "ignore" }).unref();
  } catch (e) { setP({ error: "启动浏览器失败：" + e.message }); }
  return await waitPort(`http://127.0.0.1:${PORT}/json/version`, 40000);
}

async function main() {
  const db = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  const specs = JSON.parse(fs.readFileSync(SP_PATH, "utf8"));

  const ok = await ensureEdge();
  if (!ok) { setP({ state: "error", message: "浏览器未能启动，请手动双击 start.bat 后再运行", error: "EDGE_NOT_READY" }); return; }

  const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json());
  const page = list.filter(t => t.type === "page" && /ebooking|hmall/.test(t.url))[0] || list.find(t => t.type === "page");
  if (!page) { setP({ state: "error", message: "找不到可用页面" }); return; }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", () => rej(new Error("ws"))); });
  const call = makeClient(ws);
  await call("Runtime.enable");
  const ev = async (expr, awaitP = true) => {
    const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: awaitP });
    if (r.exceptionDetails) throw new Error("eval " + (r.exceptionDetails.text || "").slice(0, 60));
    return r.result && r.result.value;
  };
  await ev("location.href='https://ebooking.ctrip.com/hmall/list'", false);
  await sleep(7000);
  const url = await ev("location.href");
  if (/login/i.test(url)) { setP({ state: "error", message: "登录已过期：请在浏览器窗口里登录一次，再重新运行", error: "NEED_LOGIN" }); ws.close(); return; }
  await ev("window.__p=" + PARSE, false);

  const fetchOne = async (id) => {
    for (let a = 0; a < 3; a++) {
      try {
        const v = await ev(`(async()=>{try{
          const ctl=new AbortController();const to=setTimeout(()=>ctl.abort(),15000);
          const r=await fetch('/hmall/api/product/getProduct',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({productId:'${id}',country:1,province:null,city:22249,district:null,subDistrict:null,latitude:31.225599,longitude:121.36413}),signal:ctl.signal});
          clearTimeout(to);const t=await r.text();return window.__p(t);}catch(e){return null;}})()`);
        if (v && v.n) return v;
      } catch { }
      await sleep(400);
    }
    return null;
  };

  // ===== 阶段1：扫描新品 =====
  const nums = Object.keys(db).map(Number).filter(n => isFinite(n) && n > 0);
  const maxId = nums.length ? Math.max.apply(null, nums) : 0;
  const probeFrom = maxId + 1, probeTo = maxId + NEW_RANGE;
  setP({ phase: "newProducts", state: "running", done: 0, total: NEW_RANGE, message: `扫描新品号段 ${probeFrom}~${probeTo}…` });
  console.log(`阶段1：扫描新品 ${probeFrom}~${probeTo}`);
  let idx = 0, found = 0;
  const newIds = [];
  while (idx < NEW_RANGE) {
    const batch = [];
    for (let k = 0; k < CONC && idx < NEW_RANGE; k++, idx++) batch.push(probeFrom + idx);
    const rs = await Promise.all(batch.map(id => fetchOne(id)));
    rs.forEach((v, i) => {
      if (!v) return;
      const sid = String(batch[i]);
      if (db[sid]) return;
      db[sid] = { id: sid, name: v.n, price: v.price || "", unit: "", tags: [], type: "", supplier: v.sup || "", sales: v.sales || "", image: v.img || "" };
      specs[sid] = { n: v.n, c: v.c, p: v.p, pk: v.pk, s: v.s };
      newIds.push(sid);
      found++;
      console.log("  新品 " + sid + " | " + v.n.slice(0, 34) + " | ¥" + v.price);
    });
    setP({ done: idx, newProducts: found, message: `扫描新品 ${idx}/${NEW_RANGE}，已发现 ${found} 个` });
  }
  console.log("阶段1 完成，新增 " + found + " 个商品");

  // ===== 阶段2：刷新价格 =====
  const PRICE_LIMIT = Number(process.env.PRICE_LIMIT || 0);
  let ids = Object.keys(db);
  if (PRICE_LIMIT > 0) ids = ids.slice(0, PRICE_LIMIT);
  setP({ phase: "prices", done: 0, total: ids.length, message: "刷新价格…" });
  console.log("阶段2：刷新 " + ids.length + " 个商品的价格");
  let pIdx = 0, up = 0, down = 0, same = 0, fail = 0, done = 0;
  const changes = [];
  while (pIdx < ids.length) {
    const batch = ids.slice(pIdx, pIdx + CONC);
    pIdx += batch.length;
    const rs = await Promise.all(batch.map(id => fetchOne(id)));
    rs.forEach((v, i) => {
      const sid = batch[i];
      if (!v) { fail++; return; }
      const oldP = String((db[sid] && db[sid].price) || "");
      const newP = String(v.price || "");
      if (newP && oldP && newP !== oldP) {
        const a = parseFloat(oldP), b = parseFloat(newP);
        if (isFinite(a) && isFinite(b)) {
          if (b > a) { up++; changes.push({ id: sid, name: v.n, from: oldP, to: newP, dir: "up" }); }
          else if (b < a) { down++; changes.push({ id: sid, name: v.n, from: oldP, to: newP, dir: "down" }); }
          else same++;
        }
      } else same++;
      db[sid] = Object.assign({}, db[sid], {
        name: v.n, price: newP || oldP, image: v.img || (db[sid] && db[sid].image) || "",
        supplier: v.sup || (db[sid] && db[sid].supplier) || "", sales: v.sales || (db[sid] && db[sid].sales) || "",
      });
      specs[sid] = { n: v.n, c: v.c, p: v.p, pk: v.pk, s: v.s };
    });
    done += batch.length;
    if (done % 100 === 0 || done === ids.length) {
      setP({ done, priceUp: up, priceDown: down, priceSame: same, message: `刷新价格 ${done}/${ids.length}（涨价 ${up} / 降价 ${down}）` });
      console.log(`  价格刷新 ${done}/${ids.length} 涨价=${up} 降价=${down} 失败=${fail}`);
      fs.writeFileSync(DB_PATH, JSON.stringify(db));
      fs.writeFileSync(SP_PATH, JSON.stringify(specs));
    }
  }
  console.log(`阶段2 完成 涨价=${up} 降价=${down} 失败=${fail}`);

  // ===== 阶段3：写报表 + 推送 =====
  setP({ phase: "pushing", state: "running", message: "写入报表并推送…" });
  const meta = {
    updatedAt: new Date().toISOString(), updatedAtCN: new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }),
    totalProducts: Object.keys(db).length,
    newProducts: found, priceUp: up, priceDown: down, fail,
    newList: newIds.slice(0, 200),
    upList: changes.filter(c => c.dir === "up").slice(0, 200),
    downList: changes.filter(c => c.dir === "down").slice(0, 200),
  };
  fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 1));
  fs.writeFileSync(DB_PATH, JSON.stringify(db));
  fs.writeFileSync(SP_PATH, JSON.stringify(specs));

  let pushed = "未推送";
  try {
    const token = (process.env.GHTOKEN || (fs.existsSync(TOKEN_PATH) ? fs.readFileSync(TOKEN_PATH, "utf8").trim() : ""));
    if (!token) { pushed = "未找到 GitHub Token（请把 token 放进 _ghtoken.txt）"; }
    else {
      const owner = "xinyangli-326", repo = "tripmallposter";
      const base = "https://api.github.com/repos/" + owner + "/" + repo + "/contents/";
      const H = { "Authorization": "Bearer " + token, "Accept": "application/vnd.github+json", "Content-Type": "application/json" };
      const getSha = async (p) => { const r = await fetch(base + p.split("/").map(encodeURIComponent).join("/"), { headers: H }); return r.ok ? (await r.json()).sha : null; };
      const put = async (p, local, msg) => {
        const sha = await getSha(p);
        const body = { message: msg, content: fs.readFileSync(local).toString("base64") };
        if (sha) body.sha = sha;
        const r = await fetch(base + p.split("/").map(encodeURIComponent).join("/"), { method: "PUT", headers: H, body: JSON.stringify(body) });
        console.log("  推送 " + p + " -> " + r.status);
        return r.status;
      };
      const msg = `数据更新 ${meta.updatedAtCN}：新品${found} 涨价${up} 降价${down}`;
      await put("data/update-meta.json", META_PATH, msg);
      await put("data/products.json", DB_PATH, msg);
      await put("data/specs.json", SP_PATH, msg);
      pushed = "已推送，Vercel 正在自动部署";
    }
  } catch (e) { pushed = "推送失败：" + String(e.message).slice(0, 80); }

  setP({ state: "done", finishedAt: Date.now(), message: `更新完成：新品 ${found} 个，涨价 ${up} 个，降价 ${down} 个。${pushed}` });
  console.log("全部完成：新品 " + found + "，涨价 " + up + "，降价 " + down + "。" + pushed);
  await sleep(500);
  ws.close();
  setTimeout(() => process.exit(0), 1500);
}

main().catch(e => {
  setP({ state: "error", message: "出错：" + String(e.message).slice(0, 120), error: String(e.message).slice(0, 200) });
  console.log("ERR " + e.message);
});

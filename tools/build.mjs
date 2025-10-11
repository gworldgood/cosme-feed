import fs from "node:fs/promises";
import path from "node:path";
import fetch from "node-fetch";
import { parseStringPromise as parseXML } from "xml2js";

const BRAND_PATH = path.join(process.cwd(), "brands.json");
const OUT_PATH = path.join(process.cwd(), "docs/campaigns.json");

const catDict = ["リップ","チーク","アイメイク","スキンケア","ベースメイク","ネイル","ヘアケア"];
const iso = (d) => new Date(d).toISOString();
const nowISO = () => new Date().toISOString();

const normalizeTitle = (brand, raw) => {
  if (!raw) return `${brand}の最新情報`;
  let t = raw.replace(/\s+/g, " ").trim();
  t = t.replace(/【?(PR|広告|お知らせ|News)】?/gi, "").trim();
  if (/限定|先行|数量/i.test(t) && !t.startsWith("【限定】")) t = `【限定】${t}`;
  if (/新作|新色|新商品/i.test(t) && !t.startsWith("【新作】")) t = `【新作】${t}`;
  if (/発売|解禁|公開/i.test(t) && !t.startsWith("【発売】")) t = `【発売】${t}`;
  if (!t.startsWith(brand)) t = `${brand}：${t}`;
  return t;
};

const guessCategory = (brandHints, text) => {
  const all = new Set([...(brandHints||[]), ...catDict]);
  for (const k of all) { if (new RegExp(k, "i").test(text||"")) return k; }
  if (/lip|リップ/i.test(text||"")) return "リップ";
  if (/cheek|チーク/i.test(text||"")) return "チーク";
  if (/skin|スキンケア/i.test(text||"")) return "スキンケア";
  if (/eye|アイシャドウ|アイライナー|マスカラ/i.test(text||"")) return "アイメイク";
  return "スキンケア";
};

const summarizeJP = (txt) => {
  if (!txt) return "公式情報の要点をまとめました。";
  const s = txt.replace(/\s+/g, " ").trim();
  const i = s.indexOf("。");
  return i > 20 ? s.slice(0, i+1) : s.slice(0, 120);
};

const dedupe = (arr) => {
  const seen = new Set();
  return arr.filter(x => { const k = x.url; if (seen.has(k)) return false; seen.add(k); return true; });
};

async function fetchRSS(url) {
  const res = await fetch(url, { timeout: 20000 });
  if (!res.ok) throw new Error(`RSS ${url} ${res.status}`);
  const xml = await res.text();
  const parsed = await parseXML(xml, { explicitArray:false, ignoreAttrs:false });
  const items = parsed.rss?.channel?.item || parsed.feed?.entry || [];
  const arr = Array.isArray(items) ? items : [items];
  return arr.map(it => ({
    title: it.title?._ || it.title || "",
    link: it.link?.href || it.link || it.enclosure?.url || "",
    desc: it.description || it.summary || "",
    pubDate: it.pubDate || it.published || it.updated || nowISO()
  }));
}

const ytRSS = (chId) => `https://www.youtube.com/feeds/videos.xml?channel_id=${chId}`;

async function main() {
  const brands = JSON.parse(await fs.readFile(BRAND_PATH, "utf-8"));
  let all = [];

  for (const b of brands) {
    const brand = b.brand;
    const hints = b.categoryHints || [];
    const feedURLs = [ ...(b.rss||[]), ...(b.youtube||[]).map(ytRSS) ];

    for (const f of feedURLs) {
      try {
        const entries = await fetchRSS(f);
        for (const e of entries) {
          const url = e.link || ""; if (!url) continue;
          const title = normalizeTitle(brand, e.title);
          const category = guessCategory(hints, `${e.title} ${e.desc}`);
          const summary = summarizeJP(e.desc || e.title);
          all.push({
            id: (globalThis.crypto?.randomUUID?.() ?? (()=>Math.random().toString(36).slice(2)))(),
            brand,
            title,
            summary,
            publishedAt: iso(e.pubDate || nowISO()),
            category,
            sourceType: /youtube|youtu\\.be/i.test(url) ? "youtube" : "website",
            url,
            thumbnailURL: null
          });
        }
      } catch (err) {
        console.error("Feed error", brand, f, err.message);
      }
    }
  }

  const ninety = Date.now() - 90*24*60*60*1000;
  all = dedupe(all)
    .filter(x => new Date(x.publishedAt).getTime() >= ninety)
    .sort((a,b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  await fs.writeFile(OUT_PATH, JSON.stringify(all, null, 2), "utf-8");
  console.log("Wrote", OUT_PATH, all.length, "items");
}

main().catch(e => { console.error(e); process.exit(1); });

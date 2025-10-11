// tools/build.mjs
import fs from "node:fs/promises";
import path from "node:path";
import fetch from "node-fetch";
import { parseStringPromise as parseXML } from "xml2js";

const BRAND_PATH = path.join(process.cwd(), "brands.json");
const OUT_PATH = path.join(process.cwd(), "docs/campaigns.json");

const catDict = ["リップ","チーク","アイメイク","スキンケア","ベースメイク","ネイル","ヘアケア"];
const nowISO = () => new Date().toISOString();
const toISO = (d) => {
  const t = new Date(d);
  return isNaN(t.getTime()) ? nowISO() : t.toISOString();
};

// GoogleニュースRSS（フォールバック用）
const googleNewsRSS = (q) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=ja&gl=JP&ceid=JP:ja`;

// タイトル整形
const normalizeTitle = (brand, raw) => {
  if (!raw) return `${brand}の最新情報`;
  let t = String(raw).replace(/\s+/g, " ").trim();
  t = t.replace(/【?(PR|広告|お知らせ|News)】?/gi, "").trim();
  if (/限定|先行|数量/i.test(t) && !t.startsWith("【限定】")) t = `【限定】${t}`;
  if (/新作|新色|新商品/i.test(t) && !t.startsWith("【新作】")) t = `【新作】${t}`;
  if (/発売|解禁|公開/i.test(t) && !t.startsWith("【発売】")) t = `【発売】${t}`;
  if (!t.startsWith(brand)) t = `${brand}：${t}`;
  return t;
};

// カテゴリ推定
const guessCategory = (brandHints, text) => {
  const all = new Set([...(brandHints || []), ...catDict]);
  const s = String(text || "");
  for (const k of all) if (new RegExp(k, "i").test(s)) return k;
  if (/lip|リップ/i.test(s)) return "リップ";
  if (/cheek|チーク/i.test(s)) return "チーク";
  if (/skin|スキンケア/i.test(s)) return "スキンケア";
  if (/eye|アイシャドウ|アイライナー|マスカラ/i.test(s)) return "アイメイク";
  return "スキンケア";
};

// 要約
const summarizeJP = (txt) => {
  if (!txt) return "公式情報の要点をまとめました。";
  const s = String(txt).replace(/\s+/g, " ").trim();
  const i = s.indexOf("。");
  return i > 20 ? s.slice(0, i + 1) : s.slice(0, 120);
};

// RSS/Atomのlink取得
const pickLink = (it) => {
  const link = it.link;
  if (typeof link === "object") {
    if (Array.isArray(link)) {
      const alt = link.find((l) => l.rel === "alternate" && l.href);
      if (alt?.href) return alt.href;
      const firstHref = link.find((l) => l.href)?.href;
      if (firstHref) return firstHref;
    } else if (link?.href) {
      return link.href;
    }
  }
  if (typeof link === "string" && link) return link;
  if (it.enclosure?.url) return it.enclosure.url;
  return "";
};

// URL正規化＆重複排除
const normalizeUrl = (u) => {
  try {
    const url = new URL(u);
    url.hash = "";
    if (url.pathname !== "/" && url.pathname.endsWith("/")) {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }
    return url.toString();
  } catch {
    return u || "";
  }
};
const dedupeByUrl = (arr) => {
  const seen = new Set();
  return arr.filter((x) => {
    const k = normalizeUrl(x.url);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    x.url = k;
    return true;
  });
};

// HTTP GET with retry
async function httpGet(url, tries = 2) {
  let lastErr;
  const UA = "cosme-feed-builder/1.0 (+https://github.com/)";
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        timeout: 20000,
        headers: { "User-Agent": UA, "Accept": "*/*" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw lastErr;
}

async function fetchRSS(url) {
  const xml = await httpGet(url, 2);
  const parsed = await parseXML(xml, { explicitArray: false, ignoreAttrs: false });
  const items = parsed.rss?.channel?.item || parsed.feed?.entry || [];
  const arr = Array.isArray(items) ? items : [items];
  return arr.map((it) => {
    const title = it.title?._ || it.title || "";
    const link = pickLink(it) || "";
    const desc = it.description || it.summary || it.content?._ || "";
    const pub = it.pubDate || it.published || it.updated || nowISO();
    return { title, link, desc, pubDate: pub };
  });
}

const ytRSS = (chId) => `https://www.youtube.com/feeds/videos.xml?channel_id=${chId}`;

// UUID（fallback）
const safeUUID = () => {
  try { return crypto.randomUUID(); } // eslint-disable-line no-undef
  catch { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
};

async function main() {
  const brands = JSON.parse(await fs.readFile(BRAND_PATH, "utf-8"));
  let all = [];
  let totalFeeds = 0;
  let okFeeds = 0;

  for (const b of brands) {
    const brand = b.brand;
    const hints = b.categoryHints || [];

    // 公式RSS/YouTube + GoogleニュースRSS（必要に応じて）
    let feedURLs = [
      ...(b.rss || []),
      ...(b.youtube || []).map(ytRSS),
    ];
    if ((b.useGoogleNewsRSS ?? true) && feedURLs.length === 0) {
      const q = b.googleQuery || `${brand} 新作 OR 新商品 OR コスメ`;
      feedURLs.push(googleNewsRSS(q));
    }

    for (const f of feedURLs) {
      totalFeeds++;
      try {
        const entries = await fetchRSS(f);
        okFeeds++;
        for (const e of entries) {
          const url = e.link || "";
          if (!url) continue;
          const title = normalizeTitle(brand, e.title);
          const category = guessCategory(hints, `${e.title} ${e.desc}`);
          const summary = summarizeJP(e.desc || e.title);
          all.push({
            id: safeUUID(),
            brand,
            title,
            summary,
            publishedAt: toISO(e.pubDate || nowISO()),
            category,
            sourceType: /youtube|youtu\.be/i.test(url) ? "youtube" : "website",
            url,
            thumbnailURL: null,
          });
        }
      } catch (err) {
        console.error("Feed error:", brand, f, "-", err.message || String(err));
      }
    }
  }

  // 直近90日だけ & 未来日除外
  const now = Date.now();
  const ninety = now - 90 * 24 * 60 * 60 * 1000;
  all = all.filter((x) => {
    const t = new Date(x.publishedAt).getTime();
    return !isNaN(t) && t >= ninety && t <= now + 24 * 60 * 60 * 1000;
  });

  // 重複排除 & 新しい順
  all = dedupeByUrl(all).sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  // 0件ならフォールバック1件
  if (all.length === 0) {
    all = [{
      id: safeUUID(),
      brand: "テスト（feed未取得）",
      title: "【新作】フォールバック表示 — brands.json / Actionsログを確認してください",
      summary: "RSSの取得に失敗した可能性があります。URLやクエリ、権限を確認しましょう。",
      publishedAt: nowISO(),
      category: "スキンケア",
      sourceType: "website",
      url: "https://example.com/",
      thumbnailURL: null,
    }];
  }

  await fs.writeFile(OUT_PATH, JSON.stringify(all, null, 2), "utf-8");
  console.log("✅ Build finished:", `${all.length} items`, "| feeds:", `${okFeeds}/${totalFeeds}`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});

/**
 * 用 Google Places API 搜尋八德區附近的餐廳
 *
 * 使用方式：
 *   node scripts/fetch-restaurants.mjs
 *
 * 結果會存到 scripts/places-cache.json（原始 API 回傳）
 * 以及更新 src/data/restaurants.json（合併進現有資料）
 *
 * 有 cache 的話不會重複呼叫 API，要強制重新撈加 --force：
 *   node scripts/fetch-restaurants.mjs --force
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(__dirname, 'places-cache.json');
const DATA_FILE = path.join(__dirname, '..', 'src', 'data', 'restaurants.json');
const API_KEY = process.env.GOOGLE_MAPS_API_KEY || 'AIzaSyAQSkrYp-4i8rwj6g_atgi1-_1Lv3ZrJOU';
const FORCE = process.argv.includes('--force');

// 八德區中心座標
const BADE_CENTER = { lat: 24.9530, lng: 121.2850 };
const SEARCH_RADIUS = 2000; // 2km

// 搜尋關鍵字 - 各種類型
const SEARCH_QUERIES = [
  '餐廳',
  '早餐',
  '小吃',
  '麵',
  '飯',
  '火鍋',
  '咖啡',
  '飲料',
  '日式料理',
  '韓式料理',
];

async function searchPlaces(query, pageToken = null) {
  const params = new URLSearchParams({
    query: `${query} 八德區`,
    location: `${BADE_CENTER.lat},${BADE_CENTER.lng}`,
    radius: SEARCH_RADIUS.toString(),
    language: 'zh-TW',
    key: API_KEY,
  });
  if (pageToken) params.set('pagetoken', pageToken);

  const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?${params}`;
  const res = await fetch(url);
  const data = await res.json();

  if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    console.error(`API error for "${query}": ${data.status} - ${data.error_message || ''}`);
    return [];
  }

  let results = data.results || [];

  // 如果有下一頁，等 2 秒後再抓（Google 要求）
  if (data.next_page_token) {
    console.log(`  ↳ 有下一頁，等待 2 秒...`);
    await new Promise(r => setTimeout(r, 2000));
    const nextResults = await searchPlaces(query, data.next_page_token);
    results = results.concat(nextResults);
  }

  return results;
}

function guessCuisine(place) {
  const name = place.name || '';
  const types = (place.types || []).join(' ');
  const all = `${name} ${types}`.toLowerCase();

  if (/日式|壽司|拉麵|丼|すき|sushi|ramen|定食|居酒/.test(all)) return 'japanese';
  if (/韓式|韓國|石鍋|炸雞|bibimbap|korean/.test(all)) return 'korean';
  if (/越南|泰式|東南亞|河粉|pho|thai/.test(all)) return 'southeast_asian';
  if (/火鍋|涮涮|麻辣|hotpot/.test(all)) return 'hotpot';
  if (/咖啡|茶|飲料|手搖|嵐|星巴克|starbucks|cafe|coco/.test(all)) return 'beverage';
  if (/漢堡|披薩|義大利|burger|pizza|pasta|麥當勞|肯德基|subway/.test(all)) return 'western';
  if (/牛肉麵|水餃|包子|饅頭|中式/.test(all)) return 'chinese';
  if (/早餐|蛋餅|三明治|吐司|豆漿|美而美|晨間/.test(all)) return 'taiwanese';
  return 'taiwanese';
}

function guessCategory(place) {
  const name = place.name || '';
  const all = name.toLowerCase();
  const cats = [];

  if (/早餐|早午|brunch|蛋餅|吐司|豆漿|晨間|美而美/.test(all)) cats.push('breakfast');
  if (/午餐|定食|飯|麵|便當/.test(all)) cats.push('lunch');
  if (/晚餐|餐廳|火鍋|燒烤|居酒/.test(all)) cats.push('dinner');
  if (/小吃|滷|鹹酥|蚵仔|夜市|雞排/.test(all)) cats.push('snacks');
  if (/飲料|茶|咖啡|手搖|嵐/.test(all)) cats.push('snacks');

  // Default
  if (cats.length === 0) cats.push('lunch', 'dinner');
  return cats;
}

function guessPriceRange(place) {
  if (place.price_level === undefined || place.price_level === null) return 1;
  if (place.price_level <= 1) return 1;
  if (place.price_level <= 2) return 2;
  return 3;
}

function calcWalkingMinutes(place) {
  if (!place.geometry?.location) return 15;
  const lat = place.geometry.location.lat;
  const lng = place.geometry.location.lng;
  // 粗估：每 0.001 度 ≈ 111m，步行速度 ≈ 80m/min
  const dist = Math.sqrt(
    Math.pow((lat - BADE_CENTER.lat) * 111000, 2) +
    Math.pow((lng - BADE_CENTER.lng) * 111000 * Math.cos(BADE_CENTER.lat * Math.PI / 180), 2)
  );
  return Math.max(1, Math.round(dist / 80));
}

function guessLandmark(place) {
  const addr = place.formatted_address || place.vicinity || '';
  if (/廣豐|廣福/.test(addr)) return 'guangfeng';
  if (/大湳|大安/.test(addr)) return 'danan';
  if (/義勇/.test(addr)) return 'yiyong';
  return 'other';
}

function toId(name) {
  return name
    .replace(/[^\w\u4e00-\u9fff]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .slice(0, 40);
}

function transformPlace(place) {
  return {
    id: place.place_id || toId(place.name),
    name: place.name,
    category: guessCategory(place),
    cuisine: guessCuisine(place),
    priceRange: guessPriceRange(place),
    rating: place.rating || 0,
    reviewCount: place.user_ratings_total || 0,
    address: place.formatted_address || '',
    googleMapsUrl: `https://maps.google.com/?q=${encodeURIComponent(place.name + ' ' + (place.formatted_address || ''))}`,
    landmark: guessLandmark(place),
    walkingMinutes: calcWalkingMinutes(place),
    tags: [],
    hours: '',
    image: null,
    dishes: [],
    lat: place.geometry?.location?.lat || 0,
    lng: place.geometry?.location?.lng || 0,
    placeId: place.place_id || null,
  };
}

async function main() {
  // Check cache
  if (!FORCE && fs.existsSync(CACHE_FILE)) {
    console.log('📦 使用 cache（加 --force 重新撈）');
    console.log(`   cache 位置: ${CACHE_FILE}`);
    const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    console.log(`   共 ${cached.length} 筆資料`);
    mergeIntoData(cached.map(transformPlace));
    return;
  }

  console.log('🔍 開始搜尋八德區美食...\n');

  const allPlaces = new Map(); // place_id -> place, deduplicate

  for (const query of SEARCH_QUERIES) {
    console.log(`搜尋: "${query} 八德區"...`);
    const results = await searchPlaces(query);
    console.log(`  找到 ${results.length} 筆`);

    for (const place of results) {
      if (place.place_id && !allPlaces.has(place.place_id)) {
        allPlaces.set(place.place_id, place);
      }
    }

    // 避免 API rate limit
    await new Promise(r => setTimeout(r, 500));
  }

  const allResults = Array.from(allPlaces.values());
  console.log(`\n✅ 總共找到 ${allResults.length} 間不重複店家`);

  // Save raw cache
  fs.writeFileSync(CACHE_FILE, JSON.stringify(allResults, null, 2), 'utf-8');
  console.log(`💾 原始資料已存到: ${CACHE_FILE}`);

  // Transform and merge
  const transformed = allResults
    .filter(p => p.rating >= 3.5 && p.user_ratings_total >= 10)
    .map(transformPlace)
    .sort((a, b) => b.rating - a.rating);

  console.log(`⭐ 篩選 3.5 星以上且 10 則評價以上: ${transformed.length} 間`);

  mergeIntoData(transformed);
}

function mergeIntoData(newRestaurants) {
  // Read existing data
  const existing = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  const existingIds = new Set(existing.restaurants.map(r => r.id));

  let added = 0;
  for (const r of newRestaurants) {
    // 用 placeId 或 name 判斷是否已存在
    const nameExists = existing.restaurants.some(
      e => e.name === r.name || e.id === r.id || e.placeId === r.placeId
    );
    if (!nameExists) {
      existing.restaurants.push(r);
      added++;
    }
  }

  existing.lastUpdated = new Date().toISOString().split('T')[0];

  fs.writeFileSync(DATA_FILE, JSON.stringify(existing, null, 2), 'utf-8');
  console.log(`\n📝 已更新 ${DATA_FILE}`);
  console.log(`   新增 ${added} 間，總共 ${existing.restaurants.length} 間`);
}

main().catch(console.error);

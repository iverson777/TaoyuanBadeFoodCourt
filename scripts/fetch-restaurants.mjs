/**
 * 用 Google Places API 搜尋八德區附近的真實餐廳
 * 自動下載 Google Maps 照片存到 public/images/
 *
 * 使用方式：
 *   node scripts/fetch-restaurants.mjs
 *
 * 有 cache 不會重複呼叫 API，要強制重新撈：
 *   node scripts/fetch-restaurants.mjs --force
 *
 * 只重新下載照片（不重新搜尋）：
 *   node scripts/fetch-restaurants.mjs --photos-only
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(__dirname, 'places-cache.json');
const DATA_FILE = path.join(__dirname, '..', 'src', 'data', 'restaurants.json');
const IMAGES_DIR = path.join(__dirname, '..', 'public', 'images');
const API_KEY = process.env.GOOGLE_MAPS_API_KEY || 'AIzaSyAQSkrYp-4i8rwj6g_atgi1-_1Lv3ZrJOU';
const FORCE = process.argv.includes('--force');
const PHOTOS_ONLY = process.argv.includes('--photos-only');

// 八德區中心座標
const BADE_CENTER = { lat: 24.9530, lng: 121.2850 };
const SEARCH_RADIUS = 2000; // 2km

// 搜尋關鍵字
const SEARCH_QUERIES = [
  '餐廳 八德區',
  '早餐 八德區',
  '小吃 八德區',
  '麵 八德區',
  '便當 八德區',
  '火鍋 八德區',
  '咖啡 八德區',
  '飲料 八德區',
  '日式料理 八德區',
  '韓式料理 八德區',
  '牛肉麵 八德區',
  '滷肉飯 八德區',
  '早午餐 八德區',
  '義大利麵 八德區',
  '炸雞 八德區',
];

// ==================== API 呼叫 ====================

async function searchPlaces(query, pageToken = null) {
  const params = new URLSearchParams({
    query,
    location: `${BADE_CENTER.lat},${BADE_CENTER.lng}`,
    radius: SEARCH_RADIUS.toString(),
    language: 'zh-TW',
    key: API_KEY,
  });
  if (pageToken) params.set('pagetoken', pageToken);

  const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?${params}`;
  console.log(`  → API 呼叫: ${query}${pageToken ? ' (下一頁)' : ''}`);
  const res = await fetch(url);
  const data = await res.json();

  if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    console.error(`  ✗ API 錯誤: ${data.status} - ${data.error_message || ''}`);
    return [];
  }

  let results = data.results || [];

  if (data.next_page_token) {
    console.log(`  ↳ 有下一頁，等待 2 秒...`);
    await new Promise(r => setTimeout(r, 2000));
    const nextResults = await searchPlaces(query, data.next_page_token);
    results = results.concat(nextResults);
  }

  return results;
}

async function getPlaceDetails(placeId) {
  const params = new URLSearchParams({
    place_id: placeId,
    fields: 'name,formatted_phone_number,opening_hours,website,price_level,photos',
    language: 'zh-TW',
    key: API_KEY,
  });
  const url = `https://maps.googleapis.com/maps/api/place/details/json?${params}`;
  const res = await fetch(url);
  const data = await res.json();
  return data.result || {};
}

async function downloadPhoto(photoReference, filename) {
  const url = `https://maps.googleapis.com/maps/api/place/photo?maxwidth=600&photo_reference=${photoReference}&key=${API_KEY}`;
  const res = await fetch(url);

  if (!res.ok) {
    console.log(`  ✗ 照片下載失敗: ${filename}`);
    return false;
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  const filepath = path.join(IMAGES_DIR, filename);
  fs.writeFileSync(filepath, buffer);
  return true;
}

// ==================== 資料轉換 ====================

function guessCuisine(place) {
  const name = (place.name || '').toLowerCase();
  const types = (place.types || []).join(' ');
  const all = `${name} ${types}`;

  if (/日式|壽司|拉麵|丼|すき|sushi|ramen|定食|居酒|日本|和食|烏龍/.test(all)) return 'japanese';
  if (/韓式|韓國|石鍋|bibimbap|korean|韓/.test(all)) return 'korean';
  if (/越南|泰式|東南亞|河粉|pho|thai|南洋/.test(all)) return 'southeast_asian';
  if (/火鍋|涮涮|麻辣|hotpot|鍋/.test(all)) return 'hotpot';
  if (/咖啡|茶|飲料|手搖|嵐|星巴克|starbucks|cafe|coco|清心|大苑|鮮茶道|可不可/.test(all)) return 'beverage';
  if (/漢堡|披薩|義大利|burger|pizza|pasta|麥當勞|肯德基|subway|摩斯|丹丹/.test(all)) return 'western';
  if (/牛肉麵|水餃|包子|饅頭|中式|川菜|湘菜|北京/.test(all)) return 'chinese';
  return 'taiwanese';
}

function guessCategory(place) {
  const name = (place.name || '').toLowerCase();
  const cats = [];

  if (/早餐|早午|brunch|蛋餅|吐司|豆漿|晨間|美而美|拉亞|q burger/.test(name)) cats.push('breakfast');
  if (/午|定食|飯|麵|便當|簡餐/.test(name)) cats.push('lunch');
  if (/晚|餐廳|火鍋|燒烤|居酒|牛排|義式/.test(name)) cats.push('dinner');
  if (/小吃|滷|鹹酥|蚵仔|夜市|雞排|炸|臭豆腐/.test(name)) cats.push('snacks');
  if (/飲料|茶|咖啡|手搖|嵐|冰/.test(name)) cats.push('snacks');

  if (cats.length === 0) cats.push('lunch', 'dinner');
  return [...new Set(cats)];
}

function calcWalkingMinutes(place) {
  if (!place.geometry?.location) return 15;
  const lat = place.geometry.location.lat;
  const lng = place.geometry.location.lng;
  const dist = Math.sqrt(
    Math.pow((lat - BADE_CENTER.lat) * 111000, 2) +
    Math.pow((lng - BADE_CENTER.lng) * 111000 * Math.cos(BADE_CENTER.lat * Math.PI / 180), 2)
  );
  return Math.max(1, Math.round(dist / 80));
}

function guessLandmark(place) {
  const addr = place.formatted_address || place.vicinity || '';
  if (/廣豐|廣福/.test(addr)) return 'guangfeng';
  if (/大湳/.test(addr)) return 'danan';
  if (/義勇/.test(addr)) return 'yiyong';
  return 'other';
}

function toSafeFilename(name) {
  return name
    .replace(/[^\w\u4e00-\u9fff]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30);
}

function transformPlace(place) {
  const id = toSafeFilename(place.name);
  const photoRef = place.photos?.[0]?.photo_reference || null;

  return {
    id: place.place_id,
    name: place.name,
    category: guessCategory(place),
    cuisine: guessCuisine(place),
    priceRange: Math.min(3, Math.max(1, (place.price_level || 0) + 1)),
    rating: place.rating || 0,
    reviewCount: place.user_ratings_total || 0,
    address: place.formatted_address || '',
    googleMapsUrl: `https://www.google.com/maps/place/?q=place_id:${place.place_id}`,
    landmark: guessLandmark(place),
    walkingMinutes: calcWalkingMinutes(place),
    tags: [],
    hours: '',
    image: photoRef ? `/TaoyuanBadeFoodCourt/images/${id}.jpg` : null,
    dishes: [],
    lat: place.geometry?.location?.lat || 0,
    lng: place.geometry?.location?.lng || 0,
    placeId: place.place_id,
    _photoRef: photoRef, // 暫存，下載照片用
  };
}

// ==================== 主程式 ====================

async function fetchAllPlaces() {
  if (!FORCE && fs.existsSync(CACHE_FILE)) {
    console.log('📦 使用 cache（加 --force 重新撈）');
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
  }

  console.log('🔍 開始搜尋八德區美食...\n');
  const allPlaces = new Map();

  for (const query of SEARCH_QUERIES) {
    console.log(`搜尋: "${query}"...`);
    try {
      const results = await searchPlaces(query);
      console.log(`  找到 ${results.length} 筆`);
      for (const place of results) {
        if (place.place_id && !allPlaces.has(place.place_id)) {
          allPlaces.set(place.place_id, place);
        }
      }
    } catch (err) {
      console.error(`  ✗ 錯誤: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }

  const allResults = Array.from(allPlaces.values());
  console.log(`\n✅ 總共找到 ${allResults.length} 間不重複店家`);

  // 存 cache
  fs.writeFileSync(CACHE_FILE, JSON.stringify(allResults, null, 2), 'utf-8');
  console.log(`💾 原始資料已存到: ${CACHE_FILE}`);
  console.log(`   下次執行會使用 cache，不會再呼叫 API`);
  console.log(`   要重新搜尋請加 --force\n`);

  return allResults;
}

async function downloadAllPhotos(restaurants) {
  if (!fs.existsSync(IMAGES_DIR)) {
    fs.mkdirSync(IMAGES_DIR, { recursive: true });
  }

  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const r of restaurants) {
    if (!r._photoRef) {
      skipped++;
      continue;
    }

    const filename = `${toSafeFilename(r.name)}.jpg`;
    const filepath = path.join(IMAGES_DIR, filename);

    // 已經下載過就跳過
    if (fs.existsSync(filepath)) {
      skipped++;
      continue;
    }

    console.log(`📷 下載: ${r.name}`);
    try {
      const ok = await downloadPhoto(r._photoRef, filename);
      if (ok) downloaded++;
      else failed++;
    } catch (err) {
      console.log(`  ✗ ${err.message}`);
      failed++;
    }

    // 避免 rate limit
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\n📸 照片下載完成: ${downloaded} 張新下載, ${skipped} 張已存在/無照片, ${failed} 張失敗`);
}

async function main() {
  console.log('=================================');
  console.log('  八德美食探索 - 餐廳資料更新工具');
  console.log('=================================\n');

  // Step 1: 取得所有餐廳原始資料
  const rawPlaces = await fetchAllPlaces();

  // Step 2: 篩選和轉換
  const restaurants = rawPlaces
    .filter(p => {
      // 只要八德區的
      const addr = p.formatted_address || '';
      if (!/八德/.test(addr) && !/桃園/.test(addr)) return false;
      // 至少 3.5 星 + 10 則評價
      if ((p.rating || 0) < 3.5) return false;
      if ((p.user_ratings_total || 0) < 10) return false;
      return true;
    })
    .map(transformPlace)
    .sort((a, b) => b.rating - a.rating);

  console.log(`⭐ 篩選後: ${restaurants.length} 間（3.5★ 以上, 10+ 評價, 八德/桃園區）\n`);

  // Step 3: 下載照片
  if (!PHOTOS_ONLY) {
    console.log('📷 開始下載餐廳照片...\n');
  }
  await downloadAllPhotos(restaurants);

  // Step 4: 清除暫存 _photoRef，寫入 restaurants.json
  const cleanRestaurants = restaurants.map(({ _photoRef, ...rest }) => rest);

  const output = {
    lastUpdated: new Date().toISOString().split('T')[0],
    restaurants: cleanRestaurants,
  };

  fs.writeFileSync(DATA_FILE, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`\n📝 已更新: ${DATA_FILE}`);
  console.log(`   共 ${cleanRestaurants.length} 間餐廳`);
  console.log(`   照片存在: ${IMAGES_DIR}\n`);

  // 統計
  const withPhotos = cleanRestaurants.filter(r => r.image).length;
  const cuisineCounts = {};
  cleanRestaurants.forEach(r => {
    cuisineCounts[r.cuisine] = (cuisineCounts[r.cuisine] || 0) + 1;
  });

  console.log('📊 統計:');
  console.log(`   有照片: ${withPhotos}/${cleanRestaurants.length}`);
  console.log('   料理類型:');
  Object.entries(cuisineCounts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log(`     ${k}: ${v}`));

  console.log('\n✅ 完成！執行 npm run dev 預覽網站');
  console.log('   照片和資料都已存在本地，不會再重複呼叫 API');
}

main().catch(err => {
  console.error('❌ 執行失敗:', err.message);
  process.exit(1);
});

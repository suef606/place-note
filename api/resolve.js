// place-note: 지도 공유 링크에서 장소 이름을 찾아 주는 Vercel 서버 기능
// 사용법: /api/resolve?url=<카카오맵·구글지도·네이버지도 링크>
// 돌려주는 값: { name, finalUrl, source } 또는 { error }

const ALLOWED_HOSTS = [
  // 카카오맵
  'kko.to', 'kakao.com', 'map.kakao.com', 'place.map.kakao.com', 'm.map.kakao.com',
  // 구글지도
  'maps.app.goo.gl', 'goo.gl', 'g.co', 'share.google', 'google.com', 'www.google.com', 'maps.google.com',
  'google.co.kr', 'www.google.co.kr', 'maps.google.co.kr',
  // 네이버지도
  'naver.me', 'map.naver.com', 'm.map.naver.com', 'place.naver.com', 'm.place.naver.com',
  'pcmap.place.naver.com', 'naver.com', 'www.naver.com',
];

const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

function isAllowed(u) {
  try {
    const { protocol, hostname } = new URL(u);
    if (protocol !== 'https:' && protocol !== 'http:') return false;
    return ALLOWED_HOSTS.some((h) => hostname === h || hostname.endsWith('.' + h));
  } catch {
    return false;
  }
}

function sourceOf(u) {
  const h = new URL(u).hostname;
  if (h.includes('kakao') || h === 'kko.to') return 'kakao';
  if (h.includes('naver')) return 'naver';
  return 'google';
}

// 허용된 주소로만 한 단계씩 따라가기 (최대 6번)
async function follow(url) {
  let current = url;
  for (let i = 0; i < 6; i++) {
    if (!isAllowed(current)) throw new Error('지원하지 않는 주소로 이동했어요');
    const res = await fetch(current, {
      redirect: 'manual',
      headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9' },
    });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      current = new URL(loc, current).toString();
      continue;
    }
    const html = res.ok ? (await res.text()).slice(0, 400000) : '';
    return { finalUrl: current, html };
  }
  throw new Error('이동이 너무 많아요');
}

async function getHtml(url) {
  if (!isAllowed(url)) return '';
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9' } });
    return res.ok ? (await res.text()).slice(0, 400000) : '';
  } catch {
    return '';
  }
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}

function metaTitle(html) {
  if (!html) return '';
  const og =
    html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
  if (og) return decodeEntities(og[1]);
  const t = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return t ? decodeEntities(t[1]) : '';
}

// "장소 · 주소", "장소 - Google 지도", "장소 : 네이버" 같은 꼬리 떼기
function clean(name) {
  return (name || '')
    .replace(/\s*[-|:·]\s*(Google|구글|카카오|Kakao|네이버|NAVER)[\s\S]*$/i, '')
    .replace(/\s*·\s.*$/, '')
    .replace(/\+/g, ' ')
    .trim();
}

const GENERIC = /^(google\s*(지도|maps)|카카오맵|kakao\s*map|네이버\s*지도|naver\s*map|네이버|naver)$/i;

function fromUrl(finalUrl) {
  const u = new URL(finalUrl);
  // 구글: /maps/place/장소이름/...
  let m = u.pathname.match(/\/maps\/place\/([^/]+)/);
  if (m) return decodeURIComponent(m[1]).replace(/\+/g, ' ');
  // 구글: ?q=장소이름
  const q = u.searchParams.get('q') || u.searchParams.get('query');
  if (q && !/^-?\d+(\.\d+)?,\s*-?\d+(\.\d+)?$/.test(q)) return q;
  // 카카오: /link/map/장소이름,위도,경도
  m = u.pathname.match(/\/link\/(?:map|to)\/([^,/]+)/);
  if (m) return decodeURIComponent(m[1]);
  return '';
}

async function kakaoById(finalUrl) {
  const m = finalUrl.match(/place\.map\.kakao\.com\/(?:m\/)?(\d+)/) || finalUrl.match(/[?&]itemId=(\d+)/);
  if (!m) return '';
  // 카카오맵 장소 페이지가 쓰는 정보 주소 (공식 API 아님 — 바뀌면 안 될 수 있음)
  for (const api of [`https://place.map.kakao.com/main/v/${m[1]}`, `https://place.map.kakao.com/m/main/v/${m[1]}`]) {
    try {
      const res = await fetch(api, { headers: { 'User-Agent': UA, Referer: `https://place.map.kakao.com/${m[1]}` } });
      if (!res.ok) continue;
      const j = await res.json();
      const n = j?.basicInfo?.placenamefull || j?.basicInfo?.placename;
      if (n) return n;
    } catch { /* 다음 방법으로 */ }
  }
  return '';
}

async function naverById(finalUrl) {
  const m = finalUrl.match(/place\/(\d+)/) || finalUrl.match(/[?&]id=(\d+)/);
  if (!m) return '';
  const html = await getHtml(`https://m.place.naver.com/place/${m[1]}/home`);
  return clean(metaTitle(html));
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const url = String((req.query && req.query.url) || '').trim();
  if (!url || url.length > 2000) return res.status(400).json({ error: '링크가 비어 있어요' });
  if (!isAllowed(url)) return res.status(400).json({ error: '카카오맵·구글지도·네이버지도 링크만 돼요' });

  try {
    const { finalUrl, html } = await follow(url);
    const source = sourceOf(finalUrl);

    let name = clean(fromUrl(finalUrl));
    if (!name && source === 'kakao') name = await kakaoById(finalUrl);
    if (!name && source === 'naver') name = await naverById(finalUrl);
    if (!name) name = clean(metaTitle(html));
    if (GENERIC.test(name)) name = '';

    if (!name) return res.status(404).json({ error: '장소 이름을 찾지 못했어요', finalUrl, source });
    return res.status(200).json({ name, finalUrl, source });
  } catch (e) {
    return res.status(502).json({ error: '링크를 열지 못했어요' });
  }
}

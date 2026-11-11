// 네이버 커머스API(스마트스토어) — PET TIMES 전용 상품 조회 클라이언트.
// 이 파일은 공개 저장소에 포함되지만, 실제로 동작하려면 서버 환경변수
// NAVER_COMMERCE_CLIENT_ID / NAVER_COMMERCE_CLIENT_SECRET 가 설정돼 있어야 한다.
// 다른 브랜드가 이 프로젝트를 복제해도 저 환경변수를 안 넣으면 그냥 버튼이 안 보일 뿐,
// 코드 자체에 특정 브랜드 정보는 들어있지 않다(조회 전용, 쓰기 API는 안 씀).
import bcrypt from "bcryptjs";

const BASE = "https://api.commerce.naver.com/external";

let cachedToken = null;
let cachedTokenExpiresAt = 0;

export function isNaverConfigured() {
  return !!(process.env.NAVER_COMMERCE_CLIENT_ID && process.env.NAVER_COMMERCE_CLIENT_SECRET);
}

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiresAt - 5 * 60 * 1000) return cachedToken;
  const clientId = process.env.NAVER_COMMERCE_CLIENT_ID;
  const clientSecret = process.env.NAVER_COMMERCE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("네이버 스마트스토어 연동이 설정되지 않은 서버예요.");

  const timestamp = Date.now();
  const password = `${clientId}_${timestamp}`;
  const hashed = bcrypt.hashSync(password, clientSecret);
  const sign = Buffer.from(hashed, "utf-8").toString("base64");
  const params = new URLSearchParams({
    client_id: clientId, timestamp: String(timestamp), client_secret_sign: sign,
    grant_type: "client_credentials", type: "SELF",
  });
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params.toString(),
  });
  if (!res.ok) throw new Error(`네이버 커머스API 토큰 발급 실패 (${res.status}): ${await res.text()}`);
  const json = await res.json();
  cachedToken = json.access_token;
  cachedTokenExpiresAt = Date.now() + json.expires_in * 1000;
  return cachedToken;
}

// 상품명으로 검색 — 조회 전용(판매가/재고 수정 등 쓰기 API는 호출하지 않음).
// ⚠️ 실제 응답 스키마는 "상품" 권한그룹이 승인된 뒤 라이브로 한 번 호출해서 확인 후
// 아래 매핑(mapSearchResult)을 맞춰야 한다 — 지금은 문서/추정 기반 초안.
export async function searchProducts(query, { page = 1, size = 20 } = {}) {
  const token = await getAccessToken();
  const res = await fetch(`${BASE}/v1/products/search`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ page, size, searchKeyword: query }),
  });
  if (!res.ok) throw new Error(`네이버 상품 조회 실패 (${res.status}): ${await res.text()}`);
  const json = await res.json();
  return mapSearchResult(json);
}

// 네이버가 돌려주는 원본 구조를 화면에서 바로 쓰기 좋은 평평한 배열로 변환.
// contents[].channelProducts[] 형태(옵션 없는 단일상품) + 옵션 있는 상품(optionCombinations 등)
// 둘 다 있을 수 있어서, 최대한 안전하게 옵션별로 1행씩 펼친다. 실제 필드명이 다르면
// 이 함수만 고치면 된다(호출부는 그대로).
function mapSearchResult(json) {
  const contents = json?.contents ?? json?.data?.contents ?? [];
  const rows = [];
  for (const item of contents) {
    const product = item.channelProducts?.[0] ?? item;
    const productNo = product.originProductNo ?? product.channelProductNo ?? product.productNo;
    const name = product.name ?? product.channelProductName ?? "(상품명 없음)";
    const options = product.optionCombinations ?? product.options ?? [];
    if (Array.isArray(options) && options.length > 0) {
      for (const opt of options) {
        rows.push({
          naverProductId: String(productNo),
          naverOptionId: String(opt.id ?? opt.optionId ?? opt.combinationNo ?? ""),
          name,
          optionName: opt.optionName1 ?? opt.name ?? opt.optionName ?? "",
          price: opt.price ?? opt.stockQuantity !== undefined ? opt.price : product.salePrice,
          stockQuantity: opt.stockQuantity ?? null,
        });
      }
    } else {
      rows.push({
        naverProductId: String(productNo),
        naverOptionId: "",
        name,
        optionName: "",
        price: product.salePrice ?? null,
        stockQuantity: product.stockQuantity ?? null,
      });
    }
  }
  return rows;
}

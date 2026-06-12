// 우리아이들 보육일지 AI — Claude API 프록시 v4
// 인증 방식: 수업 비밀번호 + 전화번호 (전화번호별 프로그램당 100회)
//
// 필요한 Vercel 환경변수 3개:
//   ANTHROPIC_API_KEY    : Claude API 키
//   SUPABASE_URL         : 예) https://xxxx.supabase.co
//   SUPABASE_SERVICE_KEY : Supabase service_role 키

const PAID_MSG = '이후 사용은 유료사용으로 가능합니다. 100회씩 충전 가능하며 영유아교육디자인연구소로 문의주세요!';

// ─── 전화번호 정리: 숫자만 남기고 형식 검사 ───
function normalizePhone(p) {
  const digits = String(p || '').replace(/\D/g, '');
  return /^01[016789]\d{7,8}$/.test(digits) ? digits : null;
}

// ─── Supabase RPC 호출 공통 ───
async function rpc(fnName, params) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/rpc/${fnName}`;
  const key = process.env.SUPABASE_SERVICE_KEY;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': key,
      'Authorization': `Bearer ${key}`
    },
    body: JSON.stringify(params)
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error('인증 서버 오류: ' + t.slice(0, 200));
  }
  return res.json();
}

// ─── 거절 사유 → 사용자 안내 문구 ───
function reasonMessage(reason) {
  switch (reason) {
    case 'invalid_password': return '수업 비밀번호가 올바르지 않습니다.';
    case 'class_full':       return '이 수업의 등록 인원이 가득 찼습니다. 연구소로 문의해 주세요.';
    case 'expired':          return '사용 기간이 만료되었습니다. 연구소로 문의해 주세요.';
    case 'exhausted':        return PAID_MSG;
    case 'blocked':          return '사용이 제한된 번호입니다. 연구소로 문의해 주세요.';
    case 'not_registered':   return '등록되지 않은 번호입니다. 수업 비밀번호와 함께 다시 등록해 주세요.';
    default:                 return '인증에 실패했습니다.';
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { messages, system, max_tokens, verify, password, phone, tool } = req.body;

    const cleanPhone = normalizePhone(phone);
    if (!cleanPhone) {
      return res.status(400).json({ ok: false, reason: 'invalid_phone', error: '휴대폰 번호를 정확히 입력해 주세요. (예: 010-1234-5678)' });
    }

    // ─── 1) 입장/등록 모드 ───
    if (verify) {
      let check;
      if (password) {
        // 첫 등록 또는 재입장: 비밀번호 + 전화번호
        check = await rpc('register_student', { p_password: String(password).trim(), p_phone: cleanPhone });
      } else {
        // 자동 로그인: 저장된 전화번호로 상태만 확인
        check = await rpc('use_student_quota', { p_phone: cleanPhone, p_tool: 'any', p_consume: false });
      }
      if (!check.ok) {
        return res.status(401).json({ ok: false, reason: check.reason, error: reasonMessage(check.reason) });
      }
      return res.status(200).json({
        ok: true,
        remaining_daily: check.remaining_daily,
        remaining_weekly: check.remaining_weekly
      });
    }

    // ─── 2) AI 분석 모드 (해당 프로그램 1회 차감) ───
    const cleanTool = (tool === 'daily' || tool === 'weekly') ? tool : null;
    if (!cleanTool) {
      return res.status(400).json({ error: '프로그램 구분(tool)이 필요합니다.' });
    }

    const check = await rpc('use_student_quota', { p_phone: cleanPhone, p_tool: cleanTool, p_consume: true });
    if (!check.ok) {
      return res.status(401).json({ ok: false, reason: check.reason, error: reasonMessage(check.reason) });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'API key not configured' });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'pdfs-2024-09-25'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: Math.min(Math.max(max_tokens || 1500, 4096), 8192),  // 응답 잘림 방지: 하한 4096
        system,
        messages
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.message || '서버 오류' });
    }

    return res.status(200).json({
      text: data.content?.[0]?.text || '',
      remaining_daily: check.remaining_daily,
      remaining_weekly: check.remaining_weekly
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ============================================================
//  LIFF Authentication Helper
//  ใช้ร่วมกันทุกหน้า — โหลดหลัง LIFF SDK เสมอ
//
//  ⚠️  แทน YOUR_LIFF_ID ด้วย LIFF ID จาก LINE Developers Console
//       https://developers.line.biz/console/
// ============================================================

const LIFF_ID = '2009490344-qTpHb2Gq'; // ← เปลี่ยนตรงนี้

const LiffAuth = {
  _profile: null,
  _token:   null,

  // ── init(): ใช้กับหน้าที่พนักงานทั่วไปเข้าได้ ─────────────
  async init() {
    try {
      await liff.init({ liffId: LIFF_ID });
    } catch (e) {
      _showAuthBlock('เริ่มต้น LIFF ไม่ได้: ' + e.message);
      return false;
    }

    if (!liff.isLoggedIn()) {
      // ส่งไปหน้า login แทนที่จะ popup ทันที — UX ดีกว่า
      window.location.replace('login.html');
      return false;
    }

    this._token   = liff.getAccessToken();
    this._profile = await liff.getProfile();
    return true;
  },

  // ── initAdmin(): ใช้กับหน้า Admin (register, config) ────────
  // ตรวจสิทธิ์ผ่าน Firestore admins collection
  async initAdmin() {
    const ok = await this.init();
    if (!ok) return false;

    try {
      const admin = await DB.isAdmin(this._profile.userId);
      if (!admin) {
        _showAuthBlockAdmin('คุณไม่มีสิทธิ์เข้าถึงหน้านี้', this._profile.userId);
        return false;
      }
    } catch (e) {
      _showAuthBlock('ตรวจสอบสิทธิ์ไม่ได้: ' + e.message);
      return false;
    }

    return true;
  },

  // ── Getters ─────────────────────────────────────────────────
  getToken()       { return this._token; },
  getProfile()     { return this._profile; },
  getUserId()      { return this._profile?.userId; },
  getDisplayName() { return this._profile?.displayName; },
  getPictureUrl()  { return this._profile?.pictureUrl; },

  // ── authBody(): แนบ token + userId เข้า POST body อัตโนมัติ ─
  // ใช้แทน JSON.stringify ใน fetch เพื่อไม่ต้องพิมพ์ซ้ำทุกที่
  // ตัวอย่าง: body: JSON.stringify(LiffAuth.authBody({ action:'logAttendance', name }))
  authBody(extra = {}) {
    return {
      lineToken:  this._token,
      lineUserId: this._profile?.userId,
      ...extra
    };
  }
};

// ── UI helper: แสดง user badge ในหน้าที่รองรับ ────────────────
// เรียกหลัง LiffAuth.init() หรือ LiffAuth.initAdmin() สำเร็จ
function renderUserBadge(containerId = 'userBadge') {
  const badge = document.getElementById(containerId);
  if (!badge) return;

  const profile = LiffAuth.getProfile();
  if (!profile) return;

  badge.innerHTML = `
    <img src="${profile.pictureUrl || ''}"
         style="width:28px;height:28px;border-radius:50%;
                border:1.5px solid rgba(99,102,241,0.45);
                object-fit:cover;flex-shrink:0"
         onerror="this.style.display='none'">
    <span style="font-size:0.78em;color:#94a3b8;
                 max-width:110px;overflow:hidden;
                 text-overflow:ellipsis;white-space:nowrap">
      ${_escHtml(profile.displayName || '')}
    </span>
  `;
  badge.style.display = 'flex';
}

// ── Private helpers ──────────────────────────────────────────

function _showAuthBlock(msg) {
  document.body.innerHTML = `
    <div style="
      display:flex; align-items:center; justify-content:center;
      min-height:100vh; font-family:'Sarabun',sans-serif;
      background:#07071a; flex-direction:column;
      gap:16px; padding:24px; text-align:center;
    ">
      <div style="font-size:52px">🔒</div>
      <div style="font-size:1.15em;font-weight:700;color:#fca5a5">${_escHtml(msg)}</div>
      <a href="index.html" style="
        color:#a5b4fc; font-size:0.9em; text-decoration:none;
        padding:10px 22px; border:1px solid rgba(165,180,252,0.3);
        border-radius:20px; margin-top:6px;
      ">← กลับหน้าหลัก</a>
    </div>`;
}

function _showAuthBlockAdmin(msg, userId) {
  document.body.innerHTML = `
    <div style="
      display:flex; align-items:center; justify-content:center;
      min-height:100vh; font-family:'Sarabun',sans-serif;
      background:#07071a; flex-direction:column;
      gap:16px; padding:24px; text-align:center;
    ">
      <div style="font-size:52px">🔒</div>
      <div style="font-size:1.15em;font-weight:700;color:#fca5a5">${_escHtml(msg)}</div>
      <div style="
        background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.12);
        border-radius:14px; padding:14px 20px; max-width:340px; word-break:break-all;
      ">
        <div style="font-size:0.72em;color:#64748b;margin-bottom:6px">LINE User ID ของคุณ</div>
        <div style="font-size:0.9em;color:#a5b4fc;font-weight:600">${_escHtml(userId || '-')}</div>
        <div style="font-size:0.72em;color:#475569;margin-top:8px">นำไปเพิ่มใน Firestore → admins collection</div>
      </div>
      <a href="index.html" style="
        color:#a5b4fc; font-size:0.9em; text-decoration:none;
        padding:10px 22px; border:1px solid rgba(165,180,252,0.3);
        border-radius:20px; margin-top:6px;
      ">← กลับหน้าหลัก</a>
    </div>`;
}

// XSS-safe: escape HTML ก่อนแทรกใน innerHTML
function _escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

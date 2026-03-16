// ============================================================
//  Firestore Database Layer
//  แทน GAS API ทั้งหมด — โหลดหลัง firebase-config.js เสมอ
//
//  โครงสร้างข้อมูลใน Firestore:
//    admins/{lineUserId}            → { role: 'admin' }
//    config/gps                     → { lat, lng, radius }
//    users/{docId}                  → { name, descriptor[], registeredBy, createdAt }
//    attendance/{docId}             → { name, lat, lng, lineUserId, date, time, timestamp }
// ============================================================

const DB = {
  _db: null,

  _init() {
    if (!this._db) this._db = firebase.firestore();
    return this._db;
  },

  // ── Admin ────────────────────────────────────────────────
  async isAdmin(lineUserId) {
    if (!lineUserId) return false;
    try {
      const doc = await this._init()
        .collection('admins').doc(lineUserId).get();
      return doc.exists;
    } catch (e) {
      return false;
    }
  },

  // ── Config (GPS) ─────────────────────────────────────────
  async getConfig() {
    try {
      const doc = await this._init()
        .collection('config').doc('gps').get();
      if (!doc.exists) return { lat: 0, lng: 0, radius: 0 };
      return doc.data();
    } catch (e) {
      return { lat: 0, lng: 0, radius: 0 };
    }
  },

  async saveConfig(lat, lng, radius, lineUserId) {
    await this._init().collection('config').doc('gps').set({
      lat:       parseFloat(lat),
      lng:       parseFloat(lng),
      radius:    parseFloat(radius),
      updatedBy: lineUserId,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    return { success: true, message: 'บันทึกการตั้งค่าเรียบร้อย' };
  },

  // ── Config (Work Hours) ───────────────────────────────────
  async getHours() {
    try {
      const doc = await this._init()
        .collection('config').doc('hours').get();
      if (!doc.exists) return { checkinStart: '08:00', lateAfter: '09:00', checkoutTime: '18:00' };
      return doc.data();
    } catch (e) {
      return { checkinStart: '08:00', lateAfter: '09:00', checkoutTime: '18:00' };
    }
  },

  async saveHours(checkinStart, lateAfter, checkoutTime, lineUserId) {
    await this._init().collection('config').doc('hours').set({
      checkinStart, lateAfter, checkoutTime,
      updatedBy: lineUserId,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    return { success: true, message: 'บันทึกเวลาทำงานเรียบร้อย' };
  },

  // ── Users (Face Data) ────────────────────────────────────
  async getKnownFaces() {
    const snap = await this._init().collection('users').get();
    return snap.docs.map(doc => ({
      label:      doc.data().name,
      descriptor: doc.data().descriptor
    }));
  },

  async registerUser(name, descriptor, lineUserId) {
    await this._init().collection('users').add({
      name,
      descriptor:   Array.from(descriptor),
      registeredBy: lineUserId,
      createdAt:    firebase.firestore.FieldValue.serverTimestamp()
    });
    return { success: true, message: 'บันทึกข้อมูลหน้าเรียบร้อย' };
  },

  // ── Attendance ───────────────────────────────────────────

  // ตรวจว่าวันนี้เช็คอินไปแล้วหรือยัง
  async getTodayRecord(name) {
    const today = new Date().toLocaleDateString('th-TH');
    // query แค่ name เดียว แล้ว filter date ใน JS (หลีกเลี่ยง composite index)
    const snap  = await this._init().collection('attendance')
      .where('name', '==', name)
      .get();
    if (snap.empty) return null;
    const records = snap.docs.map(d => d.data())
      .filter(r => r.date === today);
    if (!records.length) return null;
    return {
      // record ที่ไม่มี type field ถือเป็น checkin (record เก่า)
      checkin:  records.find(r => !r.type || r.type === 'checkin')  || null,
      checkout: records.find(r => r.type === 'checkout') || null
    };
  },

  async logAttendance(name, lat, lng, lineUserId, type = 'checkin') {
    // ตรวจ GPS
    const config = await this.getConfig();
    if (config.radius > 0 && config.lat && config.lng) {
      const dist = _haversineKm(parseFloat(lat), parseFloat(lng), config.lat, config.lng);
      if (dist > config.radius) {
        return {
          error:      'อยู่นอกพื้นที่ที่กำหนด (' + (dist * 1000).toFixed(0) + ' ม.)',
          outOfRange: true
        };
      }
    }

    // ตรวจซ้ำ — ป้องกันเช็คอิน/เอาท์ซ้ำวันเดียวกัน
    const today = await this.getTodayRecord(name);
    if (type === 'checkin'  && today?.checkin)  return { error: 'เช็คอินวันนี้ไปแล้ว',  duplicate: true };
    if (type === 'checkout' && today?.checkout) return { error: 'เช็คเอาท์วันนี้ไปแล้ว', duplicate: true };
    if (type === 'checkout' && !today?.checkin) return { error: 'ยังไม่ได้เช็คอินวันนี้', duplicate: true };

    const now = new Date();
    await this._init().collection('attendance').add({
      name,
      type,
      lat:        lat ? parseFloat(lat) : null,
      lng:        lng ? parseFloat(lng) : null,
      lineUserId,
      date:       now.toLocaleDateString('th-TH'),
      time:       now.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      mapLink:    (lat && lng) ? `https://www.google.com/maps?q=${lat},${lng}` : '',
      timestamp:  firebase.firestore.FieldValue.serverTimestamp()
    });

    const msg = type === 'checkin' ? 'บันทึกเวลาเข้างานสำเร็จ' : 'บันทึกเวลาออกงานสำเร็จ';
    return { success: true, message: msg };
  },

  // ── Leave ─────────────────────────────────────────────────
  async requestLeave(lineUserId, name, type, startDate, endDate, reason) {
    await this._init().collection('leaves').add({
      lineUserId, name, type, startDate, endDate,
      reason:    reason || '',
      status:    'pending',
      approvedBy: null,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    return { success: true };
  },

  async getMyLeaves(lineUserId) {
    const snap = await this._init().collection('leaves')
      .where('lineUserId', '==', lineUserId)
      .get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
  },

  async getAllLeaves() {
    const snap = await this._init().collection('leaves').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
  },

  async updateLeaveStatus(leaveId, status, approvedBy) {
    await this._init().collection('leaves').doc(leaveId).update({
      status, approvedBy,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    return { success: true };
  }
};

// ── GPS utility (ใช้ร่วมกันทั้งระบบ) ─────────────────────────
function _haversineKm(lat1, lon1, lat2, lon2) {
  const R    = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a    = Math.sin(dLat / 2) ** 2
             + Math.cos(lat1 * Math.PI / 180)
             * Math.cos(lat2 * Math.PI / 180)
             * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
